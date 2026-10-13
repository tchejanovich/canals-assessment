import type { Order, Product } from '../db/schema/index.js';
import type { Coordinates } from '../common/geo.js';
import { IDEMPOTENCY_CONFLICT } from './orders.idempotency.js';
import { OrderState } from './order-state.js';
import type { IdempotencyKeyConflict } from './orders.errors.js';
import type { WarehouseWithDistance } from '../warehouses/warehouses.service.js';

export interface PricedLineItem {
  product: Product;
  quantity: number;
  unitPriceAmount: bigint;
  lineTotalAmount: bigint;
}

export interface PreparedOrder {
  pricedLineItems: PricedLineItem[];
  totalAmount: bigint;
  currency: string;
  countryId: number;
  regionId: number;
  coordinates: Coordinates;
  candidates: WarehouseWithDistance[];
}

export type OrderPlacementResult =
  | {
      type: 'placed';
      order: Order;
      state: typeof OrderState.Reserved | typeof OrderState.Failed;
    }
  | { type: typeof IDEMPOTENCY_CONFLICT; error: IdempotencyKeyConflict };
