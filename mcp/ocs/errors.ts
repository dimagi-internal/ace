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

/**
 * The version PUBLISH succeeded, but the `Version N` badge could not be read
 * back off the chatbot home page (dimagi-internal/ace#891).
 *
 * This is deliberately NOT an HttpError. The publish POST already returned its
 * 302 several lines earlier — the failure is in a *separate confirmation GET*,
 * so the operation the caller asked for demonstrably worked and only the
 * read-back of its version number did not. Conflating the two produced the
 * defect this class exists to end: ACE hard-failed mid-Phase-5 on a chatbot
 * that was correctly published, and the two natural reactions were both wrong
 * (re-publish mints a spurious version; halt kills a healthy run).
 *
 * Carries what the composite backend needs to answer the question
 * authoritatively via the API instead of the markup. #823's invariant still
 * holds: never invent a version number — if the API cannot answer either, this
 * still surfaces.
 */
export class VersionBadgeUnreadableError extends OcsError {
  constructor(
    public experimentId: number,
    public publicId: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thrown by the composite `getChatbot` when the REST payload carries no
 * integer `experiment_id` (live OCS returns the UUID-keyed API `url`, so the
 * URL parser always yields null) AND the chatbots-table enrichment scrape
 * itself failed. Loud on purpose (dimagi-internal/ace#1028): a silently
 * swallowed scrape failure returns `experiment_id: null` on exactly the read
 * path resume idempotency depends on, and the caller's natural — and
 * documented-forbidden — recovery is cloning a duplicate bot.
 */
export class ExperimentIdEnrichmentError extends OcsError {
  constructor(public chatbotName: string, public cause: unknown) {
    super(
      `getChatbot: experiment_id enrichment scrape failed for "${chatbotName}" — ` +
        `the REST payload carries no integer id and the chatbots-table scrape errored ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Likely an expired OCS Playwright session: run /ace:ocs-login and retry. ` +
        `Do NOT clone a new bot to recover — the existing bot is intact.`,
    );
  }
}

/**
 * The scrape SUCCEEDED but does not yet list a bot that REST says is on the
 * default team — i.e. a stale table, not honest absence.
 *
 * ace#1451. `getChatbot` had three branches: scrape throws (loud, ace#1028),
 * scrape has the name (enriched), scrape lacks the name (null, commented as
 * "honest absence — e.g. the bot lives on a non-default team"). That third
 * branch also swallowed a STALE scrape: a freshly-cloned bot is not yet in the
 * chatbots table, so a default-team bot took the non-default-team path. Live on
 * bednet-check-2-visit/20260814-2019 Phase 5, `experiment_id` was null at t0
 * and 12948 ~7 minutes later, same call, nothing changed.
 *
 * The null is what makes it dangerous rather than merely wrong. `ocs-setup`'s
 * Resumption Contract designates this exact read authoritative, and the stale
 * window is precisely the window in which resume fires — a run that dies
 * between `ocs_clone_chatbot` and the Step 11 state write leaves a live bot and
 * no state file. The resuming agent reads null, cannot drive any authoring
 * atom, and the natural recovery is the duplicate clone that ace#1017 and
 * ace#1028 both forbid. ace#1028's own rationale applies verbatim; it just did
 * not cover this branch.
 */
export class ExperimentIdStaleError extends OcsError {
  constructor(public chatbotName: string, public publicId: string) {
    super(
      `getChatbot: "${chatbotName}" (${publicId}) IS on the default team per REST, but the ` +
        `chatbots-table scrape does not list it yet, so experiment_id cannot be resolved. ` +
        `This is a STALE scrape, not absence — a freshly-cloned bot takes minutes to appear ` +
        `in that table (observed ~7 on ace#1451). Wait and retry the same call; the id ` +
        `materialises on its own. Do NOT clone a new bot to recover — the existing bot is ` +
        `intact, and a duplicate is what ace#1017 and ace#1028 exist to prevent.`,
    );
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
