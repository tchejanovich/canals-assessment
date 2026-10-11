export interface GeocodingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}
