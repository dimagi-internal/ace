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

/**
 * Connect rejected a form post with Django form-validation errors.
 *
 * `validationErrors` is the flat list (legacy callers and human messages).
 * `fieldErrors` (when present) is the structured map keyed by Django field name
 * — e.g. `{ api_key: ['Select a valid choice…'], hq_server: ['Required'] }`.
 *
 * Agents and skills should prefer `fieldErrors` so they can react to specific
 * fields (e.g. "api_key wasn't a valid int FK → call connect_register_hq_api_key
 * first") rather than scraping prose out of the joined message.
 */
export class ConnectValidationError extends ConnectError {
  public fieldErrors?: Record<string, string[]>;
  constructor(
    public validationErrors: string[],
    fieldErrors?: Record<string, string[]>,
  ) {
    super(`Connect rejected request: ${validationErrors.join('; ')}`);
    if (fieldErrors && Object.keys(fieldErrors).length > 0) {
      this.fieldErrors = fieldErrors;
    }
  }

  /** Structured payload for MCP responses. */
  toJSON(): {
    error: 'validation_error';
    message: string;
    errors: string[];
    fields?: Record<string, string[]>;
  } {
    return {
      error: 'validation_error',
      message: this.message,
      errors: this.validationErrors,
      ...(this.fieldErrors ? { fields: this.fieldErrors } : {}),
    };
  }
}
