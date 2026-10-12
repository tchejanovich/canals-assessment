import { DomainError } from '../common/domain-error.js';
import { OrderState } from './order-state.js';

export class CustomerNotFoundError extends DomainError {
  constructor(readonly customerId: number) {
    super(`Customer ${customerId} not found`);
  }
}

export class ProductNotFoundError extends DomainError {
  constructor(readonly productId: number) {
    super(`Product ${productId} not found`);
  }
}

export class OrderNotFoundError extends DomainError {
  constructor(readonly orderId: number) {
    super(`Order ${orderId} not found`);
  }
}

export class ProductUnavailableError extends DomainError {
  constructor(readonly productId: number) {
    super(`Product ${productId} is not available`);
  }
}

export class MixedCurrencyError extends DomainError {
  constructor() {
    super('All products in an order must share the same currency');
  }
}

export class NoFulfillingWarehouseError extends DomainError {
  constructor() {
    super('No single warehouse can fulfil the entire order');
  }
}

export class UnfulfilledOrderError extends DomainError {
  constructor(readonly orderId: number) {
    super(
      `Order ${orderId} could not be fulfilled (stock ran out at every nearby warehouse during reservation). ` +
        `It is recorded with state '${OrderState.Created}', no stock was reserved and nothing was charged. ` +
        `Retry with a new idempotency key to attempt it again`,
    );
  }
}

export class OrderVanishedError extends DomainError {
  constructor(readonly orderId: number) {
    super(`Order ${orderId} disappeared before it could be reserved`);
  }
}

/**
 * Internal invariant violation, not a business rule: a `reserved` order always
 * carries the warehouse that won its stock race, so a missing warehouse means
 * the row is inconsistent (a bug or corruption). Deliberately NOT a
 * `DomainError`, so it is never mapped to a `4xx`: it propagates as a `500` and
 * is logged with a stack trace instead of being reported to the client as a
 * retryable conflict.
 */
export class ReservedOrderMissingWarehouseError extends Error {
  constructor(readonly orderId: number) {
    super(
      `Order ${orderId} is '${OrderState.Reserved}' but has no warehouse assigned`,
    );
    this.name = new.target.name;
  }
}

export class IdempotencyKeyConflictError extends DomainError {
  constructor(readonly key: string) {
    super(`Idempotency key ${key} has already been used`);
  }
}

export class PaymentDeclinedError extends DomainError {
  constructor() {
    super('Payment was declined');
  }
}

export class PaymentCaptureFailedError extends DomainError {
  constructor(readonly orderId: number) {
    super(
      `Order ${orderId} authorized but its payment capture failed; the authorization was released, ` +
        `the order is recorded as '${OrderState.Cancelled}' and any reserved stock was returned. ` +
        `Retry with a new idempotency key to attempt it again`,
    );
  }
}
