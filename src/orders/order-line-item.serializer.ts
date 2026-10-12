import type { OrderItem } from '../db/schema/index.js';
import type { OrderItemResponse } from './dto/order-response.dto.js';

export function serializeOrderLineItem(item: OrderItem): OrderItemResponse {
  return {
    productId: item.productId,
    sku: item.sku,
    name: item.productName,
    quantity: item.quantity,
    unitPriceAmount: item.unitPriceAmount.toString(),
    lineTotalAmount: item.lineTotalAmount.toString(),
  };
}
