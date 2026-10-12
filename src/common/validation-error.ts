import { DomainError } from './domain-error.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Schema validation error carrying the issues returned to the client. */
export class ValidationError extends DomainError {
  constructor(readonly issues: ValidationIssue[]) {
    super('Validation failed');
  }
}
