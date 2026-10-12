import type { Coordinates } from '../common/geo.js';

/** Text fields used to identify an address. */
export interface AddressParts {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

/** Raw address, resolved reference IDs, and geocoded coordinates for persistence. */
export interface StoreAddressInput {
  customerId: number;
  address: AddressParts;
  regionId: number;
  countryId: number;
  coordinates: Coordinates;
}
