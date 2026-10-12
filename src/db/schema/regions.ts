import {
  bigint,
  char,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { countries } from './countries.js';

/** First-level regions (such as US states), with codes unique per country. */
export const regions = pgTable(
  'regions',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    countryId: bigint('country_id', { mode: 'number' })
      .notNull()
      .references(() => countries.id, { onDelete: 'restrict' }),
    code: char('code', { length: 2 }).notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('regions_country_id_code_unique').on(
      table.countryId,
      table.code,
    ),
    index('regions_country_id_idx').on(table.countryId),
  ],
);

export type Region = typeof regions.$inferSelect;
export type NewRegion = typeof regions.$inferInsert;
