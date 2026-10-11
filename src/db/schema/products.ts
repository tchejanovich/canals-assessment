import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Sellable product. `priceAmount` is stored in minor units (e.g. cents) to
 * avoid floating point rounding issues; `currency` is the ISO-4217 code.
 */
export const products = pgTable(
  'products',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    priceAmount: bigint('price_amount', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('products_sku_unique').on(table.sku),
    check('products_price_amount_non_negative', sql`${table.priceAmount} >= 0`),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
