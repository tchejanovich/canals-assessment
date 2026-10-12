import type { OrderState } from '../order-state.js';

export interface OrderItemResponse {
  productId: number;
  sku: string;
  name: string;
  quantity: number;
  unitPriceAmount: string;
  lineTotalAmount: string;
}

export interface CustomerResponse {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

export interface WarehouseResponse {
  id: number;
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  latitude: number;
  longitude: number;
  active: boolean;
}

export interface OrderResponse {
  id: number;
  customer: CustomerResponse;
  warehouse: WarehouseResponse | null;
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
