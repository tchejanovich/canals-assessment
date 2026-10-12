import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { products } from './products.js';
import { warehouses } from './warehouses.js';

/** On-hand quantity per product and warehouse. Conditional atomic updates prevent
 * overselling; a separate movement ledger can be added if stock history is needed.
 */
export const inventory = pgTable(
  'inventory',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    warehouseId: bigint('warehouse_id', { mode: 'number' })
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
    productId: bigint('product_id', { mode: 'number' })
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('inventory_warehouse_id_product_id_unique').on(
      table.warehouseId,
      table.productId,
    ),
    check('inventory_quantity_non_negative', sql`${table.quantity} >= 0`),
    index('inventory_warehouse_id_idx').on(table.warehouseId),
    index('inventory_product_id_idx').on(table.productId),
  ],
);

export type Inventory = typeof inventory.$inferSelect;
export type NewInventory = typeof inventory.$inferInsert;
