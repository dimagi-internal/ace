import { describe, it, expect } from 'vitest';
import {
  ConnectError,
  SessionExpiredError,
  CsrfTokenMissingError,
  HttpError,
  ConnectValidationError,
  summarizeServerErrorBody,
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

  it('ConnectValidationError.toJSON omits fields when none are provided', () => {
    const err = new ConnectValidationError(['name required']);
    expect(err.toJSON()).toEqual({
      error: 'validation_error',
      message: err.message,
      errors: ['name required'],
    });
    expect(err.fieldErrors).toBeUndefined();
  });

  it('ConnectValidationError.toJSON includes fields when provided', () => {
    const err = new ConnectValidationError(
      ['Select a valid choice.', 'Enter a valid JSON.'],
      { api_key: ['Select a valid choice.'], learn_app: ['Enter a valid JSON.'] },
    );
    const j = err.toJSON();
    expect(j.error).toBe('validation_error');
    expect(j.fields).toEqual({
      api_key: ['Select a valid choice.'],
      learn_app: ['Enter a valid JSON.'],
    });
    expect(j.errors).toEqual(['Select a valid choice.', 'Enter a valid JSON.']);
  });

  it('ConnectValidationError omits empty fieldErrors map', () => {
    const err = new ConnectValidationError(['x'], {});
    expect(err.fieldErrors).toBeUndefined();
    expect(err.toJSON().fields).toBeUndefined();
  });
});

describe('summarizeServerErrorBody', () => {
  it('returns "(empty body)" for empty input', () => {
    expect(summarizeServerErrorBody('')).toBe('(empty body)');
  });

  it('extracts JSON .detail when content-type is application/json', () => {
    const body = JSON.stringify({ detail: 'IntegrityError: duplicate key value' });
    expect(summarizeServerErrorBody(body, 'application/json')).toBe(
      'IntegrityError: duplicate key value',
    );
  });

  it('extracts JSON .error / .message as fallbacks', () => {
    expect(summarizeServerErrorBody('{"error":"oops"}', 'application/json')).toBe('oops');
    expect(summarizeServerErrorBody('{"message":"nope"}', 'application/json')).toBe('nope');
  });

  it('detects JSON without explicit content-type when body looks like JSON', () => {
    expect(summarizeServerErrorBody('{"detail":"x"}')).toBe('x');
  });

  it('extracts Django technical-500 exception type + value', () => {
    const html = `<!DOCTYPE html><html><head><title>OperationalError at /opportunity/init/</title></head>
      <body>
        <table><tr>
          <th>Exception Type:</th>
          <td>OperationalError</td>
        </tr></table>
        <pre class="exception_value">could not connect to server: Connection refused</pre>
      </body></html>`;
    const summary = summarizeServerErrorBody(html);
    expect(summary).toContain('OperationalError');
    expect(summary).toContain('Connection refused');
  });

  it('extracts <title> from a generic Django 500 page', () => {
    const html = `<!DOCTYPE html><html><head><title>Server Error (500)</title></head>
      <body><h1>Server Error</h1><p>Something broke.</p></body></html>`;
    const summary = summarizeServerErrorBody(html);
    expect(summary).toContain('Server Error (500)');
  });

  it('extracts Sentry event id when present', () => {
    const html = `<html><head><title>Server Error</title></head>
      <body><script>window.sentryEventId = "abc123def456abcd0011223344556677";</script></body></html>`;
    const summary = summarizeServerErrorBody(html);
    expect(summary).toMatch(/sentry=abc123def456abcd/);
  });

  it('caps the summary at ~300 chars to keep tool errors readable', () => {
    const long = 'X'.repeat(2000);
    const html = `<title>${long}</title>`;
    expect(summarizeServerErrorBody(html).length).toBeLessThanOrEqual(300);
  });

  it('falls back to stripped plain text when no structure matches', () => {
    const html = '<div>Just some <b>plaintext</b> content with no markers.</div>';
    const summary = summarizeServerErrorBody(html);
    expect(summary).toContain('Just some');
    expect(summary).toContain('plaintext');
    expect(summary).not.toContain('<');
  });
});

describe('HttpError uses the 5xx summarizer', () => {
  it('5xx body extracts useful info instead of raw HTML head', () => {
    const html =
      '<!DOCTYPE html><html><head><title>Server Error (500)</title></head><body>...</body></html>';
    const err = new HttpError(500, '/a/o/opportunity/init/', html, 'text/html');
    expect(err.message).toContain('Server Error (500)');
    expect(err.message).not.toContain('<!DOCTYPE');
  });

  it('non-5xx body still uses the raw 200-char slice (unchanged behavior)', () => {
    const html = '<!DOCTYPE html><html><head>...';
    const err = new HttpError(404, '/a/o/missing/', html);
    expect(err.message).toContain('<!DOCTYPE');
  });
});
