import type { Coordinates } from '../common/geo.js';

/** The textual parts of an address that determine its identity. */
export interface AddressParts {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

/**
 * Everything needed to persist an address: the raw parts (which determine the
 * deduplicating fingerprint), the already-resolved country/region ids and the
 * geocoded coordinates.
 */
export interface StoreAddressInput {
  customerId: number;
  address: AddressParts;
  regionId: number;
  countryId: number;
  coordinates: Coordinates;
}
