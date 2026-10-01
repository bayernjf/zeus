/**
 * Semantic classification for domain failures.
 *
 * The HTTP layer has to turn a thrown value into a status code. Deciding that
 * by regex over the message is a coupling: rewriting "unknown department" as
 * "no such department" silently turns a 404 into a 400, and nothing fails until
 * someone notices in production. Carrying the class on the error makes the
 * mapping a property of the type, and a message edit is then just a message
 * edit.
 *
 * The vocabulary stays transport-neutral on purpose: domains name what went
 * wrong, the HTTP layer decides what that is worth. `domain-error` lives in util
 * so every domain can use it without importing anything from the interface layer.
 */
export type DomainErrorKind =
  | 'not-found'   // the referenced thing does not exist
  | 'conflict'    // the request contradicts current state
  | 'invalid'     // the request itself is malformed
  | 'gate';       // a precondition gate refused (onboarding commission)

export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(message: string, kind: DomainErrorKind = 'invalid') {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
  }
}
