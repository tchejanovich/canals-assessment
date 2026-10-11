import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { CustomersService } from '../customers/customers.service.js';
import { DATABASE, type Database } from '../db/database.module.js';
import {
  addresses,
  countries,
  orderItems,
  type Order,
  type OrderItem,
  orders,
  type Product,
  regions,
} from '../db/schema/index.js';
import { GeocodingService } from '../geocoding/geocoding.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { ProductsService } from '../products/products.service.js';
import { WarehousesService } from '../warehouses/warehouses.service.js';
import type {
  CreateOrderAddress,
  CreateOrderDto,
} from './dto/create-order.dto.js';
import type {
  OrderItemResponse,
  OrderResponse,
} from './dto/order-response.dto.js';
import type { PricedLineItem } from './orders.types.js';

function normalizePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildFingerprint(address: CreateOrderAddress): string {
  return [
    address.line1,
    address.line2 ?? '',
    address.city,
    address.region,
    address.postalCode,
    address.country,
  ]
    .map(normalizePart)
    .join('|');
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    code?: string;
    constraint_name?: string;
    constraint?: string;
  };
  return (
    candidate.code === '23505' &&
    (candidate.constraint_name === constraint ||
      candidate.constraint === constraint)
  );
}

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
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return { order: existing, created: false };
      }
    }

    const customer = await this.customers.findById(dto.customerId);
    if (!customer) {
      throw new NotFoundException(`Customer ${dto.customerId} not found`);
    }

    const productById = await this.resolveProductMap(dto);

    const pricedLineItems = this.buildPricedLineItems(dto, productById);
    const subtotalAmount = this.calculateSubtotal(pricedLineItems);

    const currency = this.validateAndResolveCurrency(pricedLineItems);

    const countryId = await this.resolveCountry(dto.address.country);
    const regionId = await this.resolveRegion(countryId, dto.address.region);

    const coordinates = await this.geocoding.getCoordinates(dto.address);

    const candidates = await this.warehouses.findFulfillingWarehouses(
      dto.items,
      coordinates,
      WAREHOUSE_FALLBACK_ATTEMPTS,
    );
    if (candidates.length === 0) {
      throw new UnprocessableEntityException(
        'No single warehouse can fulfil the entire order',
      );
    }

    const totalAmount = subtotalAmount;

    for (const warehouse of candidates) {
      try {
        const created = await this.db.transaction(async (tx) => {
          await this.inventory.reserve(tx, warehouse.id, dto.items);

          const [address] = await tx
            .insert(addresses)
            .values({
              customerId: dto.customerId,
              line1: dto.address.line1,
              line2: dto.address.line2 ?? null,
              city: dto.address.city,
              regionId,
              postalCode: dto.address.postalCode,
              countryId,
              latitude: coordinates.latitude.toFixed(6),
              longitude: coordinates.longitude.toFixed(6),
              fingerprint: buildFingerprint(dto.address),
            })
            .onConflictDoUpdate({
              target: addresses.fingerprint,
              set: { updatedAt: new Date() },
            })
            .returning();

          const [order] = await tx
            .insert(orders)
            .values({
              customerId: dto.customerId,
              warehouseId: warehouse.id,
              shippingAddressId: address.id,
              subtotalAmount,
              totalAmount,
              currency,
              shippingLine1: dto.address.line1,
              shippingLine2: dto.address.line2 ?? null,
              shippingCity: dto.address.city,
              shippingRegion: dto.address.region,
              shippingPostalCode: dto.address.postalCode,
              shippingCountry: dto.address.country,
              shippingLatitude: coordinates.latitude.toFixed(6),
              shippingLongitude: coordinates.longitude.toFixed(6),
              idempotencyKey: idempotencyKey ?? null,
            })
            .returning();

          await tx.insert(orderItems).values(
            pricedLineItems.map((line) => ({
              orderId: order.id,
              productId: line.product.id,
              productName: line.product.name,
              sku: line.product.sku,
              unitPriceAmount: line.unitPriceAmount,
              quantity: line.quantity,
              lineTotalAmount: line.lineTotalAmount,
              currency,
            })),
          );

          const payment = await this.payments.charge({
            creditCardNumber: dto.creditCardNumber,
            amount: totalAmount,
            description: `Order ${order.id} for customer ${dto.customerId}`,
          });
          if (!payment.approved) {
            throw new HttpException(
              'Payment was declined',
              HttpStatus.PAYMENT_REQUIRED,
            );
          }

          return order;
        });

        return {
          order: this.toOrderResponse(
            created,
            pricedLineItems.map((line) => ({
              productId: line.product.id,
              sku: line.product.sku,
              name: line.product.name,
              quantity: line.quantity,
              unitPriceAmount: line.unitPriceAmount.toString(),
              lineTotalAmount: line.lineTotalAmount.toString(),
            })),
          ),
          created: true,
        };
      } catch (error) {
        if (
          idempotencyKey &&
          isUniqueViolation(error, 'orders_idempotency_key_unique')
        ) {
          const existing = await this.findByIdempotencyKey(idempotencyKey);
          if (existing) {
            return { order: existing, created: false };
          }
        }
        if (error instanceof ConflictException) {
          // Stock ran out at this warehouse past candidate selection; fall
          // back to the next-nearest warehouse that could fulfil the order.
          continue;
        }
        throw error;
      }
    }

    throw new ConflictException(
      'Insufficient stock to fulfil the order at any nearby warehouse',
    );
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
        throw new NotFoundException(`Product ${item.productId} not found`);
      }
      if (!product.active) {
        throw new BadRequestException(
          `Product ${item.productId} is not available`,
        );
      }
    }

    return productById;
  }

  private buildPricedLineItems(
    dto: CreateOrderDto,
    productById: Map<number, Product>,
  ): PricedLineItem[] {
    return dto.items.map((item) => {
      const product = productById.get(item.productId)!;
      const lineTotalAmount = product.priceAmount * BigInt(item.quantity);
      return {
        product,
        quantity: item.quantity,
        unitPriceAmount: product.priceAmount,
        lineTotalAmount,
      };
    });
  }

  private calculateSubtotal(pricedLineItems: PricedLineItem[]): bigint {
    return pricedLineItems.reduce(
      (sum, line) => sum + line.lineTotalAmount,
      0n,
    );
  }

  private validateAndResolveCurrency(
    pricedLineItems: PricedLineItem[],
  ): string {
    const currency = pricedLineItems[0].product.currency;
    if (pricedLineItems.some((line) => line.product.currency !== currency)) {
      throw new BadRequestException(
        'All products in an order must share the same currency',
      );
    }
    return currency;
  }

  private async findByIdempotencyKey(
    key: string,
  ): Promise<OrderResponse | null> {
    const rows = await this.db
      .select({ order: orders, item: orderItems })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(eq(orders.idempotencyKey, key));

    if (rows.length === 0) {
      return null;
    }

    const { order } = rows[0];
    return this.toOrderResponse(
      order,
      rows.map((row) => this.toOrderItem(row.item)),
    );
  }

  private toOrderItem(item: OrderItem): OrderItemResponse {
    return {
      productId: item.productId,
      sku: item.sku,
      name: item.productName,
      quantity: item.quantity,
      unitPriceAmount: item.unitPriceAmount.toString(),
      lineTotalAmount: item.lineTotalAmount.toString(),
    };
  }

  private toOrderResponse(
    order: Order,
    items: OrderItemResponse[],
  ): OrderResponse {
    return {
      id: order.id,
      customerId: order.customerId,
      warehouseId: order.warehouseId,
      subtotalAmount: order.subtotalAmount.toString(),
      totalAmount: order.totalAmount.toString(),
      currency: order.currency,
      shippingAddress: {
        line1: order.shippingLine1,
        line2: order.shippingLine2,
        city: order.shippingCity,
        region: order.shippingRegion,
        postalCode: order.shippingPostalCode,
        country: order.shippingCountry,
        latitude: Number(order.shippingLatitude),
        longitude: Number(order.shippingLongitude),
      },
      items,
      createdAt: order.createdAt.toISOString(),
    };
  }

  private async resolveCountry(countryCode: string): Promise<number> {
    const [country] = await this.db
      .select({ id: countries.id })
      .from(countries)
      .where(eq(countries.code, countryCode))
      .limit(1);
    if (!country) {
      throw new BadRequestException(`Unknown country ${countryCode}`);
    }
    return country.id;
  }

  private async resolveRegion(
    countryId: number,
    regionCode: string,
  ): Promise<number> {
    const [region] = await this.db
      .select({ id: regions.id })
      .from(regions)
      .where(
        and(eq(regions.countryId, countryId), eq(regions.code, regionCode)),
      )
      .limit(1);
    if (!region) {
      throw new BadRequestException(`Unknown region ${regionCode}`);
    }
    return region.id;
  }
}
