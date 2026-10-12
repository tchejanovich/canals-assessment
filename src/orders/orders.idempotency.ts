import { buildAddressFingerprint } from '../addresses/address-fingerprint.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import { IdempotencyKeyReusedError } from './orders.errors.js';

export const IDEMPOTENCY_CONFLICT = 'idempotency-conflict';

/**
 * Pure idempotency helpers: fingerprint a request and compare a replay against
 * the stored fingerprint.
 */

/**
 * Returns a canonical string identifying the full request payload. The object
 * is built with a fixed key order and the items are sorted, so `JSON.stringify`
 * is deterministic and byte-comparable. The credit card is included because the
 * fingerprint must only match a replay that is identical in every respect.
 */
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

/**
 * One idempotency key = one outcome. A replay must carry the same order
 * payload as the stored request; reusing the key with a different payload is
 * client misuse and is reported as a conflict rather than silently returning
 * a stored order that no longer matches what the client asked for.
 */
export function assertReplayMatchesPayload(
  requestFingerprint: string | null,
  dto: CreateOrderDto,
  key: string,
): void {
  if (requestFingerprint !== computeIdempotencyRequestFingerprint(dto)) {
    throw new IdempotencyKeyReusedError(key);
  }
}
