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

/**
 * A warehouse ranks as a candidate only if it can fulfil *every* requested
 * item, so candidates are narrowed to warehouses carrying all requested stock
 * before being ranked by distance. Ranking happens in two steps because the
 * PostGIS nearest-neighbour (`<->`) index cannot drive an aggregation: the
 * stock filter (GROUP BY / HAVING) runs first, then the surviving set is
 * ordered by spheroid distance in a separate query. The returned list is
 * ordered nearest-first; callers walk it to fall back when a reservation
 * loses a race for stock.
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

    // The shipping address as a PostGIS geography point (SRID 4326 = WGS84,
    // x/y = longitude/latitude). The `<->` operator in the ORDER BY below is
    // served by the `warehouses_location_gist_idx` GiST index: GiST stores a
    // bounding box per index node, so ordering by `<-> origin` walks the tree
    // nearest-first, discarding whole branches that are already farther than
    // the best match found, instead of measuring every warehouse. This is what
    // lets `LIMIT` stop early rather than scan-and-sort all candidates.
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