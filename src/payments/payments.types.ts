import { PaymentStatus } from './payment-status.js';

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

/** Input for processing an order's complete authorization/capture lifecycle. */
export interface ProcessOrderPaymentInput {
  orderId: number;
  amount: bigint;
  creditCardNumber: string;
  description: string;
}

/** Final payment outcome returned to the order workflow. */
export type OrderPaymentResult =
  | {
      status: typeof PaymentStatus.Captured;
      captureId: string;
      capturedAt: Date;
    }
  | { status: typeof PaymentStatus.Declined }
  | { status: typeof PaymentStatus.Failed };
