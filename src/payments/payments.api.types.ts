import { PaymentStatus } from './payment-status.js';

export type AuthorizationStatus = Exclude<
  PaymentStatus,
  | typeof PaymentStatus.Authorizing
  | typeof PaymentStatus.Declined
  | typeof PaymentStatus.Failed
>;

export interface AuthorizationRecord {
  amount: bigint;
  last4: string;
  status: AuthorizationStatus;
  captureId: string | null;
}

export interface AuthorizeInput {
  idempotencyKey: string;
  creditCardNumber: string;
  amount: bigint;
  description: string;
}

export type AuthorizeResult =
  | {
      status: typeof PaymentStatus.Authorized;
      authorizationId: string;
      last4: string;
    }
  | {
      status: typeof PaymentStatus.Declined;
      authorizationId: null;
      last4: string;
    };

export interface CaptureInput {
  idempotencyKey: string;
  authorizationId: string;
}

export type CaptureResult =
  | { status: typeof PaymentStatus.Captured; captureId: string }
  | { status: typeof PaymentStatus.Failed; captureId: null };

export interface VoidInput {
  idempotencyKey: string;
  authorizationId: string;
}

export type VoidResult =
  | { status: typeof PaymentStatus.Voided }
  | { status: typeof PaymentStatus.Failed };
