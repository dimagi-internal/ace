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

/**
 * Thrown when a session endpoint returns 403 `session_token_required` EVEN
 * THOUGH `/api/chat/start/` issued a non-empty `session_token` and we threaded
 * it as `X-Session-Token`. The fixed `sendTestMessage` (jjackson/ace#742,
 * commit c91f5b7) cannot produce this signature — so seeing it means the
 * running ace-ocs MCP subprocess is executing PRE-#742 code that never sent
 * the header. MCP subprocesses bind their module code at subprocess startup
 * and are NOT respawned by `/reload-plugins` or `/ace:update`; only a full
 * Claude Code restart picks up the on-disk fix. This is a self-diagnosis of
 * that stale-subprocess class (jjackson/ace#761), distinguished from a genuine
 * session/auth failure by the "token WAS issued yet still rejected" signature.
 */
export class StaleOcsSubprocessError extends OcsError {
  constructor(public path: string) {
    super(
      `OCS /api/chat/${path} returned 403 session_token_required even though ` +
        `/api/chat/start/ issued a per-session token AND it was threaded as ` +
        `X-Session-Token. The fixed sendTestMessage (jjackson/ace#742, commit ` +
        `c91f5b7) cannot produce this — the running ace-ocs MCP subprocess is ` +
        `executing pre-#742 code. RESTART Claude Code (a full process restart; ` +
        `/reload-plugins and /ace:update do NOT respawn MCP subprocesses). If a ` +
        `restart does NOT clear it, the upstream OCS session-token contract ` +
        `changed again — re-open jjackson/ace#742.`,
    );
  }
}
