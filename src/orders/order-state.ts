/**
 * Canonical states used by the database enum, API, and transition guards.
 * Flow: `created` → `reserved` → `active`; `cancelled` compensates a failed
 * capture. State changes use guarded updates.
 *
 * - `created`: order and lines saved, but no stock reserved; records a
 *   reservation race and keeps the idempotency key bound.
 * - `reserved`: stock is assigned and deducted; payment is pending. Replaying
 *   the key resumes payment with provider-scoped idempotency keys.
 * - `active`: paid and ready to fulfill.
 * - `cancelled`: payment failed and reserved stock was restored.
 */
export const OrderState = {
  Created: 'created',
  Reserved: 'reserved',
  Active: 'active',
  Cancelled: 'cancelled',
} as const;

export type OrderState = (typeof OrderState)[keyof typeof OrderState];

/** Persistable states in declaration order for the `order_state` enum. */
export const ORDER_STATES = [
  OrderState.Created,
  OrderState.Reserved,
  OrderState.Active,
  OrderState.Cancelled,
] as const satisfies readonly OrderState[];
