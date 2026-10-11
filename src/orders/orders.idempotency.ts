import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
 * Returns the canonical hash of the parts of the request that determine the
 * order (customer, address and line items). The credit card is deliberately
 * excluded — it does not change what the order IS, only how it is paid for.
 */
export function computeIdempotencyRequestHash(dto: CreateOrderDto): string {
  const canonicalPayload = {
    customerId: dto.customerId,
    address: buildAddressFingerprint(dto.address),
    items: [...dto.items]
      .sort((a, b) => a.productId - b.productId)
      .map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex');
}

/**
 * One idempotency key = one outcome. A replay must carry the same order
 * payload as the stored request; reusing the key with a different payload is
 * client misuse and is reported as a conflict rather than silently returning
 * a stored order that no longer matches what the client asked for.
 */
export function assertReplayMatchesPayload(
  requestHash: string | null,
  dto: CreateOrderDto,
  key: string,
): void {
  if (
    requestHash !== null &&
    requestHash !== computeIdempotencyRequestHash(dto)
  ) {
    throw new ConflictException(
      `Idempotency key ${key} was already used with a different payload`,
    );
  }
}
