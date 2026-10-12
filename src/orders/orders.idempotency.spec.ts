import type { CreateOrderDto } from './dto/create-order.dto.js';
import {
  assertReplayMatchesPayload,
  computeIdempotencyRequestFingerprint,
} from './orders.idempotency.js';

describe('assertReplayMatchesPayload', () => {
  it('accepts a matching fingerprint using the current address format', () => {
    const dto: CreateOrderDto = {
      customerId: 1,
      items: [{ productId: 2, quantity: 1 }],
      address: {
        line1: '10 Main St',
        line2: null,
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        country: 'US',
      },
      creditCardNumber: '4242424242424242',
    };

    expect(() =>
      assertReplayMatchesPayload(
        computeIdempotencyRequestFingerprint(dto),
        dto,
        'attempt-key',
      ),
    ).not.toThrow();
  });

  it('rejects legacy or missing fingerprints instead of bypassing comparison', () => {
    const dto: CreateOrderDto = {
      customerId: 1,
      items: [{ productId: 2, quantity: 1 }],
      address: {
        line1: '10 Main St',
        line2: null,
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        country: 'US',
      },
      creditCardNumber: '4242424242424242',
    };
    const legacyFingerprint = JSON.stringify({
      creditCardNumber: dto.creditCardNumber,
      customerId: dto.customerId,
      address: '10 main st||new york|ny|10001|us',
      items: [{ productId: 2, quantity: 1 }],
    });

    expect(() =>
      assertReplayMatchesPayload(legacyFingerprint, dto, 'attempt-key'),
    ).toThrow();
    expect(() =>
      assertReplayMatchesPayload(null, dto, 'attempt-key'),
    ).toThrow();
  });
});
