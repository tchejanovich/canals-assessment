import type { Order, Product } from '../db/schema/index.js';
import { IDEMPOTENCY_CONFLICT } from './orders.idempotency.js';
import type { OrderState } from './order-state.js';
import type { IdempotencyKeyConflict } from './orders.errors.js';

export interface PricedLineItem {
  product: Product;
  quantity: number;
  unitPriceAmount: bigint;
  lineTotalAmount: bigint;
}

export type OrderPlacementResult =
  | { kind: 'placed'; order: Order; state: OrderState }
  | { kind: typeof IDEMPOTENCY_CONFLICT; error: IdempotencyKeyConflict };
