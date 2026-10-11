import {
  bigint,
  char,
  index,
  pgEnum,
  pgTable,
  text,
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
 * Payment attempt for an order. A row is claimed (status `authorizing`) as soon
 * as stock is reserved and before the provider is called, so the flow can be
 * resumed after a crash. Each order has at most one payment row and each
 * provider call uses a deterministic `idempotencyKey`, which is what stops a
 * retried or concurrent replay from charging twice. `authorizationId` and
 * `captureId` are the provider-side ids; `last4` is the last four digits of the
 * card. Monetary values are in minor units.
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
    idempotencyKey: text('idempotency_key').notNull(),
    authorizationId: uuid('authorization_id'),
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
    uniqueIndex('payments_idempotency_key_unique').on(table.idempotencyKey),
    index('payments_authorization_id_idx').on(table.authorizationId),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
