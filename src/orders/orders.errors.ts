import { DomainError } from '../common/domain-error.js';
import { OrderState } from './order-state.js';

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

/** Reserved orders must have a warehouse; violations are internal 500s. */
export class ReservedOrderMissingWarehouseError extends Error {
  constructor(readonly orderId: number) {
    super(
      `Order ${orderId} is '${OrderState.Reserved}' but has no warehouse assigned`,
    );
    this.name = new.target.name;
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  constructor(readonly key: string) {
    super(`Idempotency key ${key} was already used with a different payload`);
  }
}

/** Internal signal used to roll back a placement transaction on a key race. */
export class IdempotencyKeyConflict extends Error {
  constructor() {
    super('Order already exists for this idempotency key');
    this.name = new.target.name;
  }
}

export class OrderPaymentDeclinedError extends DomainError {
  constructor(readonly orderId: number) {
    super(
      `Order ${orderId} had its payment declined; it is recorded as '${OrderState.Failed}' ` +
        `and any reserved stock was returned. Retry with a new idempotency key to attempt it again`,
    );
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
        `the order is recorded as '${OrderState.Failed}' and any reserved stock was returned. ` +
        `Retry with a new idempotency key to attempt it again`,
    );
  }
}
