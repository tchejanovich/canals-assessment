import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import { inventory } from '../db/schema/index.js';

export interface StockRequest {
  productId: number;
  quantity: number;
}

@Injectable()
export class InventoryService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async reserve(
    tx: DatabaseTransaction,
    warehouseId: number,
    requests: StockRequest[],
  ): Promise<void> {
    for (const request of requests) {
      const updated = await tx
        .update(inventory)
        .set({
          quantity: sql`${inventory.quantity} - ${request.quantity}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventory.warehouseId, warehouseId),
            eq(inventory.productId, request.productId),
            gte(inventory.quantity, request.quantity),
          ),
        )
        .returning({ id: inventory.id });

      if (updated.length !== 1) {
        throw new ConflictException(
          `Insufficient stock for product ${request.productId}`,
        );
      }
    }
  }
}
