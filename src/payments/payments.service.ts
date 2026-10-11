import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChargeInput, ChargeResult } from './payments.types.js';

@Injectable()
export class PaymentsService {
  async charge(input: ChargeInput): Promise<ChargeResult> {
    const digits = input.creditCardNumber.replace(/\D/g, '');
    const approved = !digits.endsWith('0000') && input.amount > 0n;
    return { approved, transactionId: randomUUID() };
  }
}
