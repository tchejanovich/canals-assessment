/**
 * Single source of truth for payment lifecycle states and operation outcomes.
 * `PAYMENT_STATUSES` below is the persistable subset used by the
 * `payment_status` database enum. Never write these status strings elsewhere —
 * reference `PaymentStatus.*`.
 *
 * Lifecycle: `authorizing` -> `authorized` -> `captured` is the happy path;
 * `voided` releases a hold taken by an authorization that is not (or cannot be)
 * captured. The persisted status records how far payment processing got, and
 * provider idempotency keys protect repeated individual provider calls. A
 * duplicate `POST /orders` does not resume a payment for a committed order.
 *
 * - `authorizing` — a hold is being placed; the provider response has not been
 *   recorded yet (or the process crashed before it was).
 * - `authorized`  — the hold exists; funds are reserved but not moved.
 * - `captured`    — the authorized amount was moved; the order is fulfilable.
 * - `voided`      — the hold was released (or never placed, for a decline); no
 *   funds moved and the order was cancelled.
 */
export const PaymentStatus = {
  Authorizing: 'authorizing',
  Authorized: 'authorized',
  Captured: 'captured',
  Voided: 'voided',
  Declined: 'declined',
  Failed: 'failed',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/**
 * Persistable states in declaration order — the exact values and ordering of
 * the `payment_status` database enum. `Declined` and `Failed` are operation
 * outcomes, not persisted payment states, so they are intentionally excluded.
 */
export const PAYMENT_STATUSES = [
  PaymentStatus.Authorizing,
  PaymentStatus.Authorized,
  PaymentStatus.Captured,
  PaymentStatus.Voided,
] as const satisfies readonly PaymentStatus[];
