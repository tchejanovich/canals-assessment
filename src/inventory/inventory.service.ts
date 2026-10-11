import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import { inventory } from '../db/schema/index.js';
import type { StockRequest } from './inventory.types.js';

@Injectable()
export class InventoryService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async reserve(
    tx: DatabaseTransaction,
    warehouseId: number,
    requests: StockRequest[],
  ): Promise<void> {
    // Lock inventory rows in a globally consistent order so concurrent
    // orders sharing products never acquire row locks in opposite order
    // (a classic deadlock even when every single row is stock-sufficient).
    const ordered = [...requests].sort((a, b) => a.productId - b.productId);

    for (const request of ordered) {
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
