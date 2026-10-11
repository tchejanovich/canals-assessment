import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
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
  OrderPaymentDeclinedError,
  OrderVanishedError,
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
  [ProductNotFoundError, HttpStatus.NOT_FOUND],
  [UnfulfilledOrderError, HttpStatus.CONFLICT],
  [OrderVanishedError, HttpStatus.CONFLICT],
  [IdempotencyKeyReusedError, HttpStatus.CONFLICT],
  [AddressConflictError, HttpStatus.CONFLICT],
  [InsufficientStockError, HttpStatus.CONFLICT],
  [OrderPaymentDeclinedError, HttpStatus.PAYMENT_REQUIRED],
  [PaymentDeclinedError, HttpStatus.PAYMENT_REQUIRED],
  [NoFulfillingWarehouseError, HttpStatus.UNPROCESSABLE_ENTITY],
]);

/**
 * Translates a domain error into the equivalent Nest HTTP exception, preserving
 * the framework's standard response body for each status. Non-domain errors
 * (bugs, database failures) are re-thrown untouched so they surface as 500s.
 */
export function toHttpException(error: unknown): HttpException {
  if (!(error instanceof DomainError)) {
    throw error;
  }

  const status =
    STATUS_BY_ERROR.get(error.constructor) ?? HttpStatus.INTERNAL_SERVER_ERROR;

  if (error instanceof ValidationError) {
    return new BadRequestException({
      message: error.message,
      errors: error.issues,
    });
  }

  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return new BadRequestException(error.message);
    case HttpStatus.NOT_FOUND:
      return new NotFoundException(error.message);
    case HttpStatus.CONFLICT:
      return new ConflictException(error.message);
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return new UnprocessableEntityException(error.message);
    default:
      return new HttpException(error.message, status);
  }
}
