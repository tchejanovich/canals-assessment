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

/** One payment per order. Timestamps record state changes; provider IDs and
 * `last4` support reconciliation and display. Amounts are in minor units.
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
