import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { AddressesService } from '../addresses/addresses.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { DATABASE, type Database } from '../db/database.module.js';
import {
  orderItems,
  orders,
  type Product,
} from '../db/schema/index.js';
import { ProductsService } from '../products/products.service.js';
import { WarehousesService } from '../warehouses/warehouses.service.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import type { OrderResponse } from './dto/order-response.dto.js';
import {
  CustomerNotFoundError,
  IdempotencyKeyConflictError,
  MixedCurrencyError,
  NoFulfillingWarehouseError,
  OrderNotFoundError,
  ProductNotFoundError,
  ProductUnavailableError,
  UnfulfilledOrderError,
} from './orders.errors.js';
import { OrderFinalizationService } from './order-finalization.service.js';
import { OrderPlacementService } from './order-placement.service.js';
import {
  toOrderItem,
  toOrderResponse,
  toOrderResponseFromPricedLineItems,
} from './orders.mapper.js';
import {
  buildPricedLineItems,
  calculateSubtotal,
  validateAndResolveCurrency,
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
  ): Promise<OrderResponse> {
    if (idempotencyKey !== undefined) {
      await this.assertIdempotencyKeyUnused(idempotencyKey);
    }

    const customer = await this.customers.findById(dto.customerId);
    if (!customer) {
      throw new CustomerNotFoundError(dto.customerId);
    }

    const productById = await this.resolveProductMap(dto);

    const pricedLineItems = buildPricedLineItems(dto, productById);
    const subtotalAmount = calculateSubtotal(pricedLineItems);

    const currency = validateAndResolveCurrency(pricedLineItems);
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
        `No single warehouse can fulfil customer ${dto.customerId}'s ${dto.items.length} item(s)`,
      );
      throw new NoFulfillingWarehouseError();
    }

    const totalAmount = subtotalAmount;

    const outcome = await this.placement.placeOrder({
      customerId: dto.customerId,
      address: dto.address,
      countryId,
      regionId,
      coordinates,
      candidates,
      items: dto.items,
      subtotalAmount,
      totalAmount,
      currency,
      idempotencyKey: idempotencyKey ?? null,
      pricedLineItems,
    });

    if (outcome.state === OrderState.Created) {
      throw new UnfulfilledOrderError(outcome.order.id);
    }

    const finalized = await this.finalization.finalizeReservedOrder(
      outcome.order,
      dto,
    );
    return toOrderResponseFromPricedLineItems(finalized, pricedLineItems);
  }

  private async assertIdempotencyKeyUnused(key: string): Promise<void> {
    const [existing] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.idempotencyKey, key))
      .limit(1);

    if (existing) throw new IdempotencyKeyConflictError(key);
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

}
