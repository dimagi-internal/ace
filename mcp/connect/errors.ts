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
 * shape, blocking Phase 3 for ~5 minutes before the agent gave up.
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
