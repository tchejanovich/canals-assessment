/**
 * Canonical states used by the database enum, API, and transition guards.
 * Flow: `created` → `reserved` → `active`, or `created`/`reserved` → `failed`.
 * State changes use guarded updates.
 *
 * - `created`: transient state while order lines are saved and stock reservation
 *   is attempted.
 * - `reserved`: stock is assigned and deducted; payment is pending. Replaying
 *   the key resumes payment with provider-scoped idempotency keys.
 * - `active`: paid and ready to fulfill.
 * - `failed`: terminal unsuccessful outcome; `failureReason` distinguishes a
 *   stock reservation race from a payment failure.
 */
export const OrderState = {
  Created: 'created',
  Reserved: 'reserved',
  Active: 'active',
  Failed: 'failed',
} as const;

export type OrderState = (typeof OrderState)[keyof typeof OrderState];

export const OrderFailureReason = {
  Payment: 'payment',
  StockReservation: 'stock_reservation',
} as const;

export type OrderFailureReason =
  (typeof OrderFailureReason)[keyof typeof OrderFailureReason];

/** Persistable states in declaration order for the `order_state` enum. */
export const ORDER_STATES = [
  OrderState.Created,
  OrderState.Reserved,
  OrderState.Active,
  OrderState.Failed,
] as const satisfies readonly OrderState[];
