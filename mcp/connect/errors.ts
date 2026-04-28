export class ConnectError extends Error {
  retryable = false;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class SessionExpiredError extends ConnectError {
  constructor() {
    super('Connect session expired. Run `/ace:connect-login` to re-authenticate.');
  }
}

export class CsrfTokenMissingError extends ConnectError {
  retryable = true;
  constructor() {
    super('CSRF token missing or stale; refetching.');
  }
}

export class HttpError extends ConnectError {
  constructor(public status: number, public path: string, public body: string) {
    super(`HTTP ${status} ${path}: ${body.slice(0, 200)}`);
    this.retryable = status >= 500 || status === 429;
  }
}

export class ConnectValidationError extends ConnectError {
  constructor(public validationErrors: string[]) {
    super(`Connect rejected request: ${validationErrors.join('; ')}`);
  }
}
