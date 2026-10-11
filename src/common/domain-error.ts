/**
 * Base class for business-rule violations raised by the domain/service layer.
 *
 * Domain errors deliberately carry no transport concern: they know what rule
 * was broken, not which HTTP status represents it. Translating an error into a
 * response is the job of the controller edge, which keeps services decoupled
 * from Nest's HTTP exceptions.
 */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
