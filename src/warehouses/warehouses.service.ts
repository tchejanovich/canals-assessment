import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Coordinates } from '../common/geo.js';
import { DATABASE, type Database } from '../db/database.module.js';
import type { StockRequest } from '../inventory/inventory.types.js';

export interface WarehouseWithDistance {
  id: number;
  latitude: number;
  longitude: number;
}

/** Filters and ranks fulfilling warehouses in one PostGIS-backed query; callers
 * try the next candidate if a reservation loses a stock race.
 */
@Injectable()
export class WarehousesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findFulfillingWarehouses(
    requests: StockRequest[],
    destination: Coordinates,
    limit: number,
  ): Promise<WarehouseWithDistance[]> {
    if (requests.length === 0) return [];

    const required = sql.join(
      requests.map(
        (request) =>
          sql`(${request.productId}::bigint, ${request.quantity}::int)`,
      ),
      sql`, `,
    );

    // PostGIS points use (longitude, latitude); GiST-backed `<->` ordering lets
    // LIMIT return nearest fulfilling warehouses without sorting every candidate.
    const origin = sql`ST_SetSRID(
      ST_MakePoint(${destination.longitude}, ${destination.latitude}),
      4326
    )::geography`;

    const rows = (await this.db.execute(sql`
      SELECT
        w."id" AS "id",
        w."latitude" AS "latitude",
        w."longitude" AS "longitude"
      FROM "warehouses" w
      WHERE w."active" = true
        AND NOT EXISTS (
          SELECT 1
          FROM (VALUES ${required}) AS req("product_id", "quantity")
          WHERE NOT EXISTS (
            SELECT 1
            FROM "inventory" i
            WHERE i."warehouse_id" = w."id"
              AND i."product_id" = req."product_id"
              AND i."quantity" >= req."quantity"
          )
        )
      ORDER BY w."location" <-> ${origin}
      LIMIT ${limit}
    `)) as unknown as {
      id: number | string;
      latitude: number | string;
      longitude: number | string;
    }[];

    return rows.map((row) => ({
      id: Number(row.id),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    }));
  }
}
