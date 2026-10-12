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
    const payment = await this.claimPayment(input);

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

    if (
      payment.status !== PaymentStatus.Authorized &&
      payment.status !== PaymentStatus.Captured
    ) {
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
      alreadyCaptured: payment.status === PaymentStatus.Captured,
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

  /** Persist voiding atomically with order cancellation and stock restoration. */
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

  private async claimPayment(
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

    return this.claimFromStoredPayment(payment.id, authorization);
  }

  /** Resolve a lost guarded authorization update against the winning row. */
  private async claimFromStoredPayment(
    paymentId: number,
    authorization: { authorizationId: string; last4: string },
  ): Promise<AuthorizationClaim> {
    let [current] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);

    if (!current) {
      throw new Error(`Payment ${paymentId} disappeared after authorization`);
    }

    const claim = this.claimForStoredPayment(current);
    if (claim) return claim;

    if (current.status === PaymentStatus.Authorizing) {
      // If the row is still authorizing, persist the provider response before
      // returning. Capture now resolves its authorization ID from this row.
      const updated = await this.persistAuthorization(paymentId, authorization);
      if (updated?.authorizationId) {
        return { status: PaymentStatus.Authorized };
      }

      [current] = await this.db
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);

      const latestClaim = current && this.claimForStoredPayment(current);
      if (latestClaim) return latestClaim;
    }

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

  private claimForStoredPayment(payment: Payment): AuthorizationClaim | null {
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
