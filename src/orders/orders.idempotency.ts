import { ConflictException } from '@nestjs/common';
import { buildAddressFingerprint } from '../addresses/address-fingerprint.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';

/**
 * Pure idempotency helpers: fingerprint a request, compare a replay against the
 * stored fingerprint, and recognise the unique-key violation the database
 * raises when two concurrent requests race the same new key.
 */

/**
 * Recognises a Postgres unique-constraint violation (`23505`) for a specific
 * constraint. Used to catch the `orders_idempotency_key_unique` race, but
 * deliberately generic so it can guard any unique index.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    code?: string;
    constraint_name?: string;
    constraint?: string;
  };
  return (
    candidate.code === '23505' &&
    (candidate.constraint_name === constraint ||
      candidate.constraint === constraint)
  );
}

/**
 * Returns a canonical string identifying the full request payload. The object
 * is built with a fixed key order and the items are sorted, so `JSON.stringify`
 * is deterministic and byte-comparable. The credit card is included because the
 * fingerprint must only match a replay that is identical in every respect.
 */
export function computeIdempotencyRequestFingerprint(
  dto: CreateOrderDto,
): string {
  const canonicalPayload = {
    creditCardNumber: dto.creditCardNumber,
    customerId: dto.customerId,
    address: buildAddressFingerprint(dto.address),
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
  if (
    requestFingerprint !== null &&
    requestFingerprint !== computeIdempotencyRequestFingerprint(dto)
  ) {
    throw new ConflictException(
      `Idempotency key ${key} was already used with a different payload`,
    );
  }
}
