import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Coordinates } from '../common/geo.js';
import { DATABASE, type Database } from '../db/database.module.js';
import { warehouses } from '../db/schema/index.js';
import type { StockRequest } from '../inventory/inventory.types.js';

export interface WarehouseWithDistance {
  id: number;
  latitude: number;
  longitude: number;
}

/** Filters to warehouses with every requested item, then ranks them nearest-first.
 * Separate queries let the PostGIS GiST index serve distance ordering; callers
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
    const ids = await this.findFulfillingWarehouseIds(requests);
    if (ids.length === 0) {
      return [];
    }

    // PostGIS points use (longitude, latitude); GiST-backed `<->` ordering lets
    // LIMIT return nearest warehouses without sorting every candidate.
    const origin = sql`ST_SetSRID(
      ST_MakePoint(${destination.longitude}, ${destination.latitude}),
      4326
    )::geography`;

    const rows = await this.db
      .select({
        id: warehouses.id,
        latitude: warehouses.latitude,
        longitude: warehouses.longitude,
      })
      .from(warehouses)
      .where(and(eq(warehouses.active, true), inArray(warehouses.id, ids)))
      .orderBy(sql`${warehouses.location} <-> ${origin}`)
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    }));
  }

  private async findFulfillingWarehouseIds(
    requests: StockRequest[],
  ): Promise<number[]> {
    const required = sql.join(
      requests.map(
        (request) =>
          sql`(${request.productId}::bigint, ${request.quantity}::int)`,
      ),
      sql`, `,
    );

    const rows = (await this.db.execute(sql`
      SELECT w."id" AS "id"
      FROM "warehouses" w
      INNER JOIN "inventory" i ON i."warehouse_id" = w."id"
      INNER JOIN (VALUES ${required}) AS req("product_id", "quantity")
        ON req."product_id" = i."product_id"
      WHERE w."active" = true AND i."quantity" >= req."quantity"
      GROUP BY w."id"
      HAVING COUNT(*) = ${requests.length}
    `)) as unknown as { id: number | string }[];

    return rows.map((row) => Number(row.id));
  }
}
