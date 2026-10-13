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
import { CustomersService } from '../customers/customers.service.js';
import type { WarehouseWithDistance } from '../warehouses/warehouses.service.js';
import type {
  CreateOrderAddress,
  CreateOrderItem,
} from './dto/create-order.dto.js';
import type { CustomerInput } from '../customers/customers.types.js';
import { IDEMPOTENCY_CONFLICT } from './orders.idempotency.js';
import { IdempotencyKeyConflict, OrderVanishedError } from './orders.errors.js';
import { OrderFailureReason, OrderState } from './order-state.js';
import type { OrderPlacementResult, PricedLineItem } from './orders.types.js';

export interface PlaceOrderInput {
  customer: CustomerInput;
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
    private readonly customers: CustomersService,
  ) {}

  async placeOrder(input: PlaceOrderInput): Promise<OrderPlacementResult> {
    try {
      const result = await this.db.transaction(async (tx) => {
        const customer = await this.customers.findOrCreate(tx, input.customer);
        const address = await this.addresses.findOrCreate(tx, {
          customerId: customer.id,
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
          customerId: customer.id,
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

        // Persist the reservation race as a terminal failed order.
        const [failed] = await tx
          .update(orders)
          .set({
            state: OrderState.Failed,
            failureReason: OrderFailureReason.StockReservation,
          })
          .where(eq(orders.id, order.id))
          .returning();
        if (!failed) throw new OrderVanishedError(order.id);

        return { order: failed, state: OrderState.Failed };
      });

      return { type: 'placed', ...result };
    } catch (error) {
      if (error instanceof IdempotencyKeyConflict) {
        return { type: IDEMPOTENCY_CONFLICT, error };
      }
      throw error;
    }
  }

  /** Inserts the order and its lines; returns null if the key already exists. */
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

  /** Tries warehouses nearest-first; each savepoint rolls back partial reservations. */
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

    this.logger.warn(
      `Order ${order.id} could not reserve stock at any of ${candidates.length} candidate warehouses`,
    );
    return null;
  }
}
