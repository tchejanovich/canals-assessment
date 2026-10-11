import type { AddressParts } from './addresses.types.js';

function normalizePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Stable identity of an address, used to deduplicate rows in `addresses` (and,
 * by the order service, to canonicalise the address inside the idempotency
 * request hash). Case- and whitespace-insensitive so the same address always
 * collapses onto one row.
 */
export function buildAddressFingerprint(address: AddressParts): string {
  return [
    address.line1,
    address.line2 ?? '',
    address.city,
    address.region,
    address.postalCode,
    address.country,
  ]
    .map(normalizePart)
    .join('|');
}
