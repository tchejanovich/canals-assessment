import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { AddressesService } from '../addresses/addresses.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { DATABASE, type Database } from '../db/database.module.js';
import {
  orderItems,
  type Order,
  orders,
  type Product,
} from '../db/schema/index.js';
import { ProductsService } from '../products/products.service.js';
import { WarehousesService } from '../warehouses/warehouses.service.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import type {
  OrderItemResponse,
  OrderResponse,
} from './dto/order-response.dto.js';
import {
  CustomerNotFoundError,
  MixedCurrencyError,
  NoFulfillingWarehouseError,
  OrderNotFoundError,
  OrderPaymentDeclinedError,
  ProductNotFoundError,
  ProductUnavailableError,
  UnfulfilledOrderError,
} from './orders.errors.js';
import {
  assertReplayMatchesPayload,
  computeIdempotencyRequestFingerprint,
  IDEMPOTENCY_CONFLICT,
} from './orders.idempotency.js';
import { OrderFinalizationService } from './order-finalization.service.js';
import {
  IdempotencyKeyConflict,
  OrderPlacementService,
} from './order-placement.service.js';
import {
  toCreatedOrderResult,
  toOrderItem,
  toOrderResponse,
} from './orders.mapper.js';
import {
  buildPricedLineItems,
  calculateTotal,
  resolveCurrency,
} from './orders.pricing.js';
import { OrderState } from './order-state.js';

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
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
    private readonly products: ProductsService,
    private readonly warehouses: WarehousesService,
    private readonly placement: OrderPlacementService,
    private readonly finalization: OrderFinalizationService,
  ) {}

  async getOrderById(orderId: number): Promise<OrderResponse> {
    const rows = await this.db
      .select({ order: orders, item: orderItems })
      .from(orders)
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(eq(orders.id, orderId))
      .orderBy(asc(orderItems.id));

    const firstRow = rows[0];
    if (!firstRow) {
      throw new OrderNotFoundError(orderId);
    }

    const items = rows.flatMap((row) =>
      row.item ? [toOrderItem(row.item)] : [],
    );
    return toOrderResponse(firstRow.order, items);
  }

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

    const productById = await this.resolveProducts(dto);

    const pricedLineItems = buildPricedLineItems(dto, productById);
    const totalAmount = calculateTotal(pricedLineItems);

    const currency = resolveCurrency(pricedLineItems);
    if (currency === null) {
      throw new MixedCurrencyError();
    }

    const countryId = await this.addresses.resolveCountry(dto.address.country);
    const regionId = await this.addresses.resolveRegion(
      countryId,
      dto.address.region,
    );

    const coordinates = await this.addresses.resolveCoordinates(dto.address);

    const warehouseCandidates = await this.warehouses.findFulfillingWarehouses(
      dto.items,
      coordinates,
      WAREHOUSE_FALLBACK_ATTEMPTS,
    );
    if (warehouseCandidates.length === 0) {
      this.logger.warn(
        `No single warehouse can fulfil customer ${dto.customerId}'s ${dto.items.length} item(s)`,
      );
      throw new NoFulfillingWarehouseError();
    }

    const requestFingerprint = idempotencyKey
      ? computeIdempotencyRequestFingerprint(dto)
      : null;

    const outcome = await this.placement.placeOrder({
      customerId: dto.customerId,
      address: dto.address,
      countryId,
      regionId,
      coordinates,
      candidates: warehouseCandidates,
      items: dto.items,
      totalAmount,
      currency,
      idempotencyKey: idempotencyKey ?? null,
      idempotencyRequestFingerprint: requestFingerprint,
      pricedLineItems,
    });

    if (outcome.kind === IDEMPOTENCY_CONFLICT) {
      if (!idempotencyKey) {
        throw outcome.error;
      }
      return this.resolveIdempotencyKeyConflict(
        idempotencyKey,
        dto,
        outcome.error,
      );
    }

    if (outcome.state === OrderState.Created) {
      throw new UnfulfilledOrderError(outcome.order.id);
    }

    const finalized = await this.finalization.finalizeReservedOrder(
      outcome.order,
      dto,
    );
    return toCreatedOrderResult(finalized, pricedLineItems);
  }

  private async resolveProducts(
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
        const finalized = await this.finalization.finalizeReservedOrder(
          existing.order,
          dto,
        );
        return toOrderResponse(finalized, existing.items);
      }
      case OrderState.Cancelled:
        throw new OrderPaymentDeclinedError(existing.order.id);
      default:
        throw new UnfulfilledOrderError(existing.order.id);
    }
  }

  private async resolveIdempotencyKeyConflict(
    idempotencyKey: string,
    dto: CreateOrderDto,
    conflict: IdempotencyKeyConflict,
  ): Promise<{ order: OrderResponse; created: false }> {
    // The transaction rolled back; attach to the committed winner instead.
    const replayed = await this.resolveIdempotentReplay(idempotencyKey, dto);
    if (!replayed) {
      throw conflict;
    }

    this.logger.log(
      `Idempotency key ${idempotencyKey} raced; attached to existing order ${replayed.id}`,
    );
    return { order: replayed, created: false };
  }
}
