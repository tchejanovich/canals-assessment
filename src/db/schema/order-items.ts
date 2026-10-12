import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { orders } from './orders.js';
import { products } from './products.js';

/** Order-time snapshot of product name, SKU, price, quantity, and line total. */
export const orderItems = pgTable(
  'order_items',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orderId: bigint('order_id', { mode: 'number' })
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: bigint('product_id', { mode: 'number' })
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    productName: text('product_name').notNull(),
    sku: text('sku').notNull(),
    unitPriceAmount: bigint('unit_price_amount', { mode: 'bigint' }).notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalAmount: bigint('line_total_amount', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('order_items_order_id_product_id_unique').on(
      table.orderId,
      table.productId,
    ),
    check('order_items_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'order_items_unit_price_amount_non_negative',
      sql`${table.unitPriceAmount} >= 0`,
    ),
    index('order_items_order_id_idx').on(table.orderId),
  ],
);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
