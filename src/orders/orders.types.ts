import type { Order, Product } from '../db/schema/index.js';
import { IDEMPOTENCY_CONFLICT } from './orders.idempotency.js';
import type { OrderState } from './order-state.js';

export interface PricedLineItem {
  product: Product;
  quantity: number;
  unitPriceAmount: bigint;
  lineTotalAmount: bigint;
}

export type OrderPlacementResult =
  | { kind: 'placed'; order: Order; state: OrderState }
  | { kind: typeof IDEMPOTENCY_CONFLICT; error: IdempotencyKeyConflict };

export class IdempotencyKeyConflict extends Error {
  constructor() {
    super('Order already exists for this idempotency key');
    this.name = new.target.name;
  }
}
