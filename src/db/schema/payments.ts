import {
  bigint,
  char,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.js';

/**
 * Successful payment captured for an order. A payment only exists once its
 * order has been activated, and each order has at most one (the capture is
 * idempotent per order). `externalId` is the merchant-side UUID from the
 * payment provider; `last4` is the last four digits of the charged card.
 * Monetary values are in minor units.
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
    externalId: uuid('external_id').notNull(),
    last4: char('last4', { length: 4 }).notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('payments_order_id_unique').on(table.orderId),
    index('payments_external_id_idx').on(table.externalId),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
