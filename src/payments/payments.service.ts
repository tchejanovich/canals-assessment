import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { cardLast4 } from './card.js';
import type {
  AuthorizeInput,
  AuthorizeResult,
  CaptureInput,
  CaptureResult,
  VoidInput,
  VoidResult,
} from './payments.types.js';

interface AuthorizationRecord {
  amount: bigint;
  last4: string;
  status: 'authorized' | 'captured' | 'voided';
  captureId: string | null;
}

/**
 * In-memory stand-in for a card processor. A real provider exposes three calls
 * that each take an idempotency key and persist their own result; we mirror
 * that shape so the order flow can be exercised end to end:
 *
 * - `authorize` places a hold for `amount` on the card — the funds are
 *   reserved but not moved. A card whose digits end in `0000`, or a
 *   non-positive amount, is declined.
 * - `capture` moves a previously authorized amount and returns a capture id.
 *   It fails if the authorization is unknown or has been voided; capturing an
 *   already-captured authorization replays the original capture id.
 * - `void` releases an authorization that was never captured.
 *
 * Every call is idempotent on its key: a repeated key replays the stored
 * result, and concurrent calls sharing a key await the same in-flight call
 * rather than reaching the provider twice. That idempotency — not the database
 * — is what makes the order flow safe to resume after a crash, because the
 * caller may retry an authorize/capture it never saw the response to.
 */
@Injectable()
export class PaymentsService {
  private readonly results = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly authorizations = new Map<string, AuthorizationRecord>();

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    return this.idempotent(input.idempotencyKey, () => {
      const last4 = cardLast4(input.creditCardNumber);
      const digits = input.creditCardNumber.replace(/\D/g, '');
      const approved = !digits.endsWith('0000') && input.amount > 0n;

      if (!approved) {
        return { status: 'declined', authorizationId: null, last4 } as const;
      }

      const authorizationId = randomUUID();
      this.authorizations.set(authorizationId, {
        amount: input.amount,
        last4,
        status: 'authorized',
        captureId: null,
      });

      return { status: 'authorized', authorizationId, last4 } as const;
    });
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    return this.idempotent(input.idempotencyKey, () => {
      const authorization = this.authorizations.get(input.authorizationId);
      if (!authorization || authorization.status === 'voided') {
        return { status: 'failed', captureId: null } as const;
      }

      if (authorization.status === 'captured') {
        return {
          status: 'captured',
          captureId: authorization.captureId!,
        } as const;
      }

      authorization.status = 'captured';
      authorization.captureId = randomUUID();
      return {
        status: 'captured',
        captureId: authorization.captureId,
      } as const;
    });
  }

  async void(input: VoidInput): Promise<VoidResult> {
    return this.idempotent(input.idempotencyKey, () => {
      const authorization = this.authorizations.get(input.authorizationId);
      if (!authorization || authorization.status === 'voided') {
        return { status: 'voided' } as const;
      }

      if (authorization.status === 'captured') {
        return { status: 'failed' } as const;
      }

      authorization.status = 'voided';
      return { status: 'voided' } as const;
    });
  }

  private async idempotent<T>(key: string, run: () => T): Promise<T> {
    const stored = this.results.get(key);
    if (stored !== undefined) {
      return stored as T;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const promise = Promise.resolve().then(() => {
      const result = run();
      this.results.set(key, result);
      return result;
    });
    this.inFlight.set(key, promise);

    return promise.finally(() => {
      this.inFlight.delete(key);
    });
  }
}
