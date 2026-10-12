/**
 * The only possible states of an order, and the single source of truth for the
 * string values that are stored in the `order_state` database enum, appear in
 * API responses and gate every transition. Never write the literal strings
 * elsewhere — reference `OrderState.{Created,Reserved,Active,Cancelled}`.
 *
 * Lifecycle: `created` -> `reserved` -> `active` is the happy path;
 * `cancelled` is the compensation when the payment capture fails after stock
 * was reserved. Each transition is a guarded `UPDATE ... WHERE state = <old>`
 * so an order can only move one step at a time, which is what makes replays
 * and crash recovery safe.
 *
 * - `created`  — header and lines persisted, nothing reserved yet (either
 *   still walking the nearest-first warehouse list, or every candidate was
 *   exhausted by the race window). A `created` order is the recorded trace of
 *   a lost race; it is reported in the 409 and its key stays bound.
 * - `reserved` — stock has been decremented at a specific warehouse and the
 *   warehouse is assigned; awaiting the payment lifecycle (authorize/capture),
 *   which runs outside any transaction. A crash in this state is recoverable: a
 *   replay of the key resumes the payment from its recorded status, and the
 *   order-scoped provider idempotency keys prevent a double charge.
 * - `active`   — payment captured; the order is fulfillable.
 * - `cancelled`— payment capture declined/failed; the reserved stock was
 *   returned to inventory atomically with this transition. Nothing was charged.
 */
export const OrderState = {
  Created: 'created',
  Reserved: 'reserved',
  Active: 'active',
  Cancelled: 'cancelled',
} as const;

export type OrderState = (typeof OrderState)[keyof typeof OrderState];

/**
 * All possible states in declaration order — the exact values and ordering of
 * the `order_state` database enum. `pgEnum` infers its column type from this
 * tuple, which stays literally identical to `OrderState` above.
 */
export const ORDER_STATES = [
  OrderState.Created,
  OrderState.Reserved,
  OrderState.Active,
  OrderState.Cancelled,
] as const satisfies readonly OrderState[];
