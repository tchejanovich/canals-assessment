import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AddressesService } from '../addresses/addresses.service.js';
import type { Coordinates } from '../common/geo.js';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import { orderItems, type Order, orders } from '../db/schema/index.js';
import { InsufficientStockError } from '../inventory/inventory.errors.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { WarehouseWithDistance } from '../warehouses/warehouses.service.js';
import type {
  CreateOrderAddress,
  CreateOrderItem,
} from './dto/create-order.dto.js';
import { IDEMPOTENCY_CONFLICT } from './orders.idempotency.js';
import { IdempotencyKeyConflict, OrderVanishedError } from './orders.errors.js';
import { OrderState } from './order-state.js';
import type { OrderPlacementResult, PricedLineItem } from './orders.types.js';

export interface PlaceOrderInput {
  customerId: number;
  address: CreateOrderAddress;
  countryId: number;
  regionId: number;
  coordinates: Coordinates;
  candidates: WarehouseWithDistance[];
  items: CreateOrderItem[];
  totalAmount: bigint;
  currency: string;
  idempotencyKey: string | null;
  idempotencyRequestFingerprint: string | null;
  pricedLineItems: PricedLineItem[];
}

@Injectable()
export class OrderPlacementService {
  private readonly logger = new Logger('OrdersService');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly addresses: AddressesService,
    private readonly inventory: InventoryService,
  ) {}

  async placeOrder(input: PlaceOrderInput): Promise<OrderPlacementResult> {
    try {
      const result = await this.db.transaction(async (tx) => {
        const address = await this.addresses.findOrCreate(tx, {
          customerId: input.customerId,
          address: input.address,
          regionId: input.regionId,
          countryId: input.countryId,
          coordinates: input.coordinates,
        });
        const coordinates = {
          latitude: Number(address.latitude),
          longitude: Number(address.longitude),
        };

        const order = await this.insertOrderWithItems(tx, {
          customerId: input.customerId,
          shippingAddressId: address.id,
          address: input.address,
          coordinates,
          totalAmount: input.totalAmount,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          idempotencyRequestFingerprint: input.idempotencyRequestFingerprint,
          pricedLineItems: input.pricedLineItems,
        });
        if (!order) throw new IdempotencyKeyConflict();

        const reserved = await this.tryReserveOrderStock(
          tx,
          order,
          input.candidates,
          input.items,
        );
        if (reserved) {
          return { order: reserved, state: OrderState.Reserved };
        }

        // Every warehouse candidate was exhausted by the race window; retain the order
        // so the caller can report the recorded conflict.
        return { order, state: OrderState.Created };
      });

      return { type: 'placed', ...result };
    } catch (error) {
      if (error instanceof IdempotencyKeyConflict) {
        return { type: IDEMPOTENCY_CONFLICT, error };
      }
      throw error;
    }
  }

  /**
   * Persists the order header and its line items in the caller's transaction.
   * Returns `null` if another request already inserted the idempotency key.
   */
  private async insertOrderWithItems(
    tx: DatabaseTransaction,
    input: {
      customerId: number;
      shippingAddressId: number | null;
      address: CreateOrderAddress;
      coordinates: Coordinates;
      totalAmount: bigint;
      currency: string;
      idempotencyKey: string | null;
      idempotencyRequestFingerprint: string | null;
      pricedLineItems: PricedLineItem[];
    },
  ): Promise<Order | null> {
    const [order] = await tx
      .insert(orders)
      .values({
        customerId: input.customerId,
        warehouseId: null,
        shippingAddressId: input.shippingAddressId,
        totalAmount: input.totalAmount,
        currency: input.currency,
        shippingLine1: input.address.line1,
        shippingLine2: input.address.line2 ?? null,
        shippingCity: input.address.city,
        shippingRegion: input.address.region,
        shippingPostalCode: input.address.postalCode,
        shippingCountry: input.address.country,
        shippingLatitude: input.coordinates.latitude.toFixed(6),
        shippingLongitude: input.coordinates.longitude.toFixed(6),
        idempotencyKey: input.idempotencyKey,
        idempotencyRequestFingerprint: input.idempotencyRequestFingerprint,
        state: OrderState.Created,
      })
      .onConflictDoNothing({ target: orders.idempotencyKey })
      .returning();

    if (!order) return null;

    await tx.insert(orderItems).values(
      input.pricedLineItems.map((line) => ({
        orderId: order.id,
        productId: line.product.id,
        productName: line.product.name,
        sku: line.product.sku,
        unitPriceAmount: line.unitPriceAmount,
        quantity: line.quantity,
        lineTotalAmount: line.lineTotalAmount,
        currency: input.currency,
      })),
    );

    return order;
  }

  /**
   * Tries nearest-first warehouses. A per-candidate savepoint rolls back
   * partial reservations, while a successful stock/order update stays atomic.
   */
  private async tryReserveOrderStock(
    tx: DatabaseTransaction,
    order: Order,
    candidates: WarehouseWithDistance[],
    items: CreateOrderItem[],
  ): Promise<Order | null> {
    for (const warehouse of candidates) {
      try {
        return await tx.transaction(async (inner) => {
          await this.inventory.reserve(inner, warehouse.id, items);

          const [reserved] = await inner
            .update(orders)
            .set({ state: OrderState.Reserved, warehouseId: warehouse.id })
            .where(eq(orders.id, order.id))
            .returning();
          if (!reserved) {
            throw new OrderVanishedError(order.id);
          }

          this.logger.log(
            `Order ${order.id} stock reserved at warehouse ${warehouse.id}`,
          );

          return reserved;
        });
      } catch (error) {
        if (error instanceof InsufficientStockError) {
          this.logger.debug(
            `Order ${order.id}: warehouse ${warehouse.id} drained by a concurrent order, trying next candidate`,
          );
          continue;
        }
        throw error;
      }
    }

    return null;
  }
}
