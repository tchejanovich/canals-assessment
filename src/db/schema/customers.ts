import { bigint, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** Customer records created or reused when an order is placed. */
export const customers = pgTable(
  'customers',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('customers_email_unique').on(table.email)],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
