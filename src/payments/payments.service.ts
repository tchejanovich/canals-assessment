import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import { payments } from '../db/schema/index.js';
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

/** Coordinates persisted payment state with the mocked/provider Payments API. */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly api: PaymentsApi,
  ) {}

  /** Authorize and capture a newly placed order's payment. */
  async processOrderPayment(
    input: ProcessOrderPaymentInput,
  ): Promise<OrderPaymentResult> {
    const [payment] = await this.db
      .insert(payments)
      .values({
        orderId: input.orderId,
        status: PaymentStatus.Authorizing,
        last4: cardLast4(input.creditCardNumber),
        amount: input.amount,
      })
      .returning();
    if (!payment) {
      throw new Error(`Payment for order ${input.orderId} could not be created`);
    }

    const authorization = await this.api.authorize({
      idempotencyKey: authorizationIdempotencyKey(input.orderId),
      creditCardNumber: input.creditCardNumber,
      amount: payment.amount,
      description: input.description,
    });
    if (authorization.status === PaymentStatus.Declined) {
      return { status: PaymentStatus.Declined };
    }

    const [authorized] = await this.db
      .update(payments)
      .set({
        status: PaymentStatus.Authorized,
        authorizationId: authorization.authorizationId,
        authorizedAt: new Date(),
        last4: authorization.last4,
      })
      .where(eq(payments.id, payment.id))
      .returning();
    if (!authorized) {
      throw new Error(`Payment ${payment.id} authorization was not persisted`);
    }

    const capture = await this.api.capture({
      idempotencyKey: captureIdempotencyKey(input.orderId),
      authorizationId: authorization.authorizationId,
    });
    if (capture.status !== PaymentStatus.Captured) {
      await this.api.void({
        idempotencyKey: voidIdempotencyKey(input.orderId),
        authorizationId: authorization.authorizationId,
      });
      return { status: PaymentStatus.Failed };
    }

    return {
      status: PaymentStatus.Captured,
      captureId: capture.captureId,
      capturedAt: new Date(),
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

}
