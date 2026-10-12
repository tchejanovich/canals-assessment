import type { Warehouse } from '../db/schema/index.js';
import type { WarehouseResponse } from '../orders/dto/order-response.dto.js';

export type WarehouseWithCodes = Warehouse & {
  regionCode: string;
  countryCode: string;
};

export function serializeWarehouse(
  warehouse: WarehouseWithCodes,
): WarehouseResponse {
  return {
    id: warehouse.id,
    name: warehouse.name,
    line1: warehouse.line1,
    line2: warehouse.line2,
    city: warehouse.city,
    region: warehouse.regionCode,
    postalCode: warehouse.postalCode,
    country: warehouse.countryCode,
    latitude: Number(warehouse.latitude),
    longitude: Number(warehouse.longitude),
    active: warehouse.active,
  };
}
