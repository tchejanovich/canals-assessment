import { HttpException, HttpStatus } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import { DomainError } from '../common/domain-error.js';
import { ValidationError } from '../common/validation-error.js';
import {
  AddressConflictError,
  UnknownCountryError,
  UnknownRegionError,
} from '../addresses/addresses.errors.js';
import { InsufficientStockError } from '../inventory/inventory.errors.js';
import {
  CustomerNotFoundError,
  IdempotencyKeyReusedError,
  MixedCurrencyError,
  NoFulfillingWarehouseError,
  OrderNotFoundError,
  OrderPaymentDeclinedError,
  OrderVanishedError,
  PaymentCaptureFailedError,
  PaymentDeclinedError,
  ProductNotFoundError,
  ProductUnavailableError,
  UnfulfilledOrderError,
} from './orders.errors.js';

/** Maps domain errors to HTTP statuses at the controller boundary. */
const STATUS_BY_ERROR = new Map<Function, HttpStatus>([
  [ValidationError, HttpStatus.BAD_REQUEST],
  [ProductUnavailableError, HttpStatus.BAD_REQUEST],
  [MixedCurrencyError, HttpStatus.BAD_REQUEST],
  [UnknownCountryError, HttpStatus.BAD_REQUEST],
  [UnknownRegionError, HttpStatus.BAD_REQUEST],
  [CustomerNotFoundError, HttpStatus.NOT_FOUND],
  [OrderNotFoundError, HttpStatus.NOT_FOUND],
  [ProductNotFoundError, HttpStatus.NOT_FOUND],
  [UnfulfilledOrderError, HttpStatus.CONFLICT],
  [OrderVanishedError, HttpStatus.CONFLICT],
  [IdempotencyKeyReusedError, HttpStatus.CONFLICT],
  [AddressConflictError, HttpStatus.CONFLICT],
  [InsufficientStockError, HttpStatus.CONFLICT],
  [OrderPaymentDeclinedError, HttpStatus.PAYMENT_REQUIRED],
  [PaymentDeclinedError, HttpStatus.PAYMENT_REQUIRED],
  [PaymentCaptureFailedError, HttpStatus.PAYMENT_REQUIRED],
  [NoFulfillingWarehouseError, HttpStatus.UNPROCESSABLE_ENTITY],
]);

/** Maps domain errors to a consistent response; unexpected errors pass through as 500s. */
export function toHttpException(error: unknown): HttpException {
  if (!(error instanceof DomainError)) {
    throw error;
  }

  const status =
    STATUS_BY_ERROR.get(error.constructor) ?? HttpStatus.INTERNAL_SERVER_ERROR;

  return new HttpException(
    {
      statusCode: status,
      error: STATUS_CODES[status] ?? 'Error',
      message: error.message,
      ...(error instanceof ValidationError ? { errors: error.issues } : {}),
    },
    status,
  );
}
