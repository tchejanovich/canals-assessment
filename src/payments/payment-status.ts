/**
 * The only possible states of a payment, and the single source of truth for the
 * string values stored in the `payment_status` database enum. Never write the
 * literal strings elsewhere — reference `PaymentStatus.*`.
 *
 * Lifecycle: `authorizing` -> `authorized` -> `captured` is the happy path;
 * `voided` releases a hold taken by an authorization that is not (or cannot be)
 * captured. Each transition is a guarded update so the flow is safe to resume
 * after a crash: the provider's own idempotency keys mean a retried
 * authorize/capture returns the original result, and this column records how
 * far the last attempt got.
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
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/**
 * All possible states in declaration order — the exact values and ordering of
 * the `payment_status` database enum. `pgEnum` infers its column type from this
 * tuple, which stays literally identical to `PaymentStatus` above.
 */
export const PAYMENT_STATUSES = [
  PaymentStatus.Authorizing,
  PaymentStatus.Authorized,
  PaymentStatus.Captured,
  PaymentStatus.Voided,
] as const satisfies readonly PaymentStatus[];
