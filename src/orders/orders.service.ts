import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq, type SQL } from 'drizzle-orm';
import { AddressesService } from '../addresses/addresses.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { DATABASE, type Database } from '../db/database.module.js';
import {
  countries,
  customers,
  orderItems,
  orders,
  type Product,
  regions,
  warehouses,
} from '../db/schema/index.js';
import { ProductsService } from '../products/products.service.js';
import { WarehousesService } from '../warehouses/warehouses.service.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import type { OrderResponse } from './dto/order-response.dto.js';
import {
  IdempotencyKeyConflict,
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
import { OrderPlacementService } from './order-placement.service.js';
import { serializeOrder } from './order.serializer.js';
import type { OrderSerializationInput } from './order.serializer.js';
import {
  buildPricedLineItems,
  calculateTotal,
  resolveCurrency,
} from './orders.pricing.js';
import { OrderState } from './order-state.js';
import type { PreparedOrder } from './orders.types.js';

/** Try at most five nearest candidates; reservation rechecks stock under lock. */
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
    const order = await this.findOrderForSerialization(
      eq(orders.id, orderId),
    );
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }
    return serializeOrder(order);
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

    const preparedOrder = await this.prepareOrder(dto);

    const requestFingerprint = idempotencyKey
      ? computeIdempotencyRequestFingerprint(dto)
      : null;

    const outcome = await this.placement.placeOrder({
      customer: dto.customer,
      address: dto.address,
      countryId: preparedOrder.countryId,
      regionId: preparedOrder.regionId,
      coordinates: preparedOrder.coordinates,
      candidates: preparedOrder.candidates,
      items: dto.items,
      totalAmount: preparedOrder.totalAmount,
      currency: preparedOrder.currency,
      idempotencyKey: idempotencyKey ?? null,
      idempotencyRequestFingerprint: requestFingerprint,
      pricedLineItems: preparedOrder.pricedLineItems,
    });

    if (outcome.type === IDEMPOTENCY_CONFLICT) {
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
    return { order: await this.getOrderById(finalized.id), created: true };
  }

  private async prepareOrder(dto: CreateOrderDto): Promise<PreparedOrder> {
    await this.customers.validateForOrder(dto.customer);

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
    const candidates = await this.warehouses.findFulfillingWarehouses(
      dto.items,
      coordinates,
      WAREHOUSE_FALLBACK_ATTEMPTS,
    );
    if (candidates.length === 0) {
      this.logger.warn(
        `No single warehouse can fulfil an order with ${dto.items.length} item(s)`,
      );
      throw new NoFulfillingWarehouseError();
    }
    this.logger.debug(
      `Found ${candidates.length} fulfilling warehouse candidate(s); nearest is ${candidates[0].id}`,
    );

    return {
      pricedLineItems,
      totalAmount,
      currency,
      countryId,
      regionId,
      coordinates,
      candidates,
    };
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
    serialized: OrderSerializationInput;
    requestFingerprint: string | null;
  } | null> {
    const serialized = await this.findOrderForSerialization(
      eq(orders.idempotencyKey, key),
    );
    if (!serialized) return null;

    return {
      serialized,
      requestFingerprint: serialized.order.idempotencyRequestFingerprint,
    };
  }

  private async findOrderForSerialization(
    condition: SQL,
  ): Promise<OrderSerializationInput | null> {
    const rows = await this.db
      .select({
        order: orders,
        customer: customers,
        warehouse: warehouses,
        warehouseRegionCode: regions.code,
        warehouseCountryCode: countries.code,
        item: orderItems,
      })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(warehouses, eq(warehouses.id, orders.warehouseId))
      .leftJoin(regions, eq(regions.id, warehouses.regionId))
      .leftJoin(countries, eq(countries.id, warehouses.countryId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(condition)
      .orderBy(asc(orderItems.id));

    const firstRow = rows[0];
    if (!firstRow) return null;

    let warehouse: OrderSerializationInput['warehouse'] = null;
    if (firstRow.warehouse) {
      if (
        firstRow.warehouseRegionCode === null ||
        firstRow.warehouseCountryCode === null
      ) {
        throw new Error(
          `Warehouse ${firstRow.warehouse.id} is missing region or country data`,
        );
      }
      warehouse = {
        ...firstRow.warehouse,
        regionCode: firstRow.warehouseRegionCode,
        countryCode: firstRow.warehouseCountryCode,
      };
    }

    return {
      order: firstRow.order,
      customer: firstRow.customer,
      warehouse,
      items: rows.flatMap((row) => (row.item ? [row.item] : [])),
    };
  }

  /** Replays must match the stored payload. Active orders return as-is; reserved
   * orders resume payment; created/cancelled orders return their recorded errors.
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
      `Idempotency key ${idempotencyKey} replay -> order ${existing.serialized.order.id} (state ${existing.serialized.order.state})`,
    );

    switch (existing.serialized.order.state) {
      case OrderState.Active:
        return serializeOrder(existing.serialized);
      case OrderState.Reserved: {
        const finalized = await this.finalization.finalizeReservedOrder(
          existing.serialized.order,
          dto,
        );
        return serializeOrder({
          ...existing.serialized,
          order: finalized,
        });
      }
      case OrderState.Cancelled:
        throw new OrderPaymentDeclinedError(existing.serialized.order.id);
      default:
        throw new UnfulfilledOrderError(existing.serialized.order.id);
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
