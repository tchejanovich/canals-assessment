import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { countries } from './countries.js';
import { regions } from './regions.js';

/**
 * PostGIS geography point (WGS84 / SRID 4326). Stored as `geography` rather
 * than `geometry` so distances are computed on the spheroid in metres.
 */
const geographyPoint = customType<{ data: string }>({
  dataType() {
    return 'geography(Point, 4326)';
  },
});

/** A fulfillment location with an embedded address and nearest-search coordinates.
 * `latitude`/`longitude` are writable; Postgres derives the indexed geography
 * column `location` from them. Country and region are reference-table IDs.
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
    location: geographyPoint('location').generatedAlwaysAs(
      sql`ST_SetSRID(ST_MakePoint("longitude"::double precision, "latitude"::double precision), 4326)::geography`,
    ),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('warehouses_location_gist_idx').using('gist', table.location),
    index('warehouses_country_id_idx').on(table.countryId),
    index('warehouses_region_id_idx').on(table.regionId),
  ],
);

export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;
