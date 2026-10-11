import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AddressesService } from '../addresses/addresses.service.js';
import type { Coordinates } from '../common/geo.js';
import { CustomersService } from '../customers/customers.service.js';
import {
  DATABASE,
  type Database,
  type DatabaseTransaction,
} from '../db/database.module.js';
import {
  orderItems,
  type Order,
  orders,
  payments,
  type Product,
} from '../db/schema/index.js';
import { GeocodingService } from '../geocoding/geocoding.service.js';
import { InsufficientStockError } from '../inventory/inventory.errors.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { ProductsService } from '../products/products.service.js';
import {
  WarehousesService,
  type WarehouseWithDistance,
} from '../warehouses/warehouses.service.js';
import type {
  CreateOrderAddress,
  CreateOrderDto,
  CreateOrderItem,
} from './dto/create-order.dto.js';
import type {
  OrderItemResponse,
  OrderResponse,
} from './dto/order-response.dto.js';
import {
  CustomerNotFoundError,
  NoFulfillingWarehouseError,
  OrderPaymentDeclinedError,
  OrderVanishedError,
  PaymentDeclinedError,
  ProductNotFoundError,
  ProductUnavailableError,
  UnfulfilledOrderError,
} from './orders.errors.js';
import {
  assertReplayMatchesPayload,
  computeIdempotencyRequestFingerprint,
  isUniqueViolation,
} from './orders.idempotency.js';
import {
  toCreatedOrderResult,
  toOrderItem,
  toOrderResponse,
} from './orders.mapper.js';
import {
  buildPricedLineItems,
  calculateSubtotal,
  validateAndResolveCurrency,
} from './orders.pricing.js';
import { OrderState } from './order-state.js';
import type { PricedLineItem } from './orders.types.js';

/**
 * How many nearest-first warehouses are tried before giving up. Candidates
 * are ordered by distance; stock is re-checked under lock at reservation
 * time, so a concurrent order can drain a warehouse between candidate
 * selection and reservation, in which case the next-nearest candidate is
 * attempted.
 */
const WAREHOUSE_FALLBACK_ATTEMPTS = 5;

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
    private readonly products: ProductsService,
    private readonly geocoding: GeocodingService,
    private readonly warehouses: WarehousesService,
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
  ) {}

  async createOrder(
    dto: CreateOrderDto,
    idempotencyKey?: string,
  ): Promise<{ order: OrderResponse; created: boolean }> {
    const replayed = idempotencyKey
      ? await this.resolveIdempotentReplay(idempotencyKey, dto)
      : null;
    if (replayed) {
      return { order: replayed, created: false };
    }

    const customer = await this.customers.findById(dto.customerId);
    if (!customer) {
      throw new CustomerNotFoundError(dto.customerId);
    }

    const productById = await this.resolveProductMap(dto);

    const pricedLineItems = buildPricedLineItems(dto, productById);
    const subtotalAmount = calculateSubtotal(pricedLineItems);

    const currency = validateAndResolveCurrency(pricedLineItems);

    const countryId = await this.addresses.resolveCountry(dto.address.country);
    const regionId = await this.addresses.resolveRegion(
      countryId,
      dto.address.region,
    );

    const coordinates = await this.geocoding.getCoordinates(dto.address);

    const candidates = await this.warehouses.findFulfillingWarehouses(
      dto.items,
      coordinates,
      WAREHOUSE_FALLBACK_ATTEMPTS,
    );
    if (candidates.length === 0) {
      throw new NoFulfillingWarehouseError();
    }

    const totalAmount = subtotalAmount;
    const requestFingerprint = idempotencyKey
      ? computeIdempotencyRequestFingerprint(dto)
      : null;

    let outcome: { order: Order; state: OrderState };
    try {
      outcome = await this.db.transaction(async (tx) => {
        const address = await this.addresses.findOrCreate(tx, {
          customerId: dto.customerId,
          address: dto.address,
          regionId,
          countryId,
          coordinates,
        });

        const order = await this.insertOrderWithItems(tx, {
          customerId: dto.customerId,
          shippingAddressId: address.id,
          address: dto.address,
          coordinates,
          subtotalAmount,
          totalAmount,
          currency,
          idempotencyKey: idempotencyKey ?? null,
          idempotencyRequestFingerprint: requestFingerprint,
          pricedLineItems,
        });

        const reserved = await this.tryReserveOrder(
          tx,
          order,
          candidates,
          dto.items,
        );
        if (reserved) {
          return { order: reserved, state: OrderState.Reserved };
        }

        // Every candidate was exhausted by the race window: keep the order
        // (and the deduplicated address) and let the caller report the 409.
        return { order, state: OrderState.Created };
      });
    } catch (error) {
      if (
        idempotencyKey &&
        isUniqueViolation(error, 'orders_idempotency_key_unique')
      ) {
        // Two requests raced with the same new key; the loser attached to the
        // committed winner instead of creating a duplicate order.
        const replayed = await this.resolveIdempotentReplay(
          idempotencyKey,
          dto,
        );
        if (replayed) {
          return { order: replayed, created: false };
        }
      }
      throw error;
    }

    if (outcome.state === OrderState.Created) {
      throw new UnfulfilledOrderError(outcome.order.id);
    }

    const finalized = await this.finalizeReservedOrder(outcome.order, dto);
    return toCreatedOrderResult(finalized, pricedLineItems);
  }

  /**
   * Persists the order header (in state `created`, before any stock is
   * reserved) together with its line items, both inside the caller's
   * transaction so they commit atomically. Returns the inserted header.
   */
  private async insertOrderWithItems(
    tx: DatabaseTransaction,
    input: {
      customerId: number;
      shippingAddressId: number | null;
      address: CreateOrderAddress;
      coordinates: Coordinates;
      subtotalAmount: bigint;
      totalAmount: bigint;
      currency: string;
      idempotencyKey: string | null;
      idempotencyRequestFingerprint: string | null;
      pricedLineItems: PricedLineItem[];
    },
  ): Promise<Order> {
    const [order] = await tx
      .insert(orders)
      .values({
        customerId: input.customerId,
        warehouseId: null,
        shippingAddressId: input.shippingAddressId,
        subtotalAmount: input.subtotalAmount,
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
      .returning();

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
   * Walks the nearest-first warehouse candidates and reserves stock at the
   * first one that still has every line, flipping the order to `reserved` and
   * assigning that warehouse in the same outer transaction. Each attempt runs
   * in a nested transaction (a savepoint): `reserve` decrements line by line,
   * so a mid-list `InsufficientStockError` must roll back that warehouse's
   * partial decrements without aborting the order insert. Returns `null` when
   * every candidate was exhausted, leaving the order in `created`.
   */
  private async tryReserveOrder(
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

          return reserved;
        });
      } catch (error) {
        if (error instanceof InsufficientStockError) {
          continue;
        }
        throw error;
      }
    }

    return null;
  }

  private async resolveProductMap(
    dto: CreateOrderDto,
  ): Promise<Map<number, Product>> {
    const productRows = await this.products.findByIds(
      dto.items.map((item) => item.productId),
    );
    const productById = new Map(
      productRows.map((product) => [product.id, product]),
    );

    for (const item of dto.items) {
      const product = productById.get(item.productId);
      if (!product) {
        throw new ProductNotFoundError(item.productId);
      }
      if (!product.active) {
        throw new ProductUnavailableError(item.productId);
      }
    }

    return productById;
  }

  private async findIdempotentOrder(key: string): Promise<{
    order: Order;
    items: OrderItemResponse[];
    requestFingerprint: string | null;
  } | null> {
    const rows = await this.db
      .select({ order: orders, item: orderItems })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(eq(orders.idempotencyKey, key));

    if (rows.length === 0) {
      return null;
    }

    const { order } = rows[0];
    return {
      order,
      requestFingerprint: order.idempotencyRequestFingerprint,
      items: rows.map((row) => toOrderItem(row.item)),
    };
  }

  /**
   * Resolves what an idempotency-key replay should answer, or `null` when the
   * key has never been seen and a new order should be created:
   *
   * - no stored order             -> `null`
   * - stored order is `active`    -> the stored order (no duplicate created)
   * - stored order is `reserved`  -> the original request committed the stock
   *                                  reservation but never finished the (slow)
   *                                  payment capture, or crashed doing so. The
   *                                  replay RESUMES it: the capture is
   *                                  idempotent per order, so re-running it is
   *                                  safe, and the order is then finalized.
   * - stored order is `cancelled` -> the original capture was declined and the
   *                                  key stays bound to that failed outcome.
   * - stored order is `created`   -> a recorded race loss; throws the recorded
   *                                  conflict, key stays bound.
   *
   * A replay whose payload differs from the stored request is always a conflict
   * — the stored order is never silently returned for a request it does not
   * match.
   */
  private async resolveIdempotentReplay(
    idempotencyKey: string,
    dto: CreateOrderDto,
  ): Promise<OrderResponse | null> {
    const existing = await this.findIdempotentOrder(idempotencyKey);
    if (!existing) {
      return null;
    }

    assertReplayMatchesPayload(
      existing.requestFingerprint,
      dto,
      idempotencyKey,
    );

    switch (existing.order.state) {
      case OrderState.Active:
        return toOrderResponse(existing.order, existing.items);
      case OrderState.Reserved: {
        const finalized = await this.finalizeReservedOrder(existing.order, dto);
        return toOrderResponse(finalized, existing.items);
      }
      case OrderState.Cancelled:
        throw new OrderPaymentDeclinedError(existing.order.id);
      default:
        throw new UnfulfilledOrderError(existing.order.id);
    }
  }

  /**
   * Captures the payment for an order whose stock is already reserved, then
   * finalizes it. RUNS OUTSIDE ANY TRANSACTION on purpose: the reservation
   * committed before the (potentially slow) payment call so inventory row
   * locks are never held across it. On approval the order is flipped to
   * `active` in a tiny guarded transaction; on decline/failure the order is
   * cancelled and the reserved stock returned, atomically and idempotently.
   */
  private async finalizeReservedOrder(
    reservedOrder: Order,
    dto: CreateOrderDto,
  ): Promise<Order> {
    const payment = await this.payments.charge({
      creditCardNumber: dto.creditCardNumber,
      amount: reservedOrder.totalAmount,
      description: `Order ${reservedOrder.id} for customer ${reservedOrder.customerId}`,
    });
    if (!payment.approved) {
      await this.cancelOrderAndRestoreStock(
        reservedOrder.id,
        reservedOrder.warehouseId!,
        dto.items,
      );
      throw new PaymentDeclinedError();
    }

    const activated = await this.activateOrder(reservedOrder.id, {
      externalId: payment.externalId,
      last4: payment.last4,
      amount: reservedOrder.totalAmount,
    });
    if (activated) {
      return activated;
    }

    // Another flow already finalized this order (e.g. a concurrent replay);
    // read the committed state so we report it accurately.
    const [current] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, reservedOrder.id))
      .limit(1);
    return current ?? reservedOrder;
  }

  /**
   * Flips a `reserved` order to `active` in its own tiny transaction and, in
   * the same atomic step, records the successful payment. Guarded on the
   * current state so a concurrent finalizer cannot double-activate or store a
   * duplicate payment: if the order already moved on, no row matches and
   * `null` is returned.
   */
  private async activateOrder(
    orderId: number,
    payment: { externalId: string; last4: string; amount: bigint },
  ): Promise<Order | null> {
    const activated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(orders)
        .set({ state: OrderState.Active })
        .where(
          and(eq(orders.id, orderId), eq(orders.state, OrderState.Reserved)),
        )
        .returning();

      if (row) {
        await tx.insert(payments).values({
          orderId,
          externalId: payment.externalId,
          last4: payment.last4,
          amount: payment.amount,
        });
      }

      return row ?? null;
    });

    return activated;
  }

  /**
   * Compensation for a failed payment capture: flips the order from `reserved`
   * to `cancelled` and returns the reserved stock to inventory, in one
   * transaction. The guard on `state = 'reserved'` makes it idempotent — if a
   * second caller runs it after the flip, it matches zero rows and restores
   * nothing (no double restock).
   */
  private async cancelOrderAndRestoreStock(
    orderId: number,
    warehouseId: number,
    items: CreateOrderItem[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [cancelled] = await tx
        .update(orders)
        .set({ state: OrderState.Cancelled })
        .where(
          and(eq(orders.id, orderId), eq(orders.state, OrderState.Reserved)),
        )
        .returning({ id: orders.id });

      if (cancelled) {
        await this.inventory.restore(tx, warehouseId, items);
      }
    });
  }
}
