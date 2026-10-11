import {
  bigint,
  char,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * ISO-3166-1 country reference data. Seeded via migration; for now only the
 * United States is present.
 */
export const countries = pgTable(
  'countries',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    code: char('code', { length: 2 }).notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('countries_code_unique').on(table.code)],
);

export type Country = typeof countries.$inferSelect;
export type NewCountry = typeof countries.$inferInsert;
