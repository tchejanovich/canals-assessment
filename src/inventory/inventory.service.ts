import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import { inventory } from '../db/schema/index.js';
import { InsufficientStockError } from './inventory.errors.js';
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
    const linteItems = [...requests].sort((a, b) => a.productId - b.productId);

    for (const linteItem of linteItems) {
      const updated = await tx
        .update(inventory)
        .set({
          quantity: sql`${inventory.quantity} - ${linteItem.quantity}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventory.warehouseId, warehouseId),
            eq(inventory.productId, linteItem.productId),
            gte(inventory.quantity, linteItem.quantity),
          ),
        )
        .returning({ id: inventory.id });

      if (updated.length !== 1) {
        throw new InsufficientStockError(linteItem.productId);
      }
    }
  }

  /**
   * Compensating restock: returns the quantity a prior `reserve` took, used
   * when an order is cancelled after stock was reserved (e.g. the payment
   * capture fails after the reservation committed). Unconditional — the order
   * that calls it owns the reservation — but it keeps the same sorted order as
   * `reserve` so lock acquisition stays globally consistent.
   */
  async restore(
    tx: DatabaseTransaction,
    warehouseId: number,
    requests: StockRequest[],
  ): Promise<void> {
    const lineItems = [...requests].sort((a, b) => a.productId - b.productId);

    for (const linteItem of lineItems) {
      await tx
        .update(inventory)
        .set({
          quantity: sql`${inventory.quantity} + ${linteItem.quantity}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventory.warehouseId, warehouseId),
            eq(inventory.productId, linteItem.productId),
          ),
        );
    }
  }
}
