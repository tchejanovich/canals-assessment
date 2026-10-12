import {
  bigint,
  char,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  PAYMENT_STATUSES,
  PaymentStatus,
} from '../../payments/payment-status.js';
import { orders } from './orders.js';

export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES);

/**
 * Payment attempt for an order. A row is created (status `authorizing`) as soon
 * as stock is reserved and before the provider is called, recording the payment
 * attempt. Each order has at most one payment row and each provider call uses a
 * deterministic, order-scoped idempotency key to prevent duplicate effects.
 * `authorizedAt`, `capturedAt` and `voidedAt` record when the application
 * persisted each payment transition. `authorizationId` and `captureId` are the
 * provider-side ids; `last4` is the last four digits of the card. Monetary
 * values are in minor units.
 */
export const payments = pgTable(
  'payments',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orderId: bigint('order_id', { mode: 'number' })
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    authorizationId: uuid('authorization_id'),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    status: paymentStatus('status')
      .notNull()
      .default(PaymentStatus.Authorizing),
    last4: char('last4', { length: 4 }).notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    captureId: uuid('capture_id'),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('payments_order_id_unique').on(table.orderId),
    index('payments_authorization_id_idx').on(table.authorizationId),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
