import {
  bigint,
  char,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { addresses } from './addresses.js';
import { customers } from './customers.js';
import { warehouses } from './warehouses.js';

/**
 * Order header. The shipping address is snapshotted onto the order so later
 * edits to `addresses` do not rewrite order history. `warehouseId` is nullable
 * until a warehouse has been selected for the order. Monetary values are in
 * minor units.
 */
export const orders = pgTable(
  'orders',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    customerId: bigint('customer_id', { mode: 'number' })
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    warehouseId: bigint('warehouse_id', { mode: 'number' }).references(
      () => warehouses.id,
      { onDelete: 'restrict' },
    ),
    shippingAddressId: bigint('shipping_address_id', {
      mode: 'number',
    }).references(() => addresses.id, { onDelete: 'restrict' }),
    subtotalAmount: bigint('subtotal_amount', { mode: 'bigint' }).notNull(),
    totalAmount: bigint('total_amount', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    shippingLine1: text('shipping_line1').notNull(),
    shippingLine2: text('shipping_line2'),
    shippingCity: text('shipping_city').notNull(),
    shippingRegion: text('shipping_region'),
    shippingPostalCode: text('shipping_postal_code').notNull(),
    shippingCountry: text('shipping_country').notNull(),
    shippingLatitude: numeric('shipping_latitude', {
      precision: 9,
      scale: 6,
    }).notNull(),
    shippingLongitude: numeric('shipping_longitude', {
      precision: 9,
      scale: 6,
    }).notNull(),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('orders_customer_id_idx').on(table.customerId),
    index('orders_created_at_idx').on(table.createdAt),
    uniqueIndex('orders_idempotency_key_unique').on(table.idempotencyKey),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
