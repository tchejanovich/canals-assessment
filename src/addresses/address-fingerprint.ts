import type { AddressParts } from './addresses.types.js';

export type NormalizedAddressParts = [
  string,
  string,
  string,
  string,
  string,
  string,
];

export function normalizeAddressPart(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function normalizeAddressParts(
  address: AddressParts,
): NormalizedAddressParts {
  return [
    normalizeAddressPart(address.line1),
    normalizeAddressPart(address.line2),
    normalizeAddressPart(address.city),
    normalizeAddressPart(address.region),
    normalizeAddressPart(address.postalCode),
    normalizeAddressPart(address.country),
  ];
}

export function serializeCanonicalAddress(address: AddressParts): string {
  return JSON.stringify(normalizeAddressParts(address));
}

/**
 * Unambiguous identity of an address. JSON encoding preserves field boundaries
 * even when a field contains punctuation such as `|`.
 */
export function buildAddressFingerprint(address: AddressParts): string {
  return serializeCanonicalAddress(address);
}
