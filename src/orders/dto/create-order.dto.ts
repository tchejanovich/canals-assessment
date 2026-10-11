export interface CreateOrderItemDto {
  productId: number;
  quantity: number;
}

export interface CreateOrderAddressDto {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface CreateOrderDto {
  customerId: number;
  items: CreateOrderItemDto[];
  address: CreateOrderAddressDto;
}
