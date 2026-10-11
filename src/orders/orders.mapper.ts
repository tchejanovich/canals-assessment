import type { Order, OrderItem } from '../db/schema/index.js';
import type {
  OrderItemResponse,
  OrderResponse,
} from './dto/order-response.dto.js';

/**
 * Pure mapping from persisted rows to the API response shape. No I/O and no
 * service state, so these are the canonical place to translate an order (and
 * its lines) for the wire.
 */
export function toOrderItem(item: OrderItem): OrderItemResponse {
  return {
    productId: item.productId,
    sku: item.sku,
    name: item.productName,
    quantity: item.quantity,
    unitPriceAmount: item.unitPriceAmount.toString(),
    lineTotalAmount: item.lineTotalAmount.toString(),
  };
}

export function toOrderResponse(
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
