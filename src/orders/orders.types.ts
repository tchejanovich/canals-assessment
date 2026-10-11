import type { Product } from '../db/schema/index.js';

export interface PricedLineItem {
  product: Product;
  quantity: number;
  unitPriceAmount: bigint;
  lineTotalAmount: bigint;
}
