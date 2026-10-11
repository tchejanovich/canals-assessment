import {
  bigint,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { countries } from './countries.js';
import { customers } from './customers.js';
import { regions } from './regions.js';

/**
 * A physical shipping address together with the coordinates produced by the
 * (mocked) geocoding provider. Addresses are deduplicated by a normalised
 * `fingerprint` so the same address is only geocoded once. `countryId` and
 * `regionId` reference the country/region reference tables.
 */
export const addresses = pgTable(
  'addresses',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    customerId: bigint('customer_id', { mode: 'number' }).references(
      () => customers.id,
      { onDelete: 'set null' },
    ),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    regionId: bigint('region_id', { mode: 'number' })
      .notNull()
      .references(() => regions.id, { onDelete: 'restrict' }),
    postalCode: text('postal_code').notNull(),
    countryId: bigint('country_id', { mode: 'number' })
      .notNull()
      .references(() => countries.id, { onDelete: 'restrict' }),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('addresses_fingerprint_unique').on(table.fingerprint),
    index('addresses_coordinates_idx').on(table.latitude, table.longitude),
    index('addresses_country_id_idx').on(table.countryId),
    index('addresses_region_id_idx').on(table.regionId),
  ],
);

export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
