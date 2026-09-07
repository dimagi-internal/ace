export class ConnectError extends Error {
  retryable = false;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * The ORDER in which a human is asked for help on a Connect auth failure.
 *
 * ACE authenticates to Connect as a service identity (`ACE_HQ_USERNAME` /
 * `ACE_HQ_PASSWORD`, 1Password vault `Agent-Ace`) through a HEADLESS
 * OAuth-via-CCHQ flow. Every ingredient for self-remediation is therefore
 * already on the machine, and the agent can run it unattended.
 *
 * `/ace:connect-login` is the opposite: it opens a HEADED Playwright browser
 * so a PERSON can sign in. It is a real last resort for an account that
 * genuinely requires interactive auth — but it was previously offered as a
 * co-equal first-line option ("Verify ... in 1Password, or run
 * /ace:connect-login"), and a co-equal option is one a reader picks. The ask
 * then lands on a human for a failure the agent could have fixed itself.
 *
 *   Jon, on receiving exactly that ask: "wait now I'm lost, there is never a
 *   rason you should need me to login to connect."
 *
 * So the string is ordered, not merely worded: self-remediate, retry, and only
 * then escalate — and the escalation asks for the CREDENTIAL to be repaired,
 * never for a person to authenticate on ACE's behalf. dimagi-internal/ace#2172.
 *
 * Note `/ace:setup --force-env`, never a raw `op inject` — the latter drops
 * local-only keys (CLAUDE.md § Auth model). And a `.env` rewrite needs a full
 * Claude Code restart before a running MCP subprocess sees it, which is why
 * the restart is named here rather than left to be rediscovered.
 */
export const REMEDIATION_ORDER =
  'Self-remediate first, in this order: (1) re-inject the HQ credentials from ' +
  '1Password with `/ace:setup --force-env` (NOT a raw `op inject`, which drops ' +
  'local-only keys), then fully restart Claude Code so the MCP subprocess picks ' +
  'up the new .env; (2) retry the call, which re-runs the headless ' +
  'OAuth-via-CCHQ login. Only if that still fails, escalate — and escalate to ' +
  'get the CREDENTIAL fixed (wrong/rotated/locked account in the Agent-Ace ' +
  'vault). Do NOT ask a human to log in to Connect on ACE\'s behalf: ACE ' +
  'authenticates as a service identity and the headless flow needs no person. ' +
  '`/ace:connect-login` opens a browser for a human to sign in and is the last ' +
  'resort for an account that truly requires interactive SSO/MFA — not a ' +
  'first-line alternative to fixing the credential.';

export class SessionExpiredError extends ConnectError {
  constructor() {
    super(
      'Connect session expired and ACE_HQ_USERNAME/ACE_HQ_PASSWORD are not set. ' +
        REMEDIATION_ORDER,
    );
  }
}

/**
 * Connect HQ-OAuth auto-login was attempted with credentials but failed.
 *
 * `stage` distinguishes WHERE in the OAuth dance it broke:
 *   - `hq-creds`: HQ rejected the username/password (still on HQ login form
 *     after submit) — almost always a wrong-creds issue.
 *   - `oauth-consent`: HQ accepted creds and redirected to /oauth/authorize/
 *     but the consent click never returned to Connect — selector drift, or
 *     a new consent screen.
 *   - `unknown`: pre-existing flow break before we could classify it.
 *
 * Distinguished from `SessionExpiredError` so callers can tell "you have no
 * creds configured" from "your creds are wrong" — the fix differs.
 */
export class ConnectLoginFailedError extends ConnectError {
  constructor(
    public username: string,
    public stage: 'hq-creds' | 'oauth-consent' | 'unknown' = 'unknown',
  ) {
    super(
      `Connect HQ-OAuth login failed at stage "${stage}" for ${username}. ` +
        REMEDIATION_ORDER,
    );
  }
}

export class CsrfTokenMissingError extends ConnectError {
  retryable = true;
  constructor() {
    super('CSRF token missing or stale; refetching.');
  }
}

export class HttpError extends ConnectError {
  constructor(
    public status: number,
    public path: string,
    public body: string,
    public contentType?: string,
  ) {
    const summary =
      status >= 500 ? summarizeServerErrorBody(body, contentType) : body.slice(0, 200);
    super(`HTTP ${status} ${path}: ${summary}`);
    this.retryable = status >= 500 || status === 429;
  }
}

/**
 * Extract a useful summary from a Connect server-error response body.
 *
 * Background: when Connect (Django) returns 5xx, the body is typically a
 * large HTML page — a debug stack trace in dev, a generic "Server Error
 * (500)" page in prod, sometimes a Sentry event id embedded in JS init.
 * Slicing the first 200 chars of that body (the previous behavior of
 * `HttpError`) shows `<!DOCTYPE html><html><head>...` and is useless for
 * triage. This helper digs out the parts a human or agent actually wants
 * to see in the error message.
 *
 * Order of attempts:
 *   1. JSON error body (`detail` / `error` / `message` field)
 *   2. Django DEBUG=True page — `<pre class="exception_value">…</pre>`
 *      plus `Exception Type` cell from the technical-500 template
 *   3. `<title>`, `<h1>`, and Sentry event id from a generic 500 page
 *   4. Plain-text fallback (strip tags, collapse whitespace)
 *
 * Output is capped at ~300 chars so it stays readable in MCP tool errors
 * and surfaces in the agent's transcript without dwarfing the message.
 */
export function summarizeServerErrorBody(body: string, contentType?: string): string {
  if (!body) return '(empty body)';
  const trimmed = body.trim();

  // 1. JSON
  const looksJson =
    contentType?.toLowerCase().includes('application/json') ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'));
  if (looksJson) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const detail = obj.detail ?? obj.error ?? obj.message;
      if (typeof detail === 'string' && detail) return detail.slice(0, 300);
      return JSON.stringify(obj).slice(0, 300);
    } catch {
      /* fall through to HTML heuristics */
    }
  }

  // 2. Django DEBUG=True technical-500 page
  const excValue = body.match(
    /<pre[^>]*class=["']exception_value["'][^>]*>([\s\S]*?)<\/pre>/,
  );
  if (excValue) {
    const exc = stripTags(excValue[1]).trim();
    const excType = body.match(
      /<th>\s*Exception Type:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/,
    );
    const type = excType ? stripTags(excType[1]).trim() : '';
    return (type ? `${type}: ${exc}` : exc).slice(0, 300);
  }

  // 3. Generic 500 page — title + h1 + sentry id
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : '';
  const h1Match = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = h1Match ? stripTags(h1Match[1]).trim() : '';
  const sentryMatch = body.match(
    /sentry[-_]?event[-_]?id["']?\s*[:=]\s*["']?([a-f0-9]{16,})/i,
  );

  const parts: string[] = [];
  if (title) parts.push(title);
  if (h1 && h1 !== title) parts.push(h1);
  if (sentryMatch) parts.push(`sentry=${sentryMatch[1].slice(0, 32)}`);

  if (parts.length > 0) return parts.join(' | ').slice(0, 300);

  // 4. Last-resort plain-text strip
  return stripTags(body).replace(/\s+/g, ' ').trim().slice(0, 200) || '(unparseable body)';
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

/**
 * The server returned a 302 success-redirect for a write, but a follow-up
 * read confirmed the entity was not persisted. Connect's payment_unit/create
 * is the canonical case: a missing-or-malformed required form field
 * (e.g. unmapped `required_deliver_units` checkbox value) yields a 302 to
 * the opp detail page with a Django-messages "Invalid Data" cookie and
 * **no created object**. Retrying with identical args reproduces the
 * silent drop deterministically — there is nothing transient about it.
 *
 * Non-retryable. The agent should surface diagnostics (form fields posted,
 * available checkbox-value mapping) and either fix the args or fall back
 * to the documented Playwright workaround. See
 * `skills/connect-opp-setup/SKILL.md § payment_unit silent drop`.
 *
 * Added 2026-04-30 after the turmeric e2e session retried 3× on this exact
 * shape, blocking Phase 4 for ~5 minutes before the agent gave up.
 */
export class ConnectSilentRejectError extends ConnectError {
  retryable = false;
  constructor(
    public path: string,
    public posted: Record<string, string | string[]>,
    public diagnostics: string,
  ) {
    super(
      `Connect ${path} silently rejected the create: 302 redirect with no persisted entity. ` +
        `This is non-retryable — same args will reproduce. ${diagnostics}`,
    );
  }

  toJSON(): {
    error: 'silent_reject';
    message: string;
    path: string;
    posted: Record<string, string | string[]>;
    retryable: false;
  } {
    return {
      error: 'silent_reject',
      message: this.message,
      path: this.path,
      posted: this.posted,
      retryable: false,
    };
  }
}

/**
 * A requested verification flag has no corresponding input on the LIVE
 * `verification_flags_config/` page, so posting it would enforce nothing
 * (dimagi-internal/ace#1013).
 *
 * Why this is fail-loud rather than a warning: Connect's form silently drops
 * unrecognized POST keys and still redirects 302, so the atom used to return
 * `{ok: true}` for a flag it had not set. Every ACE run from 2026-06-06 to
 * 2026-07-28 reported "verification flags configured" in its Phase 4 summary
 * and its `connect-opp-setup.md`, with `INITIAL_FORMS: 0` on every
 * opportunity — no run had ever persisted one. The artifact was wrong in a
 * way no downstream phase re-checked, and the Work Order promised those
 * checks to a partner.
 *
 * The support test reads the FETCHED PAGE, never a hardcoded list, so the
 * guard relaxes by itself if Connect restores a field — "close the loop to
 * the source of truth" rather than another list to age.
 */
export class UnsupportedVerificationFlagError extends ConnectError {
  retryable = false;
  constructor(
    public path: string,
    public unsupported: { flag: string; expected_input: string }[],
  ) {
    super(
      `Connect's verification form at ${path} has no input for: ` +
        unsupported.map((u) => `${u.flag} (expected input ${u.expected_input})`).join(', ') +
        `. Posting these would be dropped server-side and this atom would still ` +
        `return ok — so they are refused instead. Per ace#1013 only ` +
        `form_field_rules, form_submission_start/end and the per-deliver-unit ` +
        `duration are backed by live fields; form_field_rules is the ONLY ` +
        `surface that enforces a PDD Evidence-Model Layer A predicate ` +
        `server-side. Drop the unsupported flags (or express the intent as a ` +
        `form_field_rules rule) and re-run.`,
    );
  }

  toJSON(): {
    error: 'unsupported_verification_flag';
    message: string;
    path: string;
    unsupported: { flag: string; expected_input: string }[];
    retryable: false;
  } {
    return {
      error: 'unsupported_verification_flag',
      message: this.message,
      path: this.path,
      unsupported: this.unsupported,
      retryable: false,
    };
  }
}
