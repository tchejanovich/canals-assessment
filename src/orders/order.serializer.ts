import type { Customer, Order, OrderItem } from '../db/schema/index.js';
import type { OrderResponse } from './dto/order-response.dto.js';
import { serializeCustomer } from '../customers/customer.serializer.js';
import { serializeOrderLineItem } from './order-line-item.serializer.js';
import {
  serializeWarehouse,
  type WarehouseWithCodes,
} from '../warehouses/warehouse.serializer.js';

export interface OrderSerializationInput {
  order: Order;
  customer: Customer;
  warehouse: WarehouseWithCodes | null;
  items: OrderItem[];
}

export function serializeOrder(input: OrderSerializationInput): OrderResponse {
  const { order } = input;
  return {
    id: order.id,
    customer: serializeCustomer(input.customer),
    warehouse: input.warehouse ? serializeWarehouse(input.warehouse) : null,
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
    items: input.items.map(serializeOrderLineItem),
    createdAt: order.createdAt.toISOString(),
  };
}
