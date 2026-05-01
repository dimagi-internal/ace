export class OcsError extends Error {
  retryable = false;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class SessionExpiredError extends OcsError {
  constructor() {
    super(
      'OCS session expired and OCS_USERNAME/OCS_PASSWORD are not set. ' +
        'Configure them via /ace:setup, or run /ace:ocs-login for SSO/MFA accounts.',
    );
  }
}

export class OcsLoginFailedError extends OcsError {
  constructor(public username: string) {
    super(
      `OCS auto-login failed for ${username}. ` +
        'Verify OCS_USERNAME / OCS_PASSWORD in 1Password, or run /ace:ocs-login if the account requires SSO/MFA.',
    );
  }
}

export class CsrfTokenMissingError extends OcsError {
  retryable = true;
  constructor() {
    super('CSRF token missing or stale; refetching.');
  }
}

export class PipelineShapeError extends OcsError {
  constructor(message: string) {
    super(`Pipeline shape invariant violated: ${message}`);
  }
}

export class PipelineValidationError extends OcsError {
  constructor(public validationErrors: string[]) {
    super(`Pipeline save rejected: ${validationErrors.join('; ')}`);
  }
}

export class CollectionIndexingTimeoutError extends OcsError {
  constructor(public collectionId: number, public timeoutSec: number) {
    super(`Collection ${collectionId} indexing timed out after ${timeoutSec}s`);
  }
}

export class HttpError extends OcsError {
  constructor(public status: number, public path: string, public body: string) {
    super(`HTTP ${status} ${path}: ${body.slice(0, 200)}`);
    this.retryable = status >= 500 || status === 429;
  }
}
