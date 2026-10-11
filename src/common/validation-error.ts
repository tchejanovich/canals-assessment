import { DomainError } from './domain-error.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * A request body that failed schema validation. Carries the individual issues
 * so the controller can surface them alongside the mapped 400.
 */
export class ValidationError extends DomainError {
  constructor(readonly issues: ValidationIssue[]) {
    super('Validation failed');
  }
}
