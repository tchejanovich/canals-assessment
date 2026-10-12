import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { cardLast4 } from './card.js';
import { PaymentStatus } from './payment-status.js';
import type {
  AuthorizeInput,
  AuthorizeResult,
  CaptureInput,
  CaptureResult,
  VoidInput,
  VoidResult,
} from './payments.types.js';

type AuthorizationStatus = Exclude<
  PaymentStatus,
  | typeof PaymentStatus.Authorizing
  | typeof PaymentStatus.Declined
  | typeof PaymentStatus.Failed
>;

interface AuthorizationRecord {
  amount: bigint;
  last4: string;
  status: AuthorizationStatus;
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
export class PaymentsApi {
  private readonly results = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly authorizations = new Map<string, AuthorizationRecord>();

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    return this.idempotent(input.idempotencyKey, () => {
      const last4 = cardLast4(input.creditCardNumber);
      const approved = this.shouldApproveAuthorization(input);

      if (!approved) {
        return {
          status: PaymentStatus.Declined,
          authorizationId: null,
          last4,
        } as const;
      }

      const authorizationId = randomUUID();
      this.authorizations.set(authorizationId, {
        amount: input.amount,
        last4,
        status: PaymentStatus.Authorized,
        captureId: null,
      });

      return {
        status: PaymentStatus.Authorized,
        authorizationId,
        last4,
      } as const;
    });
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    return this.idempotent(input.idempotencyKey, () => {
      const authorization = this.authorizations.get(input.authorizationId);
      if (!authorization || authorization.status === PaymentStatus.Voided) {
        return {
          status: PaymentStatus.Failed,
          captureId: null,
        } as const;
      }

      if (authorization.status === PaymentStatus.Captured) {
        return {
          status: PaymentStatus.Captured,
          captureId: authorization.captureId!,
        } as const;
      }

      authorization.status = PaymentStatus.Captured;
      authorization.captureId = randomUUID();
      return {
        status: PaymentStatus.Captured,
        captureId: authorization.captureId,
      } as const;
    });
  }

  async void(input: VoidInput): Promise<VoidResult> {
    return this.idempotent(input.idempotencyKey, () => {
      const authorization = this.authorizations.get(input.authorizationId);
      if (!authorization || authorization.status === PaymentStatus.Voided) {
        return { status: PaymentStatus.Voided } as const;
      }

      if (authorization.status === PaymentStatus.Captured) {
        return { status: PaymentStatus.Failed } as const;
      }

      authorization.status = PaymentStatus.Voided;
      return { status: PaymentStatus.Voided } as const;
    });
  }

  private shouldApproveAuthorization(input: AuthorizeInput): boolean {
    return !input.creditCardNumber.endsWith('0000') && input.amount > 0n;
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
