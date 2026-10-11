import { DomainError } from '../common/domain-error.js';

export class InsufficientStockError extends DomainError {
  constructor(readonly productId: number) {
    super(`Insufficient stock for product ${productId}`);
  }
}
