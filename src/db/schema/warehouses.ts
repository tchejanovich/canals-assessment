import {
  bigint,
  boolean,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { countries } from './countries.js';
import { regions } from './regions.js';

/**
 * A fulfilment location. Orders are always fulfilled from a single warehouse,
 * so coordinates are stored for the nearest-warehouse calculation. The address
 * is an intrinsic, single (1:1) attribute of the facility, so it is embedded
 * here rather than shared with the customer-oriented `addresses` table.
 * `countryId` and `regionId` reference the country/region reference tables.
 */
export const warehouses = pgTable(
  'warehouses',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    name: text('name').notNull(),
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
    latitude: numeric('latitude', { precision: 9, scale: 6 }).notNull(),
    longitude: numeric('longitude', { precision: 9, scale: 6 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('warehouses_coordinates_idx').on(table.latitude, table.longitude),
    index('warehouses_country_id_idx').on(table.countryId),
    index('warehouses_region_id_idx').on(table.regionId),
  ],
);

export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;
