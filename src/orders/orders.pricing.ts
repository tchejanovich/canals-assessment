import type { Product } from '../db/schema/index.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import type { PricedLineItem } from './orders.types.js';

/**
 * Pure pricing helpers: turn the requested items into priced lines, total them
 * and resolve the single currency they must share. No I/O and no service state.
 */
export function buildPricedLineItems(
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

export function calculateSubtotal(pricedLineItems: PricedLineItem[]): bigint {
  return pricedLineItems.reduce((sum, line) => sum + line.lineTotalAmount, 0n);
}

export function resolveCurrency(
  pricedLineItems: PricedLineItem[],
): string | null {
  const currency = pricedLineItems[0].product.currency;
  if (pricedLineItems.some((line) => line.product.currency !== currency)) {
    return null;
  }
  return currency;
}
