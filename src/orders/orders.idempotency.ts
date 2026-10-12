import { buildAddressFingerprint } from '../addresses/address-fingerprint.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import { IdempotencyKeyReusedError } from './orders.errors.js';

export const IDEMPOTENCY_CONFLICT = 'idempotency-conflict';

/** Request fingerprint and replay helpers. */

/** Fingerprints normalized address data and sorted order lines. */
export function computeIdempotencyRequestFingerprint(
  dto: CreateOrderDto,
): string {
  return computeRequestFingerprint(dto, buildAddressFingerprint(dto.address));
}

function computeRequestFingerprint(
  dto: CreateOrderDto,
  addressFingerprint: string,
): string {
  const canonicalPayload = {
    creditCardNumber: dto.creditCardNumber,
    customerId: dto.customerId,
    address: addressFingerprint,
    items: [...dto.items]
      .sort((a, b) => a.productId - b.productId)
      .map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
  };
  return JSON.stringify(canonicalPayload);
}

/** Rejects replays whose payload differs from the original request. */
export function assertReplayMatchesPayload(
  requestFingerprint: string | null,
  dto: CreateOrderDto,
  key: string,
): void {
  if (requestFingerprint !== computeIdempotencyRequestFingerprint(dto)) {
    throw new IdempotencyKeyReusedError(key);
  }
}
