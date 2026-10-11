export interface ChargeInput {
  creditCardNumber: string;
  amount: bigint;
  description: string;
}

export interface ChargeResult {
  approved: boolean;
  transactionId: string;
}
