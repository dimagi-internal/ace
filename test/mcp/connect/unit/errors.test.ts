import { describe, it, expect } from 'vitest';
import {
  ConnectError,
  REMEDIATION_ORDER,
  SessionExpiredError,
  ConnectLoginFailedError,
  CsrfTokenMissingError,
  HttpError,
  ConnectValidationError,
  summarizeServerErrorBody,
} from '../../../../mcp/connect/errors.js';

describe('connect errors', () => {
  it('SessionExpiredError points at the auto-login env vars and the manual fallback', () => {
    const err = new SessionExpiredError();
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/ACE_HQ_USERNAME/);
    expect(err.message).toMatch(/ACE_HQ_PASSWORD/);
    expect(err.message).toMatch(/ace:connect-login/);
  });

  it('ConnectLoginFailedError carries the username and stage', () => {
    const err = new ConnectLoginFailedError('ace@dimagi-ai.com', 'hq-creds');
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.username).toBe('ace@dimagi-ai.com');
    expect(err.stage).toBe('hq-creds');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('hq-creds');
    expect(err.message).toContain('ace@dimagi-ai.com');
  });

  it('ConnectLoginFailedError defaults stage to "unknown"', () => {
    const err = new ConnectLoginFailedError('x@y.z');
    expect(err.stage).toBe('unknown');
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

/**
 * dimagi-internal/ace#2172 — a Connect auth failure must never ask a human to
 * log in to Connect.
 *
 * ACE authenticates as a service identity through a headless OAuth-via-CCHQ
 * flow, so every auth failure is self-remediable: re-inject the credential from
 * 1Password and retry. `/ace:connect-login` opens a HEADED browser for a person
 * to sign in, and it used to sit in the message as a co-equal first-line option
 * ("Verify ... in 1Password, or run /ace:connect-login"). A co-equal option is
 * one a reader picks, and the ask landed on Jonathan:
 *
 *   "wait now I'm lost, there is never a rason you should need me to login to
 *    connect."
 *
 * The enforceable property is ORDER, not vocabulary — the string still names
 * `/ace:connect-login`, because it is the correct last resort for a genuinely
 * interactive account. What must hold is that self-remediation comes first and
 * the human ask is for the CREDENTIAL.
 */
describe('ace#2172 — auth failures self-remediate before they escalate', () => {
  it('puts the credential fix BEFORE the human-login last resort', () => {
    const selfServe = REMEDIATION_ORDER.indexOf('/ace:setup --force-env');
    const humanLogin = REMEDIATION_ORDER.indexOf('/ace:connect-login');
    expect(selfServe).toBeGreaterThan(-1);
    expect(humanLogin).toBeGreaterThan(-1);
    expect(
      selfServe < humanLogin,
      'The human-login fallback now precedes (or replaces) the self-remediation ' +
        'step. Order is the whole fix: a reader takes the first actionable option ' +
        'offered, which is how ace#2172 put the ask on a human.',
    ).toBe(true);
  });

  it('names retrying the headless flow, not just rotating the secret', () => {
    // Re-injecting .env without retrying leaves the caller stuck; and without a
    // restart the MCP subprocess keeps the stale env (CLAUDE.md § MCP restart).
    expect(REMEDIATION_ORDER).toMatch(/retry/i);
    expect(REMEDIATION_ORDER).toMatch(/headless/i);
    expect(REMEDIATION_ORDER).toMatch(/restart/i);
  });

  it('forbids asking a person to authenticate on ACE\'s behalf, in words', () => {
    // The ordering above is the mechanism; this is the rule stated outright, so
    // a model reading the error cannot infer the human ask is merely later.
    expect(REMEDIATION_ORDER).toMatch(/Do NOT ask a human to log in to Connect/);
  });

  it('does NOT delete the interactive last resort', () => {
    // Over-correcting to "never mention /ace:connect-login" would strand a real
    // SSO/MFA account with no path at all. It must survive, demoted.
    expect(REMEDIATION_ORDER).toMatch(/last\s+resort/i);
    expect(REMEDIATION_ORDER).toMatch(/SSO\/MFA/);
  });

  it('reaches BOTH auth error classes, not just the one that was reported', () => {
    // SessionExpiredError carried the identical co-equal phrasing. Fixing only
    // ConnectLoginFailedError would leave the same ask on the other path.
    expect(new ConnectLoginFailedError('ace@dimagi-ai.com', 'hq-creds').message).toContain(
      REMEDIATION_ORDER,
    );
    expect(new SessionExpiredError().message).toContain(REMEDIATION_ORDER);
  });
});
