import type { OrderState } from '../order-state.js';

export interface OrderItemResponse {
  productId: number;
  sku: string;
  name: string;
  quantity: number;
  unitPriceAmount: string;
  lineTotalAmount: string;
}

export interface OrderResponse {
  id: number;
  customerId: number;
  warehouseId: number | null;
  state: OrderState;
  totalAmount: string;
  currency: string;
  shippingAddress: {
    line1: string;
    line2: string | null;
    city: string;
    region: string | null;
    postalCode: string;
    country: string;
    latitude: number;
    longitude: number;
  };
  items: OrderItemResponse[];
  createdAt: string;
}
