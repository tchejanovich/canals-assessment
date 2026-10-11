export interface AuthorizeInput {
  idempotencyKey: string;
  creditCardNumber: string;
  amount: bigint;
  description: string;
}

export type AuthorizeResult =
  | { status: 'authorized'; authorizationId: string; last4: string }
  | { status: 'declined'; authorizationId: null; last4: string };

export interface CaptureInput {
  idempotencyKey: string;
  authorizationId: string;
  amount: bigint;
}

export type CaptureResult =
  | { status: 'captured'; captureId: string }
  | { status: 'failed'; captureId: null };

export interface VoidInput {
  idempotencyKey: string;
  authorizationId: string;
}

export type VoidResult = { status: 'voided' } | { status: 'failed' };
