import { describe, it, expect } from 'vitest';
import {
  ConnectError,
  SessionExpiredError,
  CsrfTokenMissingError,
  HttpError,
  ConnectValidationError,
} from '../../../../mcp/connect/errors.js';

describe('connect errors', () => {
  it('SessionExpiredError mentions the connect-login command', () => {
    const err = new SessionExpiredError();
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/connect-login/);
  });

  it('CsrfTokenMissingError is retryable', () => {
    expect(new CsrfTokenMissingError().retryable).toBe(true);
  });

  it('HttpError carries status + path + body and is retryable on 5xx/429', () => {
    expect(new HttpError(503, '/api/foo', 'down').retryable).toBe(true);
    expect(new HttpError(429, '/api/foo', 'slow').retryable).toBe(true);
    expect(new HttpError(404, '/api/foo', 'no').retryable).toBe(false);
    expect(new HttpError(400, '/api/foo', 'bad').message).toMatch(/HTTP 400/);
  });

  it('ConnectValidationError aggregates messages', () => {
    const err = new ConnectValidationError(['name required', 'budget must be positive']);
    expect(err.message).toMatch(/name required/);
    expect(err.message).toMatch(/budget must be positive/);
  });
});
