/** Payment states and operation outcomes. `PAYMENT_STATUSES` lists persisted
 * values; declined and failed are transient. Flow: authorizing → authorized →
 * captured, or voided when the hold is released.
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

/** Persisted enum values; Declined and Failed are transient outcomes. */
export const PAYMENT_STATUSES = [
  PaymentStatus.Authorizing,
  PaymentStatus.Authorized,
  PaymentStatus.Captured,
  PaymentStatus.Voided,
] as const satisfies readonly PaymentStatus[];
