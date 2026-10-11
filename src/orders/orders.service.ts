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
import { createHash } from 'node:crypto';
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
  CreateOrderItem,
} from './dto/create-order.dto.js';
import type {
  OrderItemResponse,
  OrderResponse,
} from './dto/order-response.dto.js';
import { OrderState } from './order-state.js';
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
    idempotencyKey: string,
  ): Promise<{ order: OrderResponse; created: boolean }> {
    const replayed = await this.resolveIdempotentReplay(idempotencyKey, dto);
    if (replayed) {
      return { order: replayed, created: false };
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
    const requestHash = this.computeIdempotencyRequestHash(dto);

    // Phase 1 — one short transaction: persist the address, the order in state
    // `created` and its line items, then walk the nearest-first candidates and
    // reserve stock. A successful reserve flips the same row to `reserved` and
    // assigns the warehouse, atomically with the decrement. If every candidate
    // lost the race window the order stays `created` — nothing reserved,
    // nothing charged — and the caller reports the recorded 409.
    //
    // Phase 2 — outside any transaction: capture the payment. The reservation
    // commits BEFORE the (potentially slow) payment call, so inventory row
    // locks are never held across it. A declined capture is compensated in its
    // own transaction: the order flips to `cancelled` and the reserved stock
    // is returned to inventory, both atomically and idempotently (the flip is
    // guarded on `state = 'reserved'`, so a second run restores nothing).
    let outcome: { order: Order; state: OrderState };
    try {
      outcome = await this.db.transaction(async (tx) => {
        const fingerprint = buildFingerprint(dto.address);

        const inserted = await tx
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
            fingerprint,
          })
          .onConflictDoNothing({ target: addresses.fingerprint })
          .returning();

        const address =
          inserted[0] ??
          (
            await tx
              .select()
              .from(addresses)
              .where(eq(addresses.fingerprint, fingerprint))
              .limit(1)
          )[0];

        if (!address) {
          throw new ConflictException(
            'Address could not be stored despite a stable fingerprint',
          );
        }

        const [order] = await tx
          .insert(orders)
          .values({
            customerId: dto.customerId,
            warehouseId: null,
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
            idempotencyKey: idempotencyKey,
            idempotencyRequestHash: requestHash,
            state: OrderState.Created,
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

        for (const warehouse of candidates) {
          try {
            await this.inventory.reserve(tx, warehouse.id, dto.items);
          } catch (error) {
            // Stock ran out at this warehouse past candidate selection; fall
            // back to the next-nearest warehouse that could fulfil the order.
            if (error instanceof ConflictException) {
              continue;
            }
            throw error;
          }

          const [reserved] = await tx
            .update(orders)
            .set({ state: OrderState.Reserved, warehouseId: warehouse.id })
            .where(eq(orders.id, order.id))
            .returning();
          if (!reserved) {
            throw new ConflictException(
              `Order ${order.id} disappeared before it could be reserved`,
            );
          }

          return { order: reserved, state: OrderState.Reserved };
        }

        // Every candidate was exhausted by the race window: keep the order
        // (and the deduplicated address) and let the caller report the 409.
        return { order, state: OrderState.Created };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'orders_idempotency_key_unique')) {
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
      throw this.unfulfilledOrderConflict(outcome.order.id);
    }

    const finalized = await this.finalizeReservedOrder(outcome.order, dto);
    return {
      order: this.toOrderResponse(
        finalized,
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

  private async findIdempotentOrder(
    key: string,
  ): Promise<{
    order: Order;
    items: OrderItemResponse[];
    requestHash: string | null;
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
      requestHash: order.idempotencyRequestHash,
      items: rows.map((row) => this.toOrderItem(row.item)),
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

    this.assertReplayMatchesPayload(existing.requestHash, dto, idempotencyKey);

    switch (existing.order.state) {
      case OrderState.Active:
        return this.toOrderResponse(existing.order, existing.items);
      case OrderState.Reserved: {
        const finalized = await this.finalizeReservedOrder(existing.order, dto);
        return this.toOrderResponse(finalized, existing.items);
      }
      case OrderState.Cancelled:
        throw new HttpException(
          `Order ${existing.order.id} had its payment declined; it is recorded as '${OrderState.Cancelled}' ` +
            `and any reserved stock was returned. Retry with a new idempotency key to attempt it again`,
          HttpStatus.PAYMENT_REQUIRED,
        );
      default:
        throw this.unfulfilledOrderConflict(existing.order.id);
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
      throw new HttpException(
        'Payment was declined',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const [activated] = await this.db.transaction(async (tx) =>
      tx
        .update(orders)
        .set({ state: OrderState.Active })
        .where(and(eq(orders.id, reservedOrder.id), eq(orders.state, OrderState.Reserved)))
        .returning(),
    );
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

  /**
   * Returns the canonical hash of the parts of the request that determine the
   * order (customer, address and line items). The credit card is deliberately
   * excluded — it does not change what the order IS, only how it is paid for.
   */
  private computeIdempotencyRequestHash(dto: CreateOrderDto): string {
    const canonicalPayload = {
      customerId: dto.customerId,
      address: buildFingerprint(dto.address),
      items: [...dto.items]
        .sort((a, b) => a.productId - b.productId)
        .map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        })),
    };
    return createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');
  }

  /**
   * One idempotency key = one outcome. A replay must carry the same order
   * payload as the stored request; reusing the key with a different payload is
   * client misuse and is reported as a conflict rather than silently returning
   * a stored order that no longer matches what the client asked for.
   */
  private assertReplayMatchesPayload(
    requestHash: string | null,
    dto: CreateOrderDto,
    key: string,
  ): void {
    if (
      requestHash !== null &&
      requestHash !== this.computeIdempotencyRequestHash(dto)
    ) {
      throw new ConflictException(
        `Idempotency key ${key} was already used with a different payload`,
      );
    }
  }

  private unfulfilledOrderConflict(orderId: number): ConflictException {
    return new ConflictException(
      `Order ${orderId} could not be fulfilled (stock ran out at every nearby warehouse during reservation). ` +
        `It is recorded with state '${OrderState.Created}', no stock was reserved and nothing was charged. ` +
        `Retry with a new idempotency key to attempt it again`,
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
      state: order.state,
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
