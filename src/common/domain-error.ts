/** Business-rule error; the controller maps it to an HTTP response. */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
