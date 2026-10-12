import type { Order, OrderItem } from '../db/schema/index.js';
import type {
  OrderItemResponse,
  OrderResponse,
} from './dto/order-response.dto.js';
import type { PricedLineItem } from './orders.types.js';

/** Maps persisted order and line-item rows to API response shapes. */
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

/** Maps a newly priced line item for the create response. */
function toOrderItemFromPricedLineItem(
  line: PricedLineItem,
): OrderItemResponse {
  return {
    productId: line.product.id,
    sku: line.product.sku,
    name: line.product.name,
    quantity: line.quantity,
    unitPriceAmount: line.unitPriceAmount.toString(),
    lineTotalAmount: line.lineTotalAmount.toString(),
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

/** Maps a finalized order and marks it as newly created. */
export function toCreatedOrderResult(
  order: Order,
  pricedLineItems: PricedLineItem[],
): { order: OrderResponse; created: boolean } {
  return {
    order: toOrderResponse(
      order,
      pricedLineItems.map(toOrderItemFromPricedLineItem),
    ),
    created: true,
  };
}
