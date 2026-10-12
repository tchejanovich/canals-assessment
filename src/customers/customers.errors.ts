import { DomainError } from '../common/domain-error.js';

export class CustomerNameMismatchError extends DomainError {
  constructor(readonly email: string) {
    super(`Name does not match the existing customer for email ${email}`);
  }
}

export class CustomerPhoneMismatchError extends DomainError {
  constructor(readonly email: string) {
    super(`Phone does not match the existing customer for email ${email}`);
  }
}
