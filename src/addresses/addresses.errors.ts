import { DomainError } from '../common/domain-error.js';

export class UnknownCountryError extends DomainError {
  constructor(readonly countryCode: string) {
    super(`Unknown country ${countryCode}`);
  }
}

export class UnknownRegionError extends DomainError {
  constructor(readonly regionCode: string) {
    super(`Unknown region ${regionCode}`);
  }
}

export class AddressConflictError extends DomainError {
  constructor() {
    super('Address could not be stored despite a stable fingerprint');
  }
}
