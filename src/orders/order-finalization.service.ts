import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import { DATABASE, type Database } from '../db/database.module.js';
import { type Order, orders } from '../db/schema/index.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentStatus } from '../payments/payment-status.js';
import { PaymentsService } from '../payments/payments.service.js';
import {
  OrderPaymentDeclinedError,
  PaymentCaptureFailedError,
  PaymentDeclinedError,
  ReservedOrderMissingWarehouseError,
} from './orders.errors.js';
import { OrderState } from './order-state.js';

@Injectable()
export class OrderFinalizationService {
  private readonly logger = new Logger('OrdersService');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
  ) {}

  /** Completes payment for a reservation, or compensates it when payment fails. */
  async finalizeReservedOrder(
    reservedOrder: Order,
    dto: CreateOrderDto,
  ): Promise<Order> {
    const orderId = reservedOrder.id;
    const warehouseId = reservedOrder.warehouseId;
    if (warehouseId === null) {
      throw new ReservedOrderMissingWarehouseError(orderId);
    }

    const payment = await this.payments.processOrderPayment({
      orderId,
      amount: reservedOrder.totalAmount,
      creditCardNumber: dto.creditCardNumber,
      description: `Order ${orderId} for customer ${dto.customerId}`,
    });

    switch (payment.status) {
      case PaymentStatus.Captured:
        if (payment.alreadyCaptured) {
          this.logger.log(
            `Order ${orderId} payment already captured (capture ${payment.captureId}); activating`,
          );
        } else {
          this.logger.log(
            `Order ${orderId} payment captured (capture ${payment.captureId})`,
          );
        }
        return this.finishActivation(orderId, reservedOrder, {
          captureId: payment.captureId,
          capturedAt: payment.capturedAt ?? new Date(),
        });

      case PaymentStatus.Voided:
        this.logger.warn(
          `Order ${orderId} payment is voided; cancelling and restoring stock`,
        );
        await this.cancelOrderAndRestoreStock(orderId, warehouseId, dto);
        throw new OrderPaymentDeclinedError(orderId);

      case PaymentStatus.Declined:
        this.logger.warn(
          `Order ${orderId} payment declined; cancelling and restoring stock`,
        );
        await this.cancelOrderAndRestoreStock(orderId, warehouseId, dto);
        throw new PaymentDeclinedError();

      case PaymentStatus.Failed:
        this.logger.error(
          `Order ${orderId} payment capture failed; cancelling`,
        );
        await this.cancelOrderAndRestoreStock(orderId, warehouseId, dto);
        throw new PaymentCaptureFailedError(orderId);
    }
  }

  /**
   * Flips a reserved order to active and records capture in one transaction.
   * If another finalizer won, reload its committed order.
   */
  private async finishActivation(
    orderId: number,
    reservedOrder: Order,
    capture: { captureId: string; capturedAt: Date },
  ): Promise<Order> {
    const activated = await this.activateOrder(orderId, capture);
    // Return our updated row when this transaction wins activation.
    if (activated) return activated;
    // Otherwise reload the latest state, falling back if its row is missing.
    return (await this.reloadOrder(orderId)) ?? reservedOrder;
  }

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

      if (!activated) return null;

      await this.payments.markCaptured(tx, orderId, capture);
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
   * Cancels the reservation, restores stock, and marks payment voided atomically.
   */
  private async cancelOrderAndRestoreStock(
    orderId: number,
    warehouseId: number,
    dto: CreateOrderDto,
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
        await this.inventory.restore(tx, warehouseId, dto.items);
        this.logger.warn(
          `Order ${orderId} cancelled at warehouse ${warehouseId}; reserved stock returned`,
        );
      }

      await this.payments.markVoided(tx, orderId);
    });
  }
}
