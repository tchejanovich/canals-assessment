import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
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
  type Payment,
  payments,
  type Product,
} from '../db/schema/index.js';
import { GeocodingService } from '../geocoding/geocoding.service.js';
import { InsufficientStockError } from '../inventory/inventory.errors.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { cardLast4 } from '../payments/card.js';
import { PaymentStatus } from '../payments/payment-status.js';
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
  PaymentCaptureFailedError,
  PaymentDeclinedError,
  ProductNotFoundError,
  ProductUnavailableError,
  ReservedOrderMissingWarehouseError,
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

/**
 * Deterministic provider idempotency keys. Deriving them from the order id (and
 * the operation) means a replay of an order reuses the exact same keys, so the
 * provider can collapse a retried authorize/capture/void into the response of
 * the original call instead of moving money twice.
 */
const authorizationKey = (orderId: number): string =>
  `order:${orderId}:authorize`;
const captureKey = (orderId: number): string => `order:${orderId}:capture`;
const voidKey = (orderId: number): string => `order:${orderId}:void`;

/**
 * Outcome of claiming the provider authorization for a payment row. `declined`
 * is the only case that should cancel; `captured` means a concurrent finalizer
 * already moved the funds and this caller must only activate.
 */
type AuthorizationClaim =
  | { status: 'authorized'; authorizationId: string }
  | { status: 'captured'; captureId: string; capturedAt: Date | null }
  | { status: 'declined' };

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

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
      this.logger.warn(
        `No single warehouse can fulfil customer ${dto.customerId}'s ${dto.items.length} item(s)`,
      );
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
          this.logger.log(
            `Idempotency key ${idempotencyKey} raced; attached to existing order ${replayed.id}`,
          );
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
   * - stored order is `reserved`  -> the original request reserved the stock
   *                                  but never finished the payment, or
   *                                  crashed doing so. The replay RESUMES it
   *                                  from the recorded payment status; the
   *                                  provider calls are keyed by the order, so
   *                                  re-running them cannot charge twice.
   * - stored order is `cancelled` -> the payment was declined or its capture
   *                                  failed and the key stays bound to that
   *                                  failed outcome.
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

    this.logger.log(
      `Idempotency key ${idempotencyKey} replay -> order ${existing.order.id} (state ${existing.order.state})`,
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
   * Takes a reserved order through the payment lifecycle: authorize a hold,
   * capture it, then flip the order to `active`. RUNS OUTSIDE ANY TRANSACTION
   * on purpose so inventory row locks are never held across the (potentially
   * slow) provider calls.
   *
   * The flow is resumable. A payment row is claimed up front (status
   * `authorizing`) and each provider call is keyed by the order id, so a replay
   * after a crash resumes from wherever the recorded status says the last
   * attempt stopped:
   *
   * - `authorizing`  -> (re)authorize; the key returns the original hold.
   * - `authorized`   -> capture.
   * - `captured`     -> capture already moved the funds; just activate.
   * - `voided`       -> the attempt failed; cancel and report the decline.
   *
   * On decline or capture failure the authorization is released, the order is
   * cancelled and the reserved stock is returned, atomically and idempotently.
   */
  private async finalizeReservedOrder(
    reservedOrder: Order,
    dto: CreateOrderDto,
  ): Promise<Order> {
    const orderId = reservedOrder.id;
    const warehouseId = reservedOrder.warehouseId;
    if (warehouseId === null) {
      throw new ReservedOrderMissingWarehouseError(orderId);
    }

    const payment = await this.claimPayment(
      reservedOrder,
      dto.creditCardNumber,
    );

    switch (payment.status) {
      case PaymentStatus.Captured:
        // A previous attempt captured the funds but died before activating the
        // order; finish the activation without touching the provider again.
        this.logger.log(
          `Order ${orderId} payment already captured (capture ${payment.captureId}); activating`,
        );
        return this.finishActivation(orderId, reservedOrder, {
          captureId: payment.captureId!,
          capturedAt: payment.capturedAt ?? new Date(),
        });

      case PaymentStatus.Voided:
        // A previous attempt already released the hold; make sure the order is
        // cancelled and the stock returned, then report the failure.
        this.logger.warn(
          `Order ${orderId} payment is voided; cancelling and restoring stock`,
        );
        await this.cancelOrderAndRestoreStock(orderId, warehouseId, dto.items);
        throw new OrderPaymentDeclinedError(orderId);

      default:
        break;
    }

    const claim = await this.ensureAuthorized(payment, dto);
    if (claim.status === 'captured') {
      this.logger.log(
        `Order ${orderId} payment captured by a concurrent finalizer (capture ${claim.captureId}); activating`,
      );
      return this.finishActivation(orderId, reservedOrder, {
        captureId: claim.captureId,
        capturedAt: claim.capturedAt ?? new Date(),
      });
    }
    if (claim.status === 'declined') {
      this.logger.warn(
        `Order ${orderId} payment declined; cancelling and restoring stock`,
      );
      await this.cancelOrderAndRestoreStock(orderId, warehouseId, dto.items);
      throw new PaymentDeclinedError();
    }

    const capture = await this.payments.capture({
      idempotencyKey: captureKey(orderId),
      authorizationId: claim.authorizationId,
      amount: reservedOrder.totalAmount,
    });
    if (capture.status !== 'captured') {
      this.logger.error(
        `Order ${orderId} payment capture failed; voiding authorization ${claim.authorizationId} and cancelling`,
      );
      await this.payments.void({
        idempotencyKey: voidKey(orderId),
        authorizationId: claim.authorizationId,
      });
      await this.cancelOrderAndRestoreStock(orderId, warehouseId, dto.items);
      throw new PaymentCaptureFailedError(orderId);
    }

    this.logger.log(
      `Order ${orderId} payment captured (authorization ${claim.authorizationId}, capture ${capture.captureId})`,
    );

    return this.finishActivation(orderId, reservedOrder, {
      captureId: capture.captureId,
      capturedAt: new Date(),
    });
  }

  /**
   * Claims the single payment row for an order, inserting it in `authorizing`
   * status on first attempt. `ON CONFLICT (order_id) DO NOTHING` makes a
   * concurrent replay a no-op, so both callers then observe (and resume) the
   * same row rather than racing to create two.
   */
  private async claimPayment(
    order: Order,
    creditCardNumber: string,
  ): Promise<Payment> {
    await this.db
      .insert(payments)
      .values({
        orderId: order.id,
        idempotencyKey: authorizationKey(order.id),
        status: PaymentStatus.Authorizing,
        last4: cardLast4(creditCardNumber),
        amount: order.totalAmount,
      })
      .onConflictDoNothing({ target: payments.orderId });

    const [payment] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .limit(1);
    if (!payment) {
      throw new OrderVanishedError(order.id);
    }

    return payment;
  }

  /**
   * Ensures the payment has an authorization. A payment already in `authorized`
   * state reuses the recorded id (no provider call); otherwise `authorize` is
   * invoked with the order-scoped key. The status write is conditional on
   * `authorizing`, so a concurrent finalizer that already moved the row to
   * `captured` or `voided` is not overwritten. A lost update re-reads the row
   * and returns that outcome instead. If the process crashed after the provider
   * created the hold but before it was recorded, the retried call returns the
   * same authorization via that key.
   */
  private async ensureAuthorized(
    payment: Payment,
    dto: CreateOrderDto,
  ): Promise<AuthorizationClaim> {
    if (
      payment.status === PaymentStatus.Authorized &&
      payment.authorizationId
    ) {
      return {
        status: 'authorized',
        authorizationId: payment.authorizationId,
      };
    }

    const authorization = await this.payments.authorize({
      idempotencyKey: payment.idempotencyKey,
      creditCardNumber: dto.creditCardNumber,
      amount: payment.amount,
      description: `Order ${payment.orderId} for customer ${dto.customerId}`,
    });
    if (authorization.status === 'declined') {
      return { status: 'declined' };
    }

    const [updated] = await this.db
      .update(payments)
      .set({
        status: PaymentStatus.Authorized,
        authorizationId: authorization.authorizationId,
        last4: authorization.last4,
      })
      .where(
        and(
          eq(payments.id, payment.id),
          eq(payments.status, PaymentStatus.Authorizing),
        ),
      )
      .returning();

    if (updated?.authorizationId) {
      return { status: 'authorized', authorizationId: updated.authorizationId };
    }

    return this.claimFromStoredPayment(
      payment.id,
      authorization.authorizationId,
    );
  }

  /**
   * Reads the payment after a lost `authorizing` -> `authorized` update and
   * reports the status the winning finalizer left behind.
   */
  private async claimFromStoredPayment(
    paymentId: number,
    authorizationId: string,
  ): Promise<AuthorizationClaim> {
    const [current] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);

    if (current?.status === PaymentStatus.Captured && current.captureId) {
      return {
        status: 'captured',
        captureId: current.captureId,
        capturedAt: current.capturedAt,
      };
    }

    if (
      current?.status === PaymentStatus.Authorized &&
      current.authorizationId
    ) {
      return {
        status: 'authorized',
        authorizationId: current.authorizationId,
      };
    }

    if (current?.status === PaymentStatus.Voided) {
      return { status: 'declined' };
    }

    // Still `authorizing`: the other update has not committed. Capture with
    // the provider id from this call; the guarded write above will not run
    // again, so a later `captured` status cannot be clobbered.
    return { status: 'authorized', authorizationId };
  }

  /**
   * Flips a `reserved` order to `active` and records the captured payment in
   * one transaction, guarded on the current state so a concurrent finalizer
   * cannot double-activate. Falls back to the committed row (or, failing that,
   * the in-memory order) when another flow already activated it.
   */
  private async finishActivation(
    orderId: number,
    reservedOrder: Order,
    capture: { captureId: string; capturedAt: Date },
  ): Promise<Order> {
    const activated = await this.activateOrder(orderId, capture);
    if (activated) {
      return activated;
    }

    return (await this.reloadOrder(orderId)) ?? reservedOrder;
  }

  /**
   * Flips a `reserved` order to `active` in its own tiny transaction and, in
   * the same atomic step, marks the payment `captured`. Guarded on the current
   * state so a concurrent finalizer cannot double-activate or store a duplicate
   * capture: if the order already moved on, no row matches and `null` is
   * returned.
   */
  private async activateOrder(
    orderId: number,
    capture: { captureId: string; capturedAt: Date },
  ): Promise<Order | null> {
    return this.db.transaction(async (tx) => {
      const [activated] = await tx
        .update(orders)
        .set({ state: OrderState.Active })
        .where(
          and(eq(orders.id, orderId), eq(orders.state, OrderState.Reserved)),
        )
        .returning();

      if (!activated) {
        return null;
      }

      await tx
        .update(payments)
        .set({
          status: PaymentStatus.Captured,
          captureId: capture.captureId,
          capturedAt: capture.capturedAt,
        })
        .where(eq(payments.orderId, orderId));

      this.logger.log(
        `Order ${orderId} activated at warehouse ${activated.warehouseId}`,
      );

      return activated;
    });
  }

  private async reloadOrder(orderId: number): Promise<Order | null> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    return order ?? null;
  }

  /**
   * Compensation for a failed payment: flips the order from `reserved` to
   * `cancelled`, returns the reserved stock, and marks the (uncaptured) payment
   * `voided`, all in one transaction. The guards make it idempotent — a second
   * caller matches no rows and restores nothing (no double restock), and a
   * payment that was somehow captured is never overwritten.
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
        this.logger.warn(
          `Order ${orderId} cancelled at warehouse ${warehouseId}; reserved stock returned`,
        );
      }

      await tx
        .update(payments)
        .set({ status: PaymentStatus.Voided, voidedAt: new Date() })
        .where(
          and(
            eq(payments.orderId, orderId),
            ne(payments.status, PaymentStatus.Captured),
          ),
        );
    });
  }
}
