import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Lifecycle of an order. Transitions are advanced by the order service as it
 * selects a warehouse, attempts payment and finalises (or cancels) the order.
 */
export const orderStatusEnum = pgEnum('order_status', [
  'PENDING',
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'CANCELLED',
]);

export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
