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

/**
 * Thrown when an authenticated HTML scrape lands on OCS's sign-in page instead
 * of the page it asked for (ace#1767).
 *
 * OCS answers an unauthenticated GET with a 302 to
 * `/accounts/login/?next=<path>`. Playwright's request API FOLLOWS that by
 * default, so the caller sees `status 200, ok true` for a perfectly rendered
 * sign-in form — and every downstream scrape then misses its selector and
 * reports the miss as a *content* problem: "flag `flag_chat_widget` may be
 * off", "lists no embedded_widget channel button". Both blame a feature flag
 * or a broken clone for what is a dead cookie.
 *
 * The cost of that misattribution is not cosmetic. `bin/ace-doctor`'s
 * `ocs_generation` preflight reported `status: fail, class: unknown` with the
 * feature-flag message, and `fail` HALTS `/ace:run` before Phase 1 (ace#1516)
 * while sending the operator at a provider key that was healthy the whole
 * time. The response's FINAL URL is authoritative about this and costs
 * nothing to read.
 */
export class OcsAuthRedirectError extends OcsError {
  constructor(public path: string, public finalUrl: string) {
    super(
      `GET ${path} was redirected to the OCS sign-in page (${finalUrl}). ` +
        'The session cookie is missing or expired, so this is an AUTHENTICATION ' +
        'failure, not a missing feature flag or a malformed chatbot. ' +
        'Re-establish the session (OCS_USERNAME/OCS_PASSWORD auto-relogin, or /ace:ocs-login).',
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

/**
 * The chatbots-table page came back 200 with rows on it, but the row parser
 * could not read a single chatbot name out of them — i.e. OCS reshaped the
 * markup the scrape depends on.
 *
 * ace#1561. Before this error existed, `parseChatbotTable` returned whatever
 * it managed to parse with no signal, so an unparseable table was
 * indistinguishable from an empty one. On hh-poverty-targeting/20260819-1435
 * Phase 5, all 72 bots on `connect-ace` came back with `experiment_id: null`
 * and `getChatbot` reported each of them — including a seven-week-old bot — as
 * a freshly-cloned row that had not appeared yet (`ExperimentIdStaleError`),
 * whose remedy ("wait and retry") could never work.
 *
 * The cause was upstream: OCS PR #4220 ("Consistent chip rendering in tables",
 * merged 2026-08-18) changed `templates/generic/action.html` from rendering
 * `{{ label }}` directly inside the `<a>` to `{% include
 * "generic/chip_label.html" %}`, and turned truncation ON for the chatbots
 * table's name chip (`apps/chatbots/tables.py` `ChatbotTable.name`,
 * `truncate=True`). The anchor body became
 * `<span class="min-w-0 truncate" title="NAME">NAME</span>` instead of `NAME`.
 *
 * Sibling of `PipelineShapeError`, which has named the same class of drift on
 * `pipeline_builder.html` since 0.6.x.
 */
export class ChatbotTableShapeError extends OcsError {
  constructor(public detail: string) {
    super(
      `Could not read chatbot names out of the /a/<team>/chatbots/table/ page: ${detail} ` +
        `The request succeeded and the page HAS rows, so this is TEMPLATE DRIFT in OCS, not an ` +
        `empty team and not a stale table — waiting will not fix it. The scrape depends on ` +
        `dimagi/open-chat-studio templates/generic/action.html + generic/chip_label.html ` +
        `(the name chip) and the per-row id="record-<int>" attribute from ` +
        `config/settings.py DJANGO_TABLES2_ROW_ATTRS. Re-derive the parse from the CURRENT ` +
        `upstream template via skills/upstream-regression-triage (ace#1561 was OCS PR #4220). ` +
        `Do NOT clone a new bot to recover — every existing bot is intact; read liveness with ` +
        `ocs_inspect_chatbot (REST v2, scrape-independent) in the meantime.`,
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

/**
 * The widget-channel create POST reported success, but a fresh authoritative
 * read of the channel's edit-dialog says the channel is `enabled=False` — i.e.
 * it was born disabled.
 *
 * ace#1813, the detector for the ace#1492 class.
 *
 * ace#1492: OCS PR #4202 (merged 2026-08-17) added `enabled` to
 * `ChannelForm.Meta.fields`. It is a Django BooleanField rendered as a
 * checkbox, and a checkbox ABSENT from POST data resolves to `False` — the
 * model's `default=True` no longer applies once the ModelForm owns the field.
 * ACE's POST predates that PR, so for two days every channel ACE created was
 * born disabled and `ChannelDisabledStage` dropped every inbound message. The
 * fix (commit 04ae0e47, 2026-08-18) sends `enabled: 'on'`.
 *
 * Why a read-back and not just the write: that literal is one string in a
 * hand-built form POST, and #4202 already demonstrated that upstream can add a
 * second required boolean to the same `Meta.fields` without warning. A rename
 * or a further addition silently reintroduces the class, and OCS PR #4230
 * (merged 2026-08-20) then turns it into a hard door: `_channel_disabled_response()`
 * in `apps/api/views/chat.py` returns `403 {"error": "This chatbot is currently
 * unavailable."}` from `chat_start_session` BEFORE participant creation, so
 * Phase 5 chatbot QA cannot open a session at all. `is_disabled` is
 * `not self.enabled` (`apps/channels/models.py:342-344`).
 *
 * Not detectable via `ocs_inspect_chatbot`: the upstream v2 inspect serializer
 * (`apps/api/v2/inspect/serializers.py` `ChannelSerializer.Meta.fields`) omits
 * both `enabled` and `disabled_message`, so the REST read cannot see this.
 */
export class WidgetChannelDisabledError extends OcsError {
  constructor(public experimentId: number, public channelId: number) {
    super(
      `Widget channel ${channelId} on experiment ${experimentId} was created DISABLED ` +
        `(enabled=False). The create POST returned success, but the channel edit-dialog ` +
        `read-back shows the \`enabled\` checkbox unchecked. This is the ace#1492 class: ` +
        `upstream OCS #4202 made \`enabled\` a ModelForm field, and an omitted Django ` +
        `checkbox posts as False. Since OCS #4230, a disabled channel makes ` +
        `POST /api/chat/start/ return 403 "This chatbot is currently unavailable.", so ` +
        `Phase 5 chatbot QA cannot open a session. Check that ACE's widget-channel POST ` +
        `body in mcp/ocs/backends/playwright.ts still names every boolean field in ` +
        `upstream \`ChannelForm.Meta.fields\` — #4202 added one once already. Re-enable the ` +
        `channel in the OCS UI to unblock the run; fix the POST body to stop it recurring.`,
    );
  }
}

/**
 * The widget channel was created, but ACE could not READ BACK its `enabled`
 * state — the chatbot home page lists no embedded_widget channel, or the
 * edit-dialog no longer renders a recognisable `enabled` checkbox.
 *
 * Loud on purpose (ace#1813). An unreadable state is treated as a FAILED write
 * rather than a passing one, because the two causes coincide: the same upstream
 * rename that makes the checkbox unfindable in the edit-dialog also makes
 * ACE's `enabled: 'on'` POST key wrong, which means the channel really is
 * disabled. Reporting "verified" here would recreate exactly the silent class
 * this read-back exists to end.
 *
 * Remedy: re-derive both the POST body and this parse from the CURRENT upstream
 * templates via `skills/upstream-regression-triage` — `apps/channels/forms.py`
 * (`ChannelForm.Meta.fields`) and `templates/django/forms/widgets/input.html`.
 */
export class WidgetChannelStateUnreadableError extends OcsError {
  constructor(
    public experimentId: number,
    public channelId: number | undefined,
    public detail: string,
  ) {
    super(
      `Could not read back the \`enabled\` state of the widget channel just created on ` +
        `experiment ${experimentId}${channelId === undefined ? '' : ` (channel ${channelId})`}: ${detail} ` +
        `Treating this as a FAILED write, not a pass: the upstream change that hides the ` +
        `checkbox from this parse is the same one that would make ACE's \`enabled: 'on'\` ` +
        `POST key wrong (ace#1492 / OCS #4202), and since OCS #4230 a disabled channel ` +
        `403s POST /api/chat/start/ before Phase 5 QA can open a session. Re-derive the ` +
        `POST body and this parse from the current upstream templates ` +
        `(apps/channels/forms.py ChannelForm.Meta.fields, ` +
        `templates/django/forms/widgets/input.html) via skills/upstream-regression-triage. ` +
        `ocs_inspect_chatbot cannot substitute — its ChannelSerializer omits \`enabled\` ` +
        `(ace#1813).`,
    );
  }
}
