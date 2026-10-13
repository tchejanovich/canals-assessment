import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import { payments, type Payment } from '../db/schema/index.js';
import { cardLast4 } from './card.js';
import {
  authorizationIdempotencyKey,
  captureIdempotencyKey,
  voidIdempotencyKey,
} from './payments.idempotency.js';
import { PaymentStatus } from './payment-status.js';
import { PaymentsApi } from './payments.api.js';
import type {
  ProcessOrderPaymentInput,
  OrderPaymentResult,
} from './payments.types.js';

type AuthorizationClaim =
  | { status: typeof PaymentStatus.Authorized }
  | {
      status: typeof PaymentStatus.Captured;
      captureId: string;
      capturedAt: Date | null;
    }
  | { status: typeof PaymentStatus.Declined }
  | { status: typeof PaymentStatus.Voided };

/** Coordinates persisted payment state with the mocked/provider Payments API. */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly api: PaymentsApi,
  ) {}

  /** Run or resume authorization and capture for an order payment. */
  async processOrderPayment(
    input: ProcessOrderPaymentInput,
  ): Promise<OrderPaymentResult> {
    const payment = await this.getOrCreatePayment(input);

    if (payment.status === PaymentStatus.Captured && payment.captureId) {
      return {
        status: PaymentStatus.Captured,
        captureId: payment.captureId,
        capturedAt: payment.capturedAt,
        alreadyCaptured: true,
      };
    }

    if (payment.status === PaymentStatus.Voided) {
      return { status: PaymentStatus.Voided };
    }

    const authorization = await this.ensureAuthorized(payment, input);
    switch (authorization.status) {
      case PaymentStatus.Captured:
        return {
          ...authorization,
          alreadyCaptured: true,
        };
      case PaymentStatus.Voided:
      case PaymentStatus.Declined:
        return authorization;
      case PaymentStatus.Authorized:
        return this.captureAuthorizedPayment(input.orderId);
    }
  }

  /** Resolve the authorization from the payment row before capturing. */
  private async captureAuthorizedPayment(
    orderId: number,
  ): Promise<OrderPaymentResult> {
    const [payment] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .limit(1);

    if (!payment?.authorizationId) {
      return { status: PaymentStatus.Failed };
    }

    if (payment.status === PaymentStatus.Captured && payment.captureId) {
      return {
        status: PaymentStatus.Captured,
        captureId: payment.captureId,
        capturedAt: payment.capturedAt,
        alreadyCaptured: true,
      };
    }

    if (payment.status !== PaymentStatus.Authorized) {
      return { status: PaymentStatus.Failed };
    }

    const capture = await this.api.capture({
      idempotencyKey: captureIdempotencyKey(orderId),
      authorizationId: payment.authorizationId,
    });
    if (capture.status !== PaymentStatus.Captured) {
      await this.api.void({
        idempotencyKey: voidIdempotencyKey(orderId),
        authorizationId: payment.authorizationId,
      });
      return { status: PaymentStatus.Failed };
    }

    return {
      status: PaymentStatus.Captured,
      captureId: capture.captureId,
      capturedAt: payment.capturedAt ?? new Date(),
      alreadyCaptured: false,
    };
  }

  /** Persist capture atomically with the order's transition to active. */
  async markCaptured(
    tx: DatabaseTransaction,
    orderId: number,
    capture: { captureId: string; capturedAt: Date },
  ): Promise<void> {
    await tx
      .update(payments)
      .set({
        status: PaymentStatus.Captured,
        captureId: capture.captureId,
        capturedAt: capture.capturedAt,
      })
      .where(eq(payments.orderId, orderId));
  }

  /** Persist voiding atomically with order failure and stock restoration. */
  async markVoided(tx: DatabaseTransaction, orderId: number): Promise<void> {
    await tx
      .update(payments)
      .set({ status: PaymentStatus.Voided, voidedAt: new Date() })
      .where(
        and(
          eq(payments.orderId, orderId),
          ne(payments.status, PaymentStatus.Captured),
        ),
      );
  }

  private async getOrCreatePayment(
    input: ProcessOrderPaymentInput,
  ): Promise<Payment> {
    await this.db
      .insert(payments)
      .values({
        orderId: input.orderId,
        status: PaymentStatus.Authorizing,
        last4: cardLast4(input.creditCardNumber),
        amount: input.amount,
      })
      .onConflictDoNothing({ target: payments.orderId });

    const [payment] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, input.orderId))
      .limit(1);
    if (!payment) {
      throw new Error(`Payment for order ${input.orderId} disappeared`);
    }

    return payment;
  }

  private async ensureAuthorized(
    payment: Payment,
    input: ProcessOrderPaymentInput,
  ): Promise<AuthorizationClaim> {
    if (
      payment.status === PaymentStatus.Authorized &&
      payment.authorizationId
    ) {
      return {
        status: PaymentStatus.Authorized,
      };
    }

    const authorization = await this.api.authorize({
      idempotencyKey: authorizationIdempotencyKey(payment.orderId),
      creditCardNumber: input.creditCardNumber,
      amount: payment.amount,
      description: input.description,
    });
    if (authorization.status === PaymentStatus.Declined) {
      return { status: PaymentStatus.Declined };
    }

    const updated = await this.persistAuthorization(payment.id, authorization);

    if (updated?.authorizationId) {
      return { status: PaymentStatus.Authorized };
    }

    // Another attempt changed the row; reconcile its persisted state.
    return this.reconcileAuthorizationFromStoredPayment(
      payment.id,
      authorization,
    );
  }

  /** Reconcile a lost authorization update with the stored payment row. */
  private async reconcileAuthorizationFromStoredPayment(
    paymentId: number,
    authorization: { authorizationId: string; last4: string },
  ): Promise<AuthorizationClaim> {
    let [current] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);

    // No row remains to reconcile.
    if (!current) {
      throw new Error(`Payment ${paymentId} disappeared after authorization`);
    }

    // Another attempt may have already advanced the payment.
    const claim = this.authorizationClaimFromPayment(current);
    if (claim) return claim;

    // If still authorizing, persist this response before capture.
    if (current.status === PaymentStatus.Authorizing) {
      const updated = await this.persistAuthorization(paymentId, authorization);
      // This attempt persisted the authorization.
      if (updated?.authorizationId) {
        return { status: PaymentStatus.Authorized };
      }

      [current] = await this.db
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);

      // Another request may have changed the row; use its latest state.
      const latestClaim =
        current && this.authorizationClaimFromPayment(current);
      if (latestClaim) return latestClaim;
    }

    // Capture only after the authorization ID is stored.
    throw new Error(
      `Payment ${paymentId} authorization could not be persisted before capture`,
    );
  }

  private async persistAuthorization(
    paymentId: number,
    authorization: { authorizationId: string; last4: string },
  ): Promise<Payment | undefined> {
    const [updated] = await this.db
      .update(payments)
      .set({
        status: PaymentStatus.Authorized,
        authorizationId: authorization.authorizationId,
        authorizedAt: new Date(),
        last4: authorization.last4,
      })
      .where(
        and(
          eq(payments.id, paymentId),
          eq(payments.status, PaymentStatus.Authorizing),
        ),
      )
      .returning();

    return updated;
  }

  private authorizationClaimFromPayment(
    payment: Payment,
  ): AuthorizationClaim | null {
    if (payment.status === PaymentStatus.Captured && payment.captureId) {
      return {
        status: PaymentStatus.Captured,
        captureId: payment.captureId,
        capturedAt: payment.capturedAt,
      };
    }

    if (
      payment.status === PaymentStatus.Authorized &&
      payment.authorizationId
    ) {
      return { status: PaymentStatus.Authorized };
    }

    if (payment.status === PaymentStatus.Voided) {
      return { status: PaymentStatus.Voided };
    }

    return null;
  }
}
