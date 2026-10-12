import { PaymentStatus } from './payment-status.js';

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
      capturedAt: Date | null;
      alreadyCaptured: boolean;
    }
  | { status: typeof PaymentStatus.Declined }
  | { status: typeof PaymentStatus.Voided }
  | { status: typeof PaymentStatus.Failed };
