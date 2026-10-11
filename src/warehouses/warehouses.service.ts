import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { haversineDistanceKm, type Coordinates } from '../common/geo.js';
import { DATABASE, type Database } from '../db/database.module.js';
import type { StockRequest } from '../inventory/inventory.service.js';

export interface WarehouseWithDistance {
  id: number;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

interface CandidateRow {
  id: number;
  latitude: string;
  longitude: string;
}

@Injectable()
export class WarehousesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findNearestWithStock(
    requests: StockRequest[],
    destination: Coordinates,
  ): Promise<WarehouseWithDistance | null> {
    const required = sql.join(
      requests.map(
        (request) => sql`(${request.productId}::bigint, ${request.quantity}::int)`,
      ),
      sql`, `,
    );

    const rows = (await this.db.execute(sql`
      SELECT w."id" AS id, w."latitude" AS latitude, w."longitude" AS longitude
      FROM "warehouses" w
      INNER JOIN "inventory" i ON i."warehouse_id" = w."id"
      INNER JOIN (VALUES ${required}) AS req("product_id", "quantity")
        ON req."product_id" = i."product_id"
      WHERE w."active" = true AND i."quantity" >= req."quantity"
      GROUP BY w."id", w."latitude", w."longitude"
      HAVING COUNT(*) = ${requests.length}
    `)) as unknown as CandidateRow[];

    let nearest: WarehouseWithDistance | null = null;
    for (const row of rows) {
      const candidate: Coordinates = {
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      };
      const distanceKm = haversineDistanceKm(destination, candidate);
      if (nearest === null || distanceKm < nearest.distanceKm) {
        nearest = {
          id: Number(row.id),
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          distanceKm,
        };
      }
    }

    return nearest;
  }
}
