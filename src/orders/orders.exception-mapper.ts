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
  IdempotencyKeyConflictError,
  MixedCurrencyError,
  NoFulfillingWarehouseError,
  OrderNotFoundError,
  OrderVanishedError,
  PaymentCaptureFailedError,
  PaymentDeclinedError,
  ProductNotFoundError,
  ProductUnavailableError,
  UnfulfilledOrderError,
} from './orders.errors.js';

/**
 * Every business rule has its own domain error; this table is the single place
 * that decides which HTTP status each one maps to. Kept at the controller edge
 * so the domain and service layers never reference HTTP semantics.
 */
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
  [IdempotencyKeyConflictError, HttpStatus.CONFLICT],
  [AddressConflictError, HttpStatus.CONFLICT],
  [InsufficientStockError, HttpStatus.CONFLICT],
  [PaymentDeclinedError, HttpStatus.PAYMENT_REQUIRED],
  [PaymentCaptureFailedError, HttpStatus.PAYMENT_REQUIRED],
  [NoFulfillingWarehouseError, HttpStatus.UNPROCESSABLE_ENTITY],
]);

/**
 * Translates a domain error into an HTTP exception with a single response
 * envelope shared by every business error, so clients parse one shape:
 * `{ statusCode, error, message, errors? }`. Field-level `errors` are only
 * present for a failed schema validation. Non-domain errors (bugs, database
 * failures) are re-thrown untouched so they surface as 500s.
 */
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
