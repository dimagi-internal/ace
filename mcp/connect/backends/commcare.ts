import type { APIRequestContext, APIResponse } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { PlaywrightSession } from '../auth/playwright-session.js';
import { SessionExpiredError, summarizeServerErrorBody } from '../errors.js';

/**
 * CommCare HQ atoms — release apps that Nova uploaded as drafts.
 *
 * These talk to www.commcarehq.org (NOT connect.dimagi.com) but share the
 * Playwright session with the Connect backend: the OAuth-via-CCHQ login
 * flow that authenticates Connect leaves valid CCHQ cookies in the same
 * BrowserContext, so a single APIRequestContext drives both services.
 *
 * **Auth lifecycle (added 0.13.8).** CCHQ cookies expire on a separate
 * clock from connect.dimagi.com cookies, so this backend takes a
 * `PlaywrightSession` reference (not a bare APIRequestContext) and pulls
 * a fresh `request` from it on every call. Each mutating call is wrapped
 * in `runWithSessionRetry`: if the response is a 302 to `/login/`, the
 * session is invalidated (drops cached context + on-disk state), a fresh
 * `getContext()` triggers full hqOAuthLogin, and the call is retried
 * once. Without this, mid-session expiry surfaces as an opaque "302" to
 * the operator with no recovery path (turmeric-20260505-1024).
 *
 * Endpoint contracts verified live 2026-04-29 + 2026-04-30 against
 * connect-ace-prod (see scripts/probe-cchq-release.ts and
 * skills/app-release/SKILL.md § Endpoints).
 */

export interface CommCareBackendOptions {
  baseUrl: string;
  session: PlaywrightSession;
  /**
   * HQ username + API key for endpoints that require `Authorization: ApiKey`
   * auth (Tastypie resources without `allow_session_auth=True` — e.g.
   * `lookup_table`, `lookup_table_item`, `user`). Optional; atoms that
   * need it throw a typed error if these are missing at call time.
   * Read from .env (ACE_HQ_USERNAME / ACE_HQ_API_KEY) by the server bootstrap.
   */
  hqUsername?: string;
  hqApiKey?: string;
}

export interface CreateDomainArgs {
  /**
   * Human-readable project name. CCHQ's DomainRegistrationForm caps this
   * at 25 chars (`max_name_length` in
   * corehq/apps/registration/forms.py). The slug is auto-derived by HQ
   * from this value (lowercase + sanitize), so for predictable results
   * pass an already-slug-shaped string (lowercase, hyphens, no spaces).
   */
  hr_name: string;
  /** Optional organization id; passed as the hidden `org` form field. */
  org?: string;
}

export interface CreateDomainResult {
  /** The final URL slug HQ chose for the domain (e.g. `ace-interviews-test`). */
  domain: string;
}

export interface LinkDomainsArgs {
  /** Slug of the upstream/master domain. Caller must have access here. */
  upstream_domain: string;
  /** Slug of the downstream domain to attach. Caller must have access here too. */
  downstream_domain: string;
}

export interface LinkDomainsResult {
  upstream_domain: string;
  downstream_domain: string;
  /** Server-reported view-model of the new link (id, last_update, etc.). Shape is HQ-internal. */
  domain_link?: Record<string, unknown>;
}

export interface MakeBuildArgs {
  domain: string;
  app_id: string;
  comment?: string;
}

export interface LookupTableField {
  /** Column name (e.g. "cohort_id", "next_interview"). */
  field_name: string;
  /** Sub-property names. Empty list [] for plain string columns. */
  properties?: string[];
}

export interface LookupTable {
  /** UUID hex (no dashes). */
  id: string;
  /** "Name" the team uses (e.g. "interview_schedule"). */
  tag: string;
  is_global: boolean;
  fields: LookupTableField[];
  item_attributes: string[];
}

export interface CommCareCase {
  case_id: string;
  case_type: string;
  case_name: string;
  date_opened: string;
  date_modified: string;
  closed: boolean;
  /** All non-system case properties (the dynamic property bag). */
  properties: Record<string, unknown>;
  user_id?: string;
  owner_id?: string;
}

export interface GetCaseArgs {
  domain: string;
  case_id: string;
}

export interface Connection {
  id: number;
  name: string;
  url: string;
  notify_addresses: string;
  used_by: string;
  edit_url: string;
}

export interface ListConnectionsArgs {
  domain: string;
  limit?: number;
}

/**
 * Auth type for a CommCare HQ Connection. Maps to corehq/motech/auth.py:
 *   - 'none'        — no auth
 *   - 'basic'       — basic auth (username + password)
 *   - 'digest'      — digest auth
 *   - 'bearer'      — bearer token
 *   - 'oauth1'      — OAuth1
 *   - 'oauth2_pwd'  — OAuth2 password grant
 *   - 'oauth2_client'— OAuth2 client-credentials
 *   - 'api_key'     — API key in header (the common one for Connect Interviews → Connect / OCS)
 */
export type ConnectionAuthType =
  | 'none' | 'basic' | 'digest' | 'bearer'
  | 'oauth1' | 'oauth2_pwd' | 'oauth2_client' | 'api_key';

export type RepeaterType =
  | 'FormRepeater'             // forwards every form submission
  | 'CaseRepeater'             // forwards every case action
  | 'FormExpressionRepeater'   // UCR-filtered form forward (Connect Interviews uses this)
  | 'CaseExpressionRepeater'   // UCR-filtered case forward
  | 'ConnectFormRepeater';     // forwards form to Connect platform

export interface CreateRepeaterArgs {
  domain: string;
  repeater_type: RepeaterType;
  /** FK to a Connection (see commcare_list_connections / commcare_create_connection). */
  connection_settings_id: number;
  /** Optional name (defaults to connection's name). */
  name?: string;
  /** Default 'POST'. */
  request_method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Payload format (e.g. 'form_json', 'form_xml'). Optional — HQ picks a default per repeater type. */
  format?: string;

  // Expression-repeater extras (only for FormExpressionRepeater /
  // CaseExpressionRepeater):
  /** UCR filter spec as a JSON object. Required for the *ExpressionRepeater types. */
  configured_filter?: Record<string, unknown>;
  /** UCR expression spec for the request payload. Required for POST/PUT *ExpressionRepeater. */
  configured_expression?: Record<string, unknown>;
  /** Path suffix to append to the connection's base URL (optional). */
  url_template?: string;
}

export interface Repeater {
  id: string;
  name: string;
  url: string;
  repeater_type: string;
}

export interface InboundApi {
  id: number;
  name: string;
  description: string;
  api_url: string;
  edit_url: string;
}

export type UcrExpressionType = 'named_expression' | 'named_filter';

export interface UcrExpression {
  id: number;
  name: string;
  expression_type: UcrExpressionType;
  description: string;
  /** JSON-encoded definition (parsed). */
  definition: Record<string, unknown> | null;
}

export interface ListUcrExpressionsArgs {
  domain: string;
  limit?: number;
}

export interface CreateUcrExpressionArgs {
  domain: string;
  name: string;
  expression_type: UcrExpressionType;
  /** The UCR spec (a JSON object — passed as JSON-encoded string to the form). */
  definition: Record<string, unknown>;
  description?: string;
}

/** Custom user data field definition (per HQ's CustomDataFieldsForm field schema). */
export interface CustomUserField {
  slug: string;
  label?: string;
  is_required?: boolean;
  /** Empty list for free-text fields; populated for dropdown-choice fields. */
  choices?: string[];
  regex?: string;
  regex_msg?: string;
  /** Required for which user types — subset of ["web_user", "commcare_user"]. */
  required_for?: string[];
  /** When the field was pulled from an upstream master domain via Linked Domain. */
  upstream_id?: string | null;
}

export interface ListUserFieldsArgs {
  domain: string;
}

export interface ConditionalAlert {
  id: number;
  name: string;
  case_type: string;
  /** Whether the rule's *schedule* is active (not the rule itself — see ConditionalAlertListView docstring). */
  active: boolean;
  /** Whether the alert can be edited from the UI (false for SMS-survey-using alerts on subscriptions without inbound SMS). */
  editable: boolean;
  locked_for_editing: boolean;
  progress_pct: number;
}

export interface ListConditionalAlertsArgs {
  domain: string;
  /** Server-side substring filter on rule name. */
  query?: string;
  limit?: number;
}

export interface SetUserFieldsArgs {
  domain: string;
  /**
   * Full list of fields to put on the domain. DESTRUCTIVE: this replaces
   * the existing definition. Callers wanting incremental update should
   * first call `listUserFields` and merge.
   */
  fields: CustomUserField[];
  /** Pre-existing profiles to preserve. Defaults to []. */
  profiles?: Array<Record<string, unknown>>;
  /** Whether to purge user_data on existing users for fields no longer in the list. Default false (safer). */
  purge_existing?: boolean;
}

export interface ListInboundApisArgs {
  domain: string;
  limit?: number;
}

export interface CreateInboundApiArgs {
  domain: string;
  name: string;
  description?: string;
  /** UCR expression FK (integer id from a UCRExpression that's been pushed via linked_domain). */
  filter_expression_id: number;
  /** Optional transform-expression FK. */
  transform_expression_id?: number;
  /** ApiBackendOptions slug — default 'json' (the common case). */
  backend?: 'json' | 'form_data';
}

export interface CreateConnectionArgs {
  domain: string;
  name: string;
  /** Base URL of the target system (e.g. "https://connect.dimagi.com/"). */
  url: string;
  /** Default 'none'. */
  auth_type?: ConnectionAuthType;
  username?: string;
  plaintext_password?: string;
  client_id?: string;
  plaintext_client_secret?: string;
  token_url?: string;
  /** Comma-separated email addresses for failure notifications. */
  notify_addresses_str?: string;
  /** Default false. */
  skip_cert_verify?: boolean;
  /** JSON object string of custom headers (e.g. '{"Authorization": "Token ..."}'). */
  plaintext_custom_headers?: string;
}

export interface GetLookupTableArgs {
  domain: string;
  /** Lookup table name (e.g. "interview_schedule"). */
  tag: string;
}

export interface CreateLookupTableArgs {
  domain: string;
  tag: string;
  fields: LookupTableField[];
  /** Default false. */
  is_global?: boolean;
  /** Default []. */
  item_attributes?: string[];
}

export interface CommCareUser {
  id: string;
  /** Full username with @domain.commcarehq.org suffix. */
  username: string;
  /** Just the local part of username. */
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_numbers?: string[];
  groups?: string[];
  user_data: Record<string, unknown>;
}

export interface ListUsersArgs {
  domain: string;
  /** Tastypie list pagination — defaults to HQ's max-per-page (usually 20). */
  limit?: number;
  offset?: number;
  /** Filter by group_id. */
  group?: string;
}

export interface GetUserArgs {
  domain: string;
  /** User couch id (the `id` field in list responses). */
  user_id: string;
}

export interface UpdateUserFieldArgs {
  domain: string;
  user_id: string;
  /** Field slug to set (e.g. "cohort_id"). */
  field_slug: string;
  /** Value to set; pass null to clear the field. */
  value: string | null;
}

/** A single row in a lookup table. Flat-string values per column. */
export interface LookupTableRow {
  id: string;
  data_type_id: string;
  /** Flat map: field_name → string value. (Extracts the first field_list entry's field_value per column.) */
  fields: Record<string, string>;
  item_attributes: Record<string, string>;
}

export interface GetLookupTableRowsArgs {
  domain: string;
  /** Either the table UUID (data_type_id) or the table tag (name) — atom looks up by tag if no UUID syntax. */
  table_id_or_tag: string;
}

export interface AppendLookupTableRowsArgs {
  domain: string;
  /** Either the table UUID (data_type_id) or the table tag (name). */
  table_id_or_tag: string;
  /**
   * Rows to append. Each row is `field_name → string value` (one value
   * per column, no sub-properties). HQ auto-assigns sort_key.
   */
  rows: Array<Record<string, string>>;
  /** Optional per-row item_attributes (string-only map). */
  item_attributes?: Record<string, string>;
}

export interface MakeBuildResult {
  build_id: string;
  version: number | null;
  built_on: string | null;
}

export interface ReleaseBuildArgs {
  domain: string;
  app_id: string;
  build_id: string;
}

export interface ReleaseBuildResult {
  build_id: string;
  is_released: boolean;
  latest_released_version: number | null;
}

export interface DownloadCczArgs {
  domain: string;
  app_id: string;
  /** Optional explicit build id; if omitted, downloads `latest=release`. */
  build_id?: string;
  /**
   * If true, append `?include_multimedia=true` so CCHQ returns the full,
   * self-contained CCZ with multimedia binaries inlined under
   * `commcare/multimedia/...` (live shape: `commcare/image/<filename>`,
   * `commcare/audio/<filename>`, etc.). Default `false` returns the lite
   * manifest-only response — faster, but multimedia entries are NOT
   * inlined; the Android client lazy-fetches them from the remote
   * `/hq/multimedia/file/...` URL. The `app-multimedia-coverage` SKILL's
   * verify step (10) needs `true` to confirm a freshly-uploaded asset
   * is bundled in the released CCZ; without it the verify silently
   * false-negatives every successful upload.
   */
  include_multimedia?: boolean;
}

export interface DownloadCczResult {
  status: number;
  size_bytes: number;
  /** Base64-encoded CCZ bytes. Capped at 25 MB; larger CCZs return size_bytes only. */
  ccz_base64?: string;
  /** Per-namespace marker counts grepped from the inflated CCZ (when fetched). */
  connect_markers?: {
    deliver: number;
    module: number;
    task: number;
    assessment: number;
  };
  /**
   * Deterministic projection of what Connect's HQ→Connect sync will create
   * after this CCZ is released. Direct port of `commcare-connect`'s
   * `commcare_connect/opportunity/{app_xml,tasks}.py` extract + sync logic:
   * iterate every form's `<learn:deliver>`/`<learn:module>`/`<learn:task>`/
   * `<learn:assessment>` blocks, dedup via `get_or_create(app, slug)`
   * (DeliverUnit/Task/Assessment) or `update_or_create(app, slug)`
   * (LearnModule). First-seen `name` wins on dedup collisions.
   *
   * If `collision_count > 0`, that's exactly the number of slug groups
   * where two or more forms emit the same `id`. The dropped forms'
   * markers are silently discarded by Connect — DeliverUnit collisions
   * mean those forms cannot be wired to a payment_unit and submissions
   * against them go unpaid in production. Hard-gate this at the
   * producing-skill boundary (`pdd-to-deliver-app` Step 4a) and at the
   * release-time boundary (`app-release` Step 6).
   *
   * Reference: see jjackson/ace's `feedback_connect_deliver_unit_per_module`
   * memory and the upstream Nova compile_app slug-emission bug
   * (Nova reuses the module slug as `<learn:deliver id>` for every form
   * in a multi-form module — workaround on the ACE side is one form per
   * module).
   */
  projected_connect_state?: ConnectSyncProjection;
}

/** A single record Connect's sync will create. */
export interface ProjectedRecord {
  /** `id` attribute on the `<learn:*>` element — Connect's `slug`. */
  slug: string;
  /** `<learn:name>` text. First-seen value wins on slug collision. */
  name?: string;
  /** Form path (`modules-N/forms-M.xml`) where this record was first seen. */
  first_seen_in: string;
  /** `<learn:description>` text (modules + tasks only). */
  description?: string;
  /** `<learn:time_estimate>` value (modules only). */
  time_estimate?: number;
}

/** A slug group where ≥ 2 forms emit the same `id` for a given block type. */
export interface ProjectedCollision {
  slug: string;
  kept: { name?: string; form: string };
  dropped: { name?: string; form: string }[];
  /** All forms (kept + dropped), in extraction order. */
  forms: string[];
}

export interface ConnectSyncProjection {
  /** What Connect WILL create — one record per distinct slug per type. */
  deliver_units: ProjectedRecord[];
  learn_modules: ProjectedRecord[];
  task_units: ProjectedRecord[];
  assessments: ProjectedRecord[];
  /** Slug-collision groups per block type. Empty arrays when clean. */
  collisions: {
    deliver_units: ProjectedCollision[];
    learn_modules: ProjectedCollision[];
    task_units: ProjectedCollision[];
    assessments: ProjectedCollision[];
  };
  /** Sum of all collision-group counts across types. 0 = clean projection. */
  collision_count: number;
  /**
   * Connect's `LearnModule.slug` and `DeliverUnit.slug` columns are
   * `SlugField()` with the Django default `max_length=50`. The slug values
   * are derived server-side inside `extract_modules` / `extract_deliver_units`
   * from the CCZ's `<learn:module id="…">` / `<learn:deliver id="…">`
   * attributes — Nova slugifies the module name to produce them. If a
   * slug exceeds 50 chars, the subsequent `LearnModule.objects.get_or_create`
   * / `DeliverUnit.objects.get_or_create` INSERT raises Postgres
   * `DataError: value too long for type character varying(50)`, which falls
   * through the narrow `except (CommCareHQAPIException, AppNoBuildException,
   * httpx.*)` clause in `commcare_connect/program/api/views.py:102` and
   * surfaces as HTTP 500 with an empty body. Same shape as the 2026-05-12
   * `short_description` 50-char trap; same generalized boundary-probe
   * pattern. See `docs/learnings/2026-05-12-boundary-probe-registry.md`.
   *
   * `slug_length_limit` is a constant (50) so callers self-document the gate.
   * `max_slug_length` is the longest slug seen across all extracted records.
   * `oversized_slugs` lists every record whose slug exceeds the limit, per
   * type, so the producer-side gate (`app-release` Step 6) can name each
   * offender precisely in the [BLOCKER] verdict.
   */
  slug_length_limit: number;
  max_slug_length: number;
  oversized_slugs: {
    deliver_units: ProjectedRecord[];
    learn_modules: ProjectedRecord[];
    task_units: ProjectedRecord[];
    assessments: ProjectedRecord[];
  };
}

export interface PatchXformArgs {
  domain: string;
  app_id: string;
  /** 32-char hex `unique_id` of the form (NOT the `m/f` index). */
  form_unique_id: string;
  /** Full replacement XForm XML. */
  new_xform_xml: string;
  /**
   * Optional. The sha1 of the form XML the caller believes it is editing.
   * If supplied AND CCHQ has a different sha1 (concurrent edit), the patch
   * is rejected with `XformConflictError` and the live sha1 is included so
   * the caller can re-fetch + retry.
   */
  sha1?: string;
}

export interface UploadMultimediaArgs {
  domain: string;
  app_id: string;
  /** jr://file/commcare/<image|audio|video|text>/<filename>.<ext> */
  media_path: string;
  /** Raw file bytes — image/audio/video/text payload. */
  file_bytes: Buffer;
  /** Standard MIME type — `image/png`, `image/jpeg`, `audio/mpeg`, … */
  content_type: string;
}

export interface UploadMultimediaResult {
  /** CouchDB doc `_id` (CCHQ's `ref.m_id`) of the multimedia document. */
  multimedia_id: string;
  /**
   * MD5 hex of the file bytes (CCHQ's `ref.uid`). Named `file_hash_md5`
   * deliberately — CCHQ's `CommCareMultimedia.file_hash` field is md5,
   * NOT sha1 (verified live 2026-05-05; see scripts/probe-multimedia-upload.ts).
   * CCHQ dedupes uploads on this hash.
   */
  file_hash_md5: string;
}

export interface PatchXformResult {
  /** HTTP status from `edit_form_attr/.../xform/`. */
  status: number;
  /**
   * CCHQ's app-version counter after the patch. Bumps by 1 per save;
   * downstream callers use this to confirm the save took (vs a no-op
   * 200 that didn't actually bump the app).
   *
   * NOTE: CCHQ's `edit_form_attr` xform handler does NOT return a sha1
   * in its response body — verified live 2026-05-03 against
   * connect-ace-prod (response body shape `{"corrections":{}, "update":{"app-version":N}}`).
   * Operators who need sha1 for re-fetch / conflict checks must read
   * it from a follow-up GET on the form's source page.
   */
  app_version: number;
  /**
   * Per-form-element corrections that CCHQ's validator made on the
   * way in (rare; usually empty). Surfaced verbatim so the caller can
   * decide whether the corrections are acceptable or warrant a re-patch.
   */
  corrections?: Record<string, unknown>;
}

/**
 * CCHQ rejected an `edit_form_attr/.../xform/` POST because the caller's
 * `sha1` arg disagreed with the live form sha1 (concurrent edit, or stale
 * CCZ). Non-retryable in the same form-state — the caller should re-fetch
 * the live xform, re-derive the patch, and POST again with the new sha1.
 */
export class XformConflictError extends Error {
  constructor(public liveSha1: string, public attemptedSha1: string) {
    super(
      `CCHQ refused xform patch: sha1 mismatch (attempted ${attemptedSha1.slice(0, 8)}, live ${liveSha1.slice(0, 8)}). ` +
        'Re-download the form and re-derive the patch before retrying.',
    );
    this.name = 'XformConflictError';
  }
}

/**
 * CCHQ rejected a `commcare_make_build` because the app's emitted XForm
 * XML failed CCHQ-side parsing (XForm well-formedness, missing
 * multimedia, invalid XPath, etc.). The endpoint returns 200 with
 * `{saved_app: null, error_html: "..."}` rather than a 4xx; without a
 * typed error, callers see "no build _id in saved_app" with the raw
 * JSON inlined and have to peek at CCHQ's UI to read the actual
 * rejection reason.
 *
 * `errorText` is the structured human-readable rejection (form name +
 * menu + line/col + parser message) extracted from `error_html`. The
 * `errorHtml` field preserves the raw HTML for callers that want to
 * re-parse for additional context.
 *
 * Non-retryable in the same app-state — the caller must edit the
 * offending form (typically via the Nova architect or the CCHQ form
 * designer) and re-upload before retrying. `app-release` Step 2.7
 * surfaces this; a future loop in `app-release` is expected to catch
 * it and dispatch a Nova edit-and-retry round.
 */
export class BuildRejectedError extends Error {
  retryable = false;
  constructor(
    public app_id: string,
    public errorText: string,
    public errorHtml: string,
  ) {
    super(
      `CCHQ rejected commcare_make_build for app ${app_id}: ${errorText}`,
    );
    this.name = 'BuildRejectedError';
  }

  /** Structured payload for MCP responses (mirrors ConnectValidationError.toJSON). */
  toJSON(): {
    error: 'build_rejected';
    message: string;
    app_id: string;
    error_text: string;
    error_html: string;
    retryable: false;
  } {
    return {
      error: 'build_rejected',
      message: this.message,
      app_id: this.app_id,
      error_text: this.errorText,
      error_html: this.errorHtml,
      retryable: false,
    };
  }
}

export class CommCareBackend {
  constructor(private opts: CommCareBackendOptions) {}

  /**
   * Run an MCP atom with one-shot recovery on session expiry. If the inner
   * function throws SessionExpiredError (raised by `assertNotLoginRedirect`
   * when CCHQ 302s to `/login/`), invalidate the cached session, force a
   * fresh `hqOAuthLogin`, and retry once. Subsequent failures bubble to the
   * caller unchanged.
   */
  private async runWithSessionRetry<T>(
    fn: (request: APIRequestContext) => Promise<T>,
  ): Promise<T> {
    const ctx = await this.opts.session.getContext();
    try {
      return await fn(ctx.request);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      await this.opts.session.invalidate();
      const ctx2 = await this.opts.session.getContext();
      return await fn(ctx2.request);
    }
  }

  /**
   * Throw `SessionExpiredError` if a Playwright `APIResponse` is a 302
   * redirect whose `Location` points at a CCHQ login URL. This is the
   * mid-session-expiry signal — CCHQ won't return a fresh login form on
   * an authenticated POST, only a redirect. Caller wraps the throw in
   * `runWithSessionRetry` to recover transparently.
   */
  private static assertNotLoginRedirect(res: APIResponse, label: string): void {
    if (res.status() !== 302) return;
    const location = res.headers()['location'] || '';
    if (/\/login\/?(\?|$)/.test(location)) {
      throw new SessionExpiredError();
    }
    // Non-login 302: surface generically, caller decides how to handle.
    throw new Error(`${label} returned 302 to ${location || '<no location header>'}`);
  }

  /**
   * Create a new CommCare HQ project space (domain).
   *
   * POST /register/domain/ via the DomainRegistrationForm CSRF-protected
   * web view in corehq/apps/registration/views.py (RegisterDomainView).
   * No REST API exists for domain creation; this is a Django form view.
   *
   * For an existing (non-new) user — which ACE's `ace@dimagi-ai.com`
   * always is, since it already owns connect-ace-prod — the success path
   * is a 302 redirect to `/a/<slug>/dashboard/` (reverse of
   * `domain_homepage`). The slug is auto-derived from `hr_name` by HQ.
   *
   * Auth: `@login_required` plus standard CSRF. ACE's PlaywrightSession
   * cookies satisfy both. No superuser requirement on
   * connect.dimagi.com (settings.RESTRICT_DOMAIN_CREATION is unset).
   */
  async createDomain(args: CreateDomainArgs): Promise<CreateDomainResult> {
    return this.runWithSessionRetry(async (request) => {
      if (args.hr_name.length > 25) {
        throw new Error(
          `commcare_create_domain: hr_name "${args.hr_name}" is ${args.hr_name.length} chars; HQ DomainRegistrationForm.max_name_length is 25.`,
        );
      }
      const path = '/register/domain/';
      // GET the registration page first so the cookie/csrf is fresh
      // (same pattern as makeBuild). A 302 here means session expired
      // mid-call — let runWithSessionRetry handle it.
      const refreshRes = await request.get(`${this.opts.baseUrl}${path}`, {
        maxRedirects: 0,
      });
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(refreshRes, `commcare_create_domain GET ${path}`);
      }
      if (refreshRes.status() !== 200) {
        throw new Error(
          `commcare_create_domain GET ${path} returned ${refreshRes.status()}: ${(await refreshRes.text()).slice(0, 300)}`,
        );
      }
      const csrf = await this.csrfFromCookies(request);
      const body =
        `csrfmiddlewaretoken=${encodeURIComponent(csrf ?? '')}` +
        `&hr_name=${encodeURIComponent(args.hr_name)}` +
        `&org=${encodeURIComponent(args.org ?? '')}`;
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: body,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${path}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        const location = res.headers()['location'] || '';
        if (/\/login\/?(\?|$)/.test(location)) {
          throw new SessionExpiredError();
        }
        // Success: HQ redirects to /a/<slug>/dashboard/ (or another
        // `domain_homepage` reverse). Extract the slug from `/a/<slug>/`.
        const m = location.match(/^\/a\/([^/]+)\//);
        if (!m) {
          throw new Error(
            `commcare_create_domain POST ${path} returned 302 to unexpected Location: ${location}`,
          );
        }
        return { domain: m[1] };
      }
      if (res.status() === 200) {
        // Form re-render — validation failed. Sniff for known error
        // strings from the RegisterDomainView post() method so callers
        // see a meaningful error instead of raw HTML.
        const html = await res.text();
        if (/Project name already taken/i.test(html)) {
          throw new Error(
            `commcare_create_domain: project name "${args.hr_name}" is already taken on HQ.`,
          );
        }
        if (/exceeds limit/i.test(html)) {
          throw new Error(
            'commcare_create_domain: HQ-wide daily domain creation limit exceeded. Try again later or contact Dimagi.',
          );
        }
        if (/project creation be restricted/i.test(html)) {
          throw new Error(
            'commcare_create_domain: RESTRICT_DOMAIN_CREATION is set on this HQ instance and the user is not a superuser.',
          );
        }
        throw new Error(
          `commcare_create_domain POST ${path} returned 200 (form re-render — validation failed). First 400 chars: ${html.slice(0, 400)}`,
        );
      }
      throw new Error(
        `commcare_create_domain POST ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`,
      );
    });
  }

  /**
   * Establish a linked-project-spaces relationship: upstream (master) →
   * downstream. Required before linked-app push / linked content sync
   * (see linked_domain skill docs and the LITE_RELEASE_MANAGEMENT
   * privilege on Pro Edition).
   *
   * Endpoint: POST /a/<upstream>/remote_link/service/
   *   (the linked_domain app is mounted at `^remote_link/` inside
   *   domain_specific in commcare-hq/urls.py — the URL name suggests
   *   "linked_domain" but the actual mount point is "remote_link/")
   * Auth: standard session + CSRF. Caller must have access in BOTH domains.
   * Protocol: jQuery-RMI (corehq/util/jqueryrmi.py) — requires headers
   *   `X-Requested-With: XMLHttpRequest`  (AJAX detection)
   *   `Djng-Remote-Method: create_domain_link`
   * Body: JSON `{"downstream_domain": "<slug>"}`.
   *
   * Response: 200 JSON `{success: true, domain_link: {...}}` on success,
   * or `{success: false, message: "..."}` on collision (already linked /
   * domain does not exist / no access). The latter is surfaced as an
   * Error so the caller can branch.
   */
  async linkDomains(args: LinkDomainsArgs): Promise<LinkDomainsResult> {
    return this.runWithSessionRetry(async (request) => {
      const upstream = args.upstream_domain;
      const downstream = args.downstream_domain;
      const path = `/a/${upstream}/remote_link/service/`;
      // Refresh CSRF by GETting any page in the upstream domain.
      const refreshPath = `/a/${upstream}/dashboard/`;
      const refreshRes = await request.get(`${this.opts.baseUrl}${refreshPath}`, {
        maxRedirects: 0,
      });
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(refreshRes, `commcare_link_domains GET ${refreshPath}`);
      }
      const csrf = await this.csrfFromCookies(request);
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: JSON.stringify({ downstream_domain: downstream }),
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Djng-Remote-Method': 'create_domain_link',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${refreshPath}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_link_domains POST ${path}`);
      }
      if (res.status() !== 200) {
        throw new Error(
          `commcare_link_domains POST ${path} returned ${res.status()}: ${(await res.text()).slice(0, 400)}`,
        );
      }
      const body = await res.text();
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(
          `commcare_link_domains POST ${path} returned 200 but body was not JSON. First 400 chars: ${body.slice(0, 400)}`,
        );
      }
      if (!parsed?.success) {
        throw new Error(
          `commcare_link_domains: HQ refused to create link ${upstream} → ${downstream}: ${parsed?.message ?? '<no message>'}`,
        );
      }
      return {
        upstream_domain: upstream,
        downstream_domain: downstream,
        domain_link: parsed.domain_link,
      };
    });
  }

  /**
   * Fetch a lookup table by tag (name). HQ's Tastypie LookupTableResource
   * supports list-with-filters but not directly by tag, so this atom
   * lists all tables in the domain and finds the one whose `tag` matches.
   *
   * Endpoint: GET /a/<domain>/api/v0.5/lookup_table/
   * Auth: session via RequirePermissionAuthentication(edit_apps,
   *   allow_session_auth=True) per corehq/apps/fixtures/resources/v0_1.py.
   * Returns null if no table with that tag exists.
   *
   * Verified against /tmp/ace-refs/hq/corehq/apps/fixtures/resources/v0_1.py:111-244.
   */
  async getLookupTable(args: GetLookupTableArgs): Promise<{ table: LookupTable | null }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.5/lookup_table/`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, {
        maxRedirects: 0,
        headers: { Authorization: this.apiKeyAuthHeader('commcare_get_lookup_table') },
      });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_get_lookup_table GET ${path}`);
      }
      if (res.status() !== 200) {
        throw new Error(
          `commcare_get_lookup_table GET ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`,
        );
      }
      const parsed = JSON.parse(await res.text()) as {
        objects?: Array<{ id?: string; tag?: string; is_global?: boolean; fields?: any[]; item_attributes?: string[] }>;
      };
      const match = (parsed.objects ?? []).find((t) => t.tag === args.tag);
      if (!match || !match.id) {
        return { table: null };
      }
      return {
        table: {
          id: match.id,
          tag: match.tag ?? args.tag,
          is_global: match.is_global ?? false,
          fields: (match.fields ?? []).map((f) => ({
            field_name: f.field_name ?? f.name,
            properties: f.properties ?? [],
          })),
          item_attributes: match.item_attributes ?? [],
        },
      };
    });
  }

  /**
   * Create a new lookup table.
   * POST /a/<domain>/api/v0.5/lookup_table/ with body
   *   {tag, is_global, fields: [{field_name, properties}], item_attributes}
   * Returns the new table's UUID (hex, no dashes).
   *
   * Raises if the tag is already taken (HQ's obj_create rejects with 400
   * via `LookupTable.objects.domain_tag_exists`).
   *
   * Verified against
   * /tmp/ace-refs/hq/corehq/apps/fixtures/resources/v0_1.py:192-204.
   */
  async createLookupTable(args: CreateLookupTableArgs): Promise<{ id: string; tag: string }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.5/lookup_table/`;
      const authHeader = this.apiKeyAuthHeader('commcare_create_lookup_table');
      const body = {
        tag: args.tag,
        is_global: args.is_global ?? false,
        fields: args.fields.map((f) => ({
          field_name: f.field_name,
          properties: f.properties ?? [],
        })),
        item_attributes: args.item_attributes ?? [],
      };
      // API-key-authenticated Tastypie endpoints don't need CSRF — the
      // CsrfViewMiddleware skips Authorization-header requests.
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_create_lookup_table POST ${path}`);
      }
      if (res.status() !== 201 && res.status() !== 200) {
        const text = await res.text();
        // HQ's obj_create raises BadRequest("A lookup table with name <tag> already exists")
        if (/already exists/i.test(text)) {
          throw new Error(
            `commcare_create_lookup_table: a lookup table with tag "${args.tag}" already exists in domain ${args.domain}.`,
          );
        }
        throw new Error(
          `commcare_create_lookup_table POST ${path} returned ${res.status()}: ${text.slice(0, 400)}`,
        );
      }
      // Tastypie returns the created object on 201 with Location header
      // pointing at the detail URI. Parse Location for the id.
      const location = res.headers()['location'] || '';
      const idFromLocation = location.match(/\/lookup_table\/([0-9a-f]+)\/?$/i)?.[1];
      if (idFromLocation) {
        return { id: idFromLocation, tag: args.tag };
      }
      // Fallback: parse response body
      try {
        const parsed = JSON.parse(await res.text());
        if (parsed?.id) return { id: parsed.id, tag: args.tag };
      } catch { /* fall through */ }
      // Worst case: re-list and find by tag
      const got = await this.getLookupTable({ domain: args.domain, tag: args.tag });
      if (got.table) return { id: got.table.id, tag: args.tag };
      throw new Error(
        `commcare_create_lookup_table POST ${path} returned ${res.status()} but neither Location header nor body nor list-readback exposed the new table's id.`,
      );
    });
  }

  /**
   * Resolve a table UUID from either a UUID hex or a tag (name).
   * UUIDs are 32 hex chars; anything else is treated as a tag.
   */
  private async resolveTableId(domain: string, idOrTag: string): Promise<string> {
    if (/^[0-9a-f]{32}$/i.test(idOrTag)) return idOrTag;
    const got = await this.getLookupTable({ domain, tag: idOrTag });
    if (!got.table) {
      throw new Error(
        `Lookup table tag "${idOrTag}" not found in domain ${domain}. Create it first via commcare_create_lookup_table.`,
      );
    }
    return got.table.id;
  }

  /**
   * List mobile workers (CommCareUser) in a domain.
   * GET /a/<domain>/api/v0.5/user/  with API-key auth.
   */
  async listUsers(args: ListUsersArgs): Promise<{ users: CommCareUser[]; total: number }> {
    return this.runWithSessionRetry(async (request) => {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.offset !== undefined) params.set('offset', String(args.offset));
      if (args.group) params.set('group', args.group);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.5/user/${qs}`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, {
        maxRedirects: 0,
        headers: { Authorization: this.apiKeyAuthHeader('commcare_list_users') },
      });
      if (res.status() !== 200) {
        throw new Error(`commcare_list_users GET ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      const parsed = JSON.parse(await res.text()) as { objects?: any[]; meta?: { total_count?: number } };
      const users = (parsed.objects ?? []).map((u) => ({
        id: u.id ?? u._id ?? '',
        username: u.username ?? '',
        first_name: u.first_name,
        last_name: u.last_name,
        email: u.email,
        phone_numbers: u.phone_numbers,
        groups: u.groups,
        user_data: u.user_data ?? {},
      }));
      return { users, total: parsed.meta?.total_count ?? users.length };
    });
  }

  /**
   * Fetch one mobile worker by id. GET /a/<domain>/api/v0.5/user/<id>/.
   */
  async getUser(args: GetUserArgs): Promise<{ user: CommCareUser }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.5/user/${encodeURIComponent(args.user_id)}/`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, {
        maxRedirects: 0,
        headers: { Authorization: this.apiKeyAuthHeader('commcare_get_user') },
      });
      if (res.status() !== 200) {
        throw new Error(`commcare_get_user GET ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      const u = JSON.parse(await res.text()) as any;
      return {
        user: {
          id: u.id ?? u._id ?? args.user_id,
          username: u.username ?? '',
          first_name: u.first_name,
          last_name: u.last_name,
          email: u.email,
          phone_numbers: u.phone_numbers,
          groups: u.groups,
          user_data: u.user_data ?? {},
        },
      };
    });
  }

  /**
   * Set a single user_data field on a mobile worker. Implemented as GET
   * → mutate user_data → PUT (v0_5 CommCareUserResource has PUT but not
   * PATCH). To clear a field, pass value=null.
   */
  async updateUserField(args: UpdateUserFieldArgs): Promise<{ user_id: string; field_slug: string; value: string | null }> {
    return this.runWithSessionRetry(async (request) => {
      const { user } = await this.getUser({ domain: args.domain, user_id: args.user_id });
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.5/user/${encodeURIComponent(args.user_id)}/`;
      const next = { ...(user.user_data ?? {}) };
      if (args.value === null) delete next[args.field_slug];
      else next[args.field_slug] = args.value;
      const res = await request.fetch(`${this.opts.baseUrl}${path}`, {
        method: 'PUT',
        data: JSON.stringify({ user_data: next }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.apiKeyAuthHeader('commcare_update_user_field'),
        },
        maxRedirects: 0,
      });
      if (res.status() !== 200 && res.status() !== 202 && res.status() !== 204) {
        throw new Error(
          `commcare_update_user_field PUT ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`,
        );
      }
      return { user_id: args.user_id, field_slug: args.field_slug, value: args.value };
    });
  }

  /**
   * List domain Connection settings (motech). POST
   * /a/<domain>/motech/conn/ with `action=paginate&page=N&limit=Y` —
   * the CRUD paginated view returns JSON with `paginatedList: [{itemData}]`.
   *
   * Gated by privileges.DATA_FORWARDING (Pro Edition). 404s if not enabled.
   *
   * Verified against /tmp/ace-refs/hq/corehq/motech/views.py:185-269
   * (ConnectionSettingsListView + CRUDPaginatedViewMixin).
   */
  async listConnections(args: ListConnectionsArgs): Promise<{ connections: Connection[]; total: number }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/motech/conn/`;
      const csrf = await this.csrfFromCookies(request);
      const params = new URLSearchParams({
        action: 'paginate',
        page: '1',
        limit: String(args.limit ?? 100),
      });
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${this.opts.baseUrl}${path}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 404) {
        throw new Error(
          `commcare_list_connections: 404 — domain ${args.domain} does not have DATA_FORWARDING privilege (Pro Edition required).`,
        );
      }
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_list_connections POST ${path}`);
      }
      if (res.status() !== 200) {
        throw new Error(`commcare_list_connections POST ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = JSON.parse(await res.text()) as { paginatedList?: Array<{ itemData?: any }>; total?: number };
      const connections = (body.paginatedList ?? []).map((row) => {
        const d = row.itemData ?? {};
        return {
          id: Number(d.id),
          name: String(d.name ?? ''),
          url: String(d.url ?? ''),
          notify_addresses: String(d.notifyAddresses ?? ''),
          used_by: String(d.usedBy ?? ''),
          edit_url: String(d.editUrl ?? ''),
        };
      });
      return { connections, total: body.total ?? connections.length };
    });
  }

  /**
   * Create a Connection (outbound motech connection settings). POSTs the
   * ConnectionSettingsForm to /a/<domain>/motech/conn/add/.
   * Success redirects to the list view (no new id in Location), so this
   * atom re-lists by name to recover the new id.
   *
   * Same Pro/DATA_FORWARDING gating as list_connections.
   *
   * Verified against /tmp/ace-refs/hq/corehq/motech/views.py:262-301
   * (ConnectionSettingsDetailView) + /tmp/ace-refs/hq/corehq/motech/forms.py:28
   * (ConnectionSettingsForm.Meta.fields).
   */
  async createConnection(args: CreateConnectionArgs): Promise<{ id: number; name: string }> {
    return this.runWithSessionRetry(async (request) => {
      const addPath = `/a/${encodeURIComponent(args.domain)}/motech/conn/add/`;
      // Seed CSRF
      const refreshRes = await request.get(`${this.opts.baseUrl}${addPath}`, { maxRedirects: 0 });
      if (refreshRes.status() === 404) {
        throw new Error(`commcare_create_connection: 404 — domain ${args.domain} does not have DATA_FORWARDING privilege.`);
      }
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(refreshRes, `commcare_create_connection GET ${addPath}`);
      }
      const csrf = await this.csrfFromCookies(request);
      const params = new URLSearchParams();
      params.set('csrfmiddlewaretoken', csrf ?? '');
      params.set('name', args.name);
      params.set('url', args.url);
      params.set('auth_type', args.auth_type ?? 'none');
      if (args.username) params.set('username', args.username);
      if (args.plaintext_password) params.set('plaintext_password', args.plaintext_password);
      if (args.client_id) params.set('client_id', args.client_id);
      if (args.plaintext_client_secret) params.set('plaintext_client_secret', args.plaintext_client_secret);
      if (args.token_url) params.set('token_url', args.token_url);
      params.set('notify_addresses_str', args.notify_addresses_str ?? '');
      if (args.skip_cert_verify) params.set('skip_cert_verify', 'on');
      params.set('plaintext_custom_headers', args.plaintext_custom_headers ?? '{}');
      const res = await request.post(`${this.opts.baseUrl}${addPath}`, {
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${addPath}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        // Could be login redirect or success (success → list view)
        const location = res.headers()['location'] || '';
        if (/\/login\/?(\?|$)/.test(location)) {
          throw new SessionExpiredError();
        }
        // Success — look up the new connection by name to find its id.
      } else if (res.status() === 200) {
        // Form re-render = validation failed
        const html = await res.text();
        throw new Error(
          `commcare_create_connection: form re-render — validation failed. First 400 chars: ${html.slice(0, 400)}`,
        );
      } else {
        throw new Error(`commcare_create_connection POST ${addPath} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      // Re-list to find the new connection's id by name.
      const list = await this.listConnections({ domain: args.domain });
      const match = list.connections.filter((c) => c.name === args.name);
      if (match.length === 0) {
        throw new Error(
          `commcare_create_connection: created connection but could not find it by name "${args.name}" on subsequent list. Names visible: ${list.connections.map((c) => c.name).join(', ')}`,
        );
      }
      // Take the highest id if multiple match (newest)
      const newest = match.sort((a, b) => b.id - a.id)[0];
      return { id: newest.id, name: newest.name };
    });
  }

  /**
   * List named UCR expressions / filters on a domain. POST
   * /a/<domain>/data/ucr_expressions/ with `action=paginate` via the
   * CRUDPaginatedView (same pattern as Connections + Inbound APIs).
   * Returns each expression's id, name, expression_type, description,
   * and parsed definition JSON.
   *
   * Auth: session via BaseProjectDataView (domain admin / edit_apps).
   *
   * Verified against
   * /tmp/ace-refs/hq/corehq/apps/userreports/views.py:1882-1965 +
   * /tmp/ace-refs/hq/corehq/apps/data_interfaces/urls.py:68.
   */
  async listUcrExpressions(args: ListUcrExpressionsArgs): Promise<{ expressions: UcrExpression[]; total: number }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/data/ucr_expressions/`;
      const csrf = await this.csrfFromCookies(request);
      const params = new URLSearchParams({ action: 'paginate', page: '1', limit: String(args.limit ?? 100) });
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${this.opts.baseUrl}${path}`,
        },
        maxRedirects: 0,
      });
      if (res.status() !== 200) {
        throw new Error(`commcare_list_ucr_expressions POST ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = JSON.parse(await res.text()) as { paginatedList?: Array<{ itemData?: any }>; total?: number };
      const expressions = (body.paginatedList ?? []).map((row) => {
        const d = row.itemData ?? {};
        let parsedDef: Record<string, unknown> | null = null;
        try {
          parsedDef = d.definition ? JSON.parse(d.definition) : null;
        } catch { /* malformed JSON; leave null */ }
        return {
          id: Number(d.id),
          name: String(d.name ?? ''),
          expression_type: (d.type ?? 'named_expression') as UcrExpressionType,
          description: String(d.description ?? ''),
          definition: parsedDef,
        };
      });
      return { expressions, total: body.total ?? expressions.length };
    });
  }

  /**
   * Create a named UCR expression / filter on a domain. POSTs the
   * UCRExpressionForm to /a/<domain>/data/ucr_expressions/ via
   * `action=create`. Returns the new expression's id.
   *
   * Required fields per
   * /tmp/ace-refs/hq/corehq/apps/userreports/forms.py:11 :
   *   - name (CharField)
   *   - expression_type ("named_expression" | "named_filter")
   *   - definition (JSONField — serialized as JSON-encoded string)
   *
   * IntegrityError on duplicate name in domain surfaces as an explicit error.
   */
  async createUcrExpression(args: CreateUcrExpressionArgs): Promise<{ id: number; name: string }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/data/ucr_expressions/`;
      const csrf = await this.csrfFromCookies(request);
      const params = new URLSearchParams();
      params.set('action', 'create');
      params.set('csrfmiddlewaretoken', csrf ?? '');
      params.set('name', args.name);
      params.set('expression_type', args.expression_type);
      params.set('description', args.description ?? '');
      params.set('definition', JSON.stringify(args.definition));
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${this.opts.baseUrl}${path}`,
        },
        maxRedirects: 0,
      });
      if (res.status() !== 200) {
        throw new Error(`commcare_create_ucr_expression POST ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      // CRUDPaginatedViewMixin wraps the create response as
      //   {newItem: {itemData: {...}, template: ...}}
      // (See `paginate_crud_response` in corehq.apps.hqwebapp.views.)
      const body = JSON.parse(await res.text()) as {
        newItem?: { itemData?: any; error?: string };
        itemData?: any;
        error?: string;
        form?: any;
      };
      const itemData = body.newItem?.itemData ?? body.itemData;
      const errorMsg = body.newItem?.error ?? body.error;
      if (errorMsg) {
        // get_create_item_data returns {error: "..."} on IntegrityError
        throw new Error(`commcare_create_ucr_expression: ${errorMsg}`);
      }
      if (itemData?.id) {
        return { id: Number(itemData.id), name: String(itemData.name ?? args.name) };
      }
      if (body.form) {
        throw new Error(
          `commcare_create_ucr_expression: form validation failed. Server response: ${JSON.stringify(body).slice(0, 400)}`,
        );
      }
      // Fallback: list and find
      const list = await this.listUcrExpressions({ domain: args.domain });
      const match = list.expressions.find((e) => e.name === args.name);
      if (!match) {
        throw new Error(
          `commcare_create_ucr_expression: created but could not find "${args.name}" on subsequent list. Names visible: ${list.expressions.map((e) => e.name).join(', ')}`,
        );
      }
      return { id: match.id, name: match.name };
    });
  }

  /**
   * List Conditional Alerts on a domain. GET
   * /a/<domain>/messaging/conditional/?action=list_conditional_alerts&page=N&limit=Y.
   *
   * The ConditionalAlertListView has a dedicated AJAX list endpoint
   * (verified against /tmp/ace-refs/hq/corehq/messaging/scheduling/views.py
   * :653-665 `get_conditional_alerts_ajax_response`) that returns JSON
   * `{rules: [{id, name, case_type, active, editable, ...}], total: N}`.
   *
   * Gated by REMINDERS_FRAMEWORK (Standard+ subscription).
   *
   * NB: `active` here is the rule's schedule's active flag (not the
   * rule.active flag). The list view's docstring explains:
   *   "Therefore rule processing occurs unconditionally every time a
   *    rule is saved." For verifier purposes treat any rule whose
   *    schedule is active as "live."
   *
   * The CREATE counterpart is deferred — see notes in
   * docs/connect-interviews/v1-acceptance.md.
   */
  async listConditionalAlerts(args: ListConditionalAlertsArgs): Promise<{ alerts: ConditionalAlert[]; total: number }> {
    return this.runWithSessionRetry(async (request) => {
      const params = new URLSearchParams({
        action: 'list_conditional_alerts',
        page: '1',
        limit: String(args.limit ?? 100),
      });
      if (args.query) params.set('query', args.query);
      const path = `/a/${encodeURIComponent(args.domain)}/messaging/conditional/?${params.toString()}`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, {
        maxRedirects: 0,
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
        },
      });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_list_conditional_alerts GET ${path}`);
      }
      if (res.status() === 404) {
        throw new Error(
          `commcare_list_conditional_alerts: 404 — domain ${args.domain} lacks REMINDERS_FRAMEWORK privilege (Standard+).`,
        );
      }
      if (res.status() !== 200) {
        throw new Error(`commcare_list_conditional_alerts GET ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = JSON.parse(await res.text()) as { rules?: any[]; total?: number };
      const alerts = (body.rules ?? []).map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? ''),
        case_type: String(r.case_type ?? ''),
        active: !!r.active,
        editable: !!r.editable,
        locked_for_editing: !!r.locked_for_editing,
        progress_pct: Number(r.progress_pct ?? 0),
      }));
      return { alerts, total: body.total ?? alerts.length };
    });
  }

  /**
   * Read the current custom-user-data field definition for a domain.
   * GETs /a/<domain>/users/user_data/ and parses the
   * `<div data-name="custom_fields" data-value="<json>">` initial_page_data
   * div — this is HQ's standard "Django → JS" bootstrap mechanism (template
   * tag `initial_page_data` in corehq/apps/hqwebapp/templatetags/
   * hq_shared_tags.py:650).
   *
   * Requires `can_edit_commcare_users` permission (302s to settings/users/
   * without it). Surfaces that as a typed error so callers can pivot.
   *
   * Verified template path: corehq/apps/custom_data_fields/templates/
   * custom_data_fields/custom_data_fields.html lines 21-22.
   */
  async listUserFields(args: ListUserFieldsArgs): Promise<{ fields: CustomUserField[]; profiles: Array<Record<string, unknown>> }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/users/user_data/`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, { maxRedirects: 0 });
      if (res.status() === 302) {
        const location = res.headers()['location'] || '';
        if (/\/login\/?(\?|$)/.test(location)) throw new SessionExpiredError();
        if (location.includes('/settings/users/')) {
          throw new Error(
            `commcare_list_user_fields: session redirected to ${location} — the user lacks ` +
              `can_edit_commcare_users permission on ${args.domain}. ` +
              `Verify ace@dimagi-ai.com has admin or "Edit Mobile Workers" role on this domain.`,
          );
        }
        throw new Error(`commcare_list_user_fields GET ${path} redirected to ${location}`);
      }
      if (res.status() !== 200) {
        throw new Error(`commcare_list_user_fields GET ${path} returned ${res.status()}`);
      }
      const html = await res.text();
      const parseInitialPageData = (name: string): unknown => {
        const re = new RegExp(`<div data-name=["']${name}["'] data-value=["']([^"']*)["']`);
        const m = html.match(re);
        if (!m) return null;
        const decoded = m[1]
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        try { return JSON.parse(decoded); } catch { return null; }
      };
      const fieldsRaw = (parseInitialPageData('custom_fields') ?? []) as any[];
      const profilesRaw = (parseInitialPageData('custom_fields_profiles') ?? []) as any[];
      const fields: CustomUserField[] = fieldsRaw.map((f) => ({
        slug: String(f.slug ?? ''),
        label: f.label,
        is_required: !!f.is_required,
        choices: Array.isArray(f.choices) ? f.choices : [],
        regex: f.regex ?? undefined,
        regex_msg: f.regex_msg ?? undefined,
        required_for: Array.isArray(f.required_for) ? f.required_for : undefined,
        upstream_id: f.upstream_id ?? null,
      }));
      return { fields, profiles: profilesRaw };
    });
  }

  /**
   * Write the full custom-user-data field definition on a domain
   * (DESTRUCTIVE — replaces the existing list). POSTs to
   * /a/<domain>/users/user_data/ via the CustomDataFieldsForm. The form
   * has three hidden inputs that take JSON-encoded payloads:
   *   - data_fields  — the field list (slug, label, is_required, choices, ...)
   *   - profiles     — the profile list (preserved verbatim)
   *   - require_profile — comma-separated user types (we send empty by default)
   * Plus optional `purge_existing` boolean.
   *
   * Auth: same as listUserFields. The form is otherwise JS-rendered, but
   * a direct form POST bypasses the React/Knockout UI — verified by
   * reading apps/custom_data_fields/edit_model.py:491 (post handler
   * calls form.is_valid() then save_custom_fields() without UI involvement).
   *
   * Safety: callers SHOULD `listUserFields` first, merge their additions,
   * then call this with the merged list. Pure-replace semantics are
   * destructive on shared / production domains.
   */
  async setUserFields(args: SetUserFieldsArgs): Promise<{ ok: true; count: number }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/users/user_data/`;
      // Seed CSRF + verify permission via GET
      const refreshRes = await request.get(`${this.opts.baseUrl}${path}`, { maxRedirects: 0 });
      if (refreshRes.status() === 302) {
        const location = refreshRes.headers()['location'] || '';
        if (/\/login\/?(\?|$)/.test(location)) throw new SessionExpiredError();
        if (location.includes('/settings/users/')) {
          throw new Error(
            `commcare_set_user_fields: redirected to ${location} — user lacks can_edit_commcare_users on ${args.domain}.`,
          );
        }
      }
      const csrf = await this.csrfFromCookies(request);
      const dataFieldsJson = JSON.stringify(args.fields.map((f) => ({
        slug: f.slug,
        label: f.label ?? f.slug,
        is_required: f.is_required ?? false,
        choices: f.choices ?? [],
        regex: f.regex ?? '',
        regex_msg: f.regex_msg ?? '',
        required_for: f.required_for ?? [],
        upstream_id: f.upstream_id ?? null,
      })));
      const profilesJson = JSON.stringify(args.profiles ?? []);
      const params = new URLSearchParams();
      params.set('csrfmiddlewaretoken', csrf ?? '');
      params.set('data_fields', dataFieldsJson);
      params.set('profiles', profilesJson);
      params.set('require_profile', '');
      if (args.purge_existing) params.set('purge_existing', 'on');
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${path}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        const location = res.headers()['location'] || '';
        if (/\/login\/?(\?|$)/.test(location)) throw new SessionExpiredError();
        return { ok: true as const, count: args.fields.length };
      }
      if (res.status() === 200) {
        // The post() handler in edit_model.py calls self.get() at the end (success or fail).
        // Distinguish success from validation failure by sniffing for the messages.success.
        const html = await res.text();
        if (/fields saved successfully/i.test(html)) {
          return { ok: true as const, count: args.fields.length };
        }
        if (/Unable to save/i.test(html)) {
          throw new Error(
            `commcare_set_user_fields: form validation failed. First 400 chars: ${html.slice(0, 400)}`,
          );
        }
        // Inconclusive — assume success.
        return { ok: true as const, count: args.fields.length };
      }
      throw new Error(`commcare_set_user_fields POST ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
    });
  }

  /**
   * List Inbound API configurations on a domain. POST /a/<domain>/motech/
   * inbound/ with `action=paginate` via the CRUDPaginatedView (same
   * pattern as connections). Returns each API's id, name, description,
   * api_url.
   *
   * Pro/DATA_FORWARDING gated.
   * Verified against /tmp/ace-refs/hq/corehq/motech/generic_inbound/views.py:52-110.
   */
  async listInboundApis(args: ListInboundApisArgs): Promise<{ apis: InboundApi[]; total: number }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/motech/inbound/`;
      const csrf = await this.csrfFromCookies(request);
      const params = new URLSearchParams({ action: 'paginate', page: '1', limit: String(args.limit ?? 100) });
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${this.opts.baseUrl}${path}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 404) {
        throw new Error(`commcare_list_inbound_apis: 404 — domain ${args.domain} lacks DATA_FORWARDING privilege.`);
      }
      if (res.status() !== 200) {
        throw new Error(`commcare_list_inbound_apis POST ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = JSON.parse(await res.text()) as { paginatedList?: Array<{ itemData?: any }>; total?: number };
      const apis = (body.paginatedList ?? []).map((row) => {
        const d = row.itemData ?? {};
        return {
          id: Number(d.id),
          name: String(d.name ?? ''),
          description: String(d.description ?? ''),
          api_url: String(d.api_url ?? ''),
          edit_url: String(d.edit_url ?? ''),
        };
      });
      return { apis, total: body.total ?? apis.length };
    });
  }

  /**
   * Create a new Inbound API. POSTs the ConfigurableAPICreateForm to
   * /a/<domain>/motech/inbound/ via CRUDPaginatedViewMixin's `action=create`.
   *
   * Requires `filter_expression` and (optionally) `transform_expression`
   * to refer to existing UCRExpression FKs on the domain — these are
   * pushed via linked_domain from the master domain in the
   * Connect Interviews flow.
   *
   * Returns the new API's id (re-lists by name).
   *
   * Verified against /tmp/ace-refs/hq/corehq/motech/generic_inbound/
   * forms.py:17-50 + views.py:52-110.
   */
  async createInboundApi(args: CreateInboundApiArgs): Promise<{ id: number; name: string }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/motech/inbound/`;
      const csrf = await this.csrfFromCookies(request);
      const params = new URLSearchParams();
      params.set('action', 'create');
      params.set('csrfmiddlewaretoken', csrf ?? '');
      params.set('name', args.name);
      params.set('description', args.description ?? '');
      params.set('filter_expression', String(args.filter_expression_id));
      if (args.transform_expression_id) {
        params.set('transform_expression', String(args.transform_expression_id));
      }
      params.set('backend', args.backend ?? 'json');
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${this.opts.baseUrl}${path}`,
        },
        maxRedirects: 0,
      });
      if (res.status() !== 200) {
        throw new Error(
          `commcare_create_inbound_api POST ${path} returned ${res.status()}: ${(await res.text()).slice(0, 400)}`,
        );
      }
      // CRUDPaginatedViewMixin wraps the create response as
      //   {newItem: {itemData: {...}, template: ...}}.
      const body = JSON.parse(await res.text()) as {
        newItem?: { itemData?: any; error?: string };
        itemData?: any;
        form?: any;
        errors?: any;
      };
      const itemData = body.newItem?.itemData ?? body.itemData;
      const errorMsg = body.newItem?.error;
      if (errorMsg) {
        throw new Error(`commcare_create_inbound_api: ${errorMsg}`);
      }
      if (itemData?.id) {
        return { id: Number(itemData.id), name: String(itemData.name ?? args.name) };
      }
      // Validation error case
      if (body.errors || body.form) {
        throw new Error(
          `commcare_create_inbound_api: form validation failed. Server response: ${JSON.stringify(body).slice(0, 400)}`,
        );
      }
      // Fall back to list-and-find
      const list = await this.listInboundApis({ domain: args.domain });
      const match = list.apis.find((a) => a.name === args.name);
      if (!match) {
        throw new Error(
          `commcare_create_inbound_api: created but could not find "${args.name}" by name. Names visible: ${list.apis.map((a) => a.name).join(', ')}`,
        );
      }
      return { id: match.id, name: match.name };
    });
  }

  /**
   * Create a Data-Forwarding Repeater on a domain. POST the GenericRepeaterForm
   * (or BaseExpressionRepeaterForm for *ExpressionRepeater types) to
   * /a/<domain>/motech/forwarding/new/<repeater_type>/.
   *
   * Plain FormRepeater forwards every submission. FormExpressionRepeater
   * applies a UCR filter (`configured_filter`) and emits a UCR-derived
   * payload (`configured_expression`) — the Connect Interviews
   * "OCS User Registration" and "Trigger Bot" repeaters use this variant.
   *
   * Success: 302 to /a/<domain>/motech/forwarding/. Atom does not return
   * the repeater id (the redirect doesn't expose it); caller can list
   * by scraping the forwarding page if needed.
   *
   * Verified against /tmp/ace-refs/hq/corehq/motech/repeaters/views/
   * repeaters.py:99-180 (BaseRepeaterView) + forms.py:21-105 (Generic) +
   * expression/forms.py:20-92 (BaseExpressionRepeaterForm).
   */
  async createRepeater(args: CreateRepeaterArgs): Promise<{ ok: true; name: string }> {
    return this.runWithSessionRetry(async (request) => {
      const addPath = `/a/${encodeURIComponent(args.domain)}/motech/forwarding/new/${args.repeater_type}/`;
      // Seed CSRF
      const refreshRes = await request.get(`${this.opts.baseUrl}${addPath}`, { maxRedirects: 0 });
      if (refreshRes.status() === 404) {
        throw new Error(
          `commcare_create_repeater: 404 — domain ${args.domain} does not have DATA_FORWARDING privilege or repeater_type "${args.repeater_type}" is unknown.`,
        );
      }
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(refreshRes, `commcare_create_repeater GET ${addPath}`);
      }
      const csrf = await this.csrfFromCookies(request);
      const params = new URLSearchParams();
      params.set('csrfmiddlewaretoken', csrf ?? '');
      params.set('connection_settings_id', String(args.connection_settings_id));
      params.set('name', args.name ?? '');
      params.set('request_method', args.request_method ?? 'POST');
      if (args.format) params.set('format', args.format);
      const isExpression = args.repeater_type.endsWith('ExpressionRepeater');
      if (isExpression) {
        // BaseExpressionRepeaterForm fields. configured_filter is required.
        if (!args.configured_filter) {
          throw new Error(
            `commcare_create_repeater: repeater_type ${args.repeater_type} requires configured_filter (UCR filter spec as JSON object).`,
          );
        }
        params.set('configured_filter', JSON.stringify(args.configured_filter));
        if (args.configured_expression) {
          params.set('configured_expression', JSON.stringify(args.configured_expression));
        }
        if (args.url_template) params.set('url_template', args.url_template);
      }
      const res = await request.post(`${this.opts.baseUrl}${addPath}`, {
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${addPath}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        const location = res.headers()['location'] || '';
        if (/\/login\/?(\?|$)/.test(location)) throw new SessionExpiredError();
        // Success — redirect to forwarding list
        return { ok: true as const, name: args.name ?? '' };
      }
      if (res.status() === 200) {
        const html = await res.text();
        throw new Error(
          `commcare_create_repeater: form re-render — validation failed. First 400 chars: ${html.slice(0, 400)}`,
        );
      }
      throw new Error(`commcare_create_repeater POST ${addPath} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
    });
  }

  /**
   * Fetch a single case by id. GET /a/<domain>/api/v0.5/case/<case_id>/?format=json.
   * Auth: API key (RequirePermissionAuthentication(edit_data)).
   *
   * Used by verifier to read commcare-user case state — the
   * session_completion / last_bot_interaction_date / interaction_validation
   * properties get set by OCS-to-HQ custom action posts.
   */
  async getCase(args: GetCaseArgs): Promise<{ case: CommCareCase }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.5/case/${encodeURIComponent(args.case_id)}/?format=json`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, {
        maxRedirects: 0,
        headers: { Authorization: this.apiKeyAuthHeader('commcare_get_case') },
      });
      if (res.status() === 404) {
        throw new Error(`commcare_get_case: case ${args.case_id} not found in domain ${args.domain}.`);
      }
      if (res.status() !== 200) {
        throw new Error(`commcare_get_case GET ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      }
      const c = JSON.parse(await res.text()) as any;
      return {
        case: {
          case_id: c.case_id ?? c.id ?? args.case_id,
          case_type: c.case_type ?? c.properties?.case_type ?? '',
          case_name: c.case_name ?? c.properties?.case_name ?? '',
          date_opened: c.date_opened ?? c.properties?.date_opened ?? '',
          date_modified: c.date_modified ?? '',
          closed: !!c.closed,
          properties: (c.properties ?? {}) as Record<string, unknown>,
          user_id: c.user_id,
          owner_id: c.owner_id ?? c.properties?.owner_id,
        },
      };
    });
  }

  /**
   * Get rows of a lookup table. Tastypie LookupTableItemResource returns
   * ALL rows in the domain (no querystring filter), so this atom
   * client-side filters by `data_type_id`.
   *
   * Each row's `fields` is flattened: `{column_name: first_field_value}`
   * (the team's Connect Interviews lookup tables don't use sub-properties
   * or multi-value field_lists).
   *
   * Endpoint: GET /a/<domain>/api/v0.5/lookup_table_item/
   * Auth: API key (Tastypie default for this resource).
   */
  async getLookupTableRows(args: GetLookupTableRowsArgs): Promise<{ rows: LookupTableRow[] }> {
    return this.runWithSessionRetry(async (request) => {
      const tableId = await this.resolveTableId(args.domain, args.table_id_or_tag);
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.5/lookup_table_item/`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, {
        maxRedirects: 0,
        headers: { Authorization: this.apiKeyAuthHeader('commcare_get_lookup_table_rows') },
      });
      if (res.status() !== 200) {
        throw new Error(
          `commcare_get_lookup_table_rows GET ${path} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`,
        );
      }
      const parsed = JSON.parse(await res.text()) as {
        objects?: Array<{ id?: string; data_type_id?: string; fields?: any; item_attributes?: any }>;
      };
      const rows = (parsed.objects ?? [])
        .filter((r) => r.data_type_id === tableId)
        .map((r) => {
          const flatFields: Record<string, string> = {};
          for (const [col, container] of Object.entries(r.fields ?? {})) {
            const list = (container as any)?.field_list ?? [];
            flatFields[col] = list[0]?.field_value ?? list[0]?.value ?? '';
          }
          return {
            id: r.id ?? '',
            data_type_id: r.data_type_id ?? tableId,
            fields: flatFields,
            item_attributes: (r.item_attributes ?? {}) as Record<string, string>,
          };
        });
      return { rows };
    });
  }

  /**
   * Append rows to a lookup table. POSTs one row at a time to
   * /a/<domain>/api/v0.5/lookup_table_item/ — the Tastypie resource
   * doesn't accept a list payload, only single-row POST. Returns the
   * array of created row ids.
   *
   * For Connect Interviews `interview_schedule`, each row is a flat
   * `{cohort_id, previous_interview, next_interview, frequency_days}`
   * map. Empty string values are passed as-is (HQ stores them).
   */
  async appendLookupTableRows(args: AppendLookupTableRowsArgs): Promise<{ row_ids: string[] }> {
    return this.runWithSessionRetry(async (request) => {
      const tableId = await this.resolveTableId(args.domain, args.table_id_or_tag);
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.5/lookup_table_item/`;
      const authHeader = this.apiKeyAuthHeader('commcare_lookup_table_append_rows');
      const ids: string[] = [];
      for (const flatRow of args.rows) {
        const fields: Record<string, { field_list: Array<{ field_value: string; properties: Record<string, string> }> }> = {};
        for (const [col, val] of Object.entries(flatRow)) {
          fields[col] = { field_list: [{ field_value: String(val), properties: {} }] };
        }
        const body = {
          data_type_id: tableId,
          fields,
          item_attributes: args.item_attributes ?? {},
        };
        const res = await request.post(`${this.opts.baseUrl}${path}`, {
          data: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          maxRedirects: 0,
        });
        if (res.status() !== 201 && res.status() !== 200) {
          throw new Error(
            `commcare_lookup_table_append_rows POST ${path} for row ${JSON.stringify(flatRow)} returned ${res.status()}: ${(await res.text()).slice(0, 300)}`,
          );
        }
        // Tastypie returns the created row with id on 201 + Location header.
        const location = res.headers()['location'] || '';
        const id = location.match(/\/lookup_table_item\/([0-9a-f]+)\/?$/i)?.[1];
        if (id) ids.push(id);
        else {
          try {
            const parsed = JSON.parse(await res.text());
            if (parsed?.id) ids.push(parsed.id);
          } catch { /* drop — caller can re-list */ }
        }
      }
      return { row_ids: ids };
    });
  }

  /**
   * POST /a/<domain>/apps/save/<app_id>/ with an empty body — CCHQ creates
   * a new versioned build doc and returns its `_id`. The CSRF token is read
   * from the cookie jar (ctx.request inherits cookies from the BrowserContext).
   */
  async makeBuild(args: MakeBuildArgs): Promise<MakeBuildResult> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${args.domain}/apps/save/${args.app_id}/`;
      // GET the releases page first so the cookie/csrf is fresh. Use
      // maxRedirects:0 here too — a 302 here means the session expired
      // mid-call and we want the retry path, not a silently-followed
      // redirect to a login page that pollutes the csrftoken cookie.
      const refreshPath = `/a/${args.domain}/apps/view/${args.app_id}/releases/`;
      const refreshRes = await request.get(`${this.opts.baseUrl}${refreshPath}`, {
        maxRedirects: 0,
      });
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(refreshRes, `commcare_make_build GET ${refreshPath}`);
      }
      const csrf = await this.csrfFromCookies(request);
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: args.comment ? `comment=${encodeURIComponent(args.comment)}` : '',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${refreshPath}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_make_build POST ${path}`);
      }
      if (res.status() !== 200) {
        throw new Error(
          `commcare_make_build POST ${path} returned ${res.status()}: ` +
            (await res.text()).slice(0, 300),
        );
      }
      let parsed: any;
      try {
        parsed = JSON.parse(await res.text());
      } catch {
        throw new Error(
          `commcare_make_build POST ${path} returned 200 but body was not JSON. ` +
            `Empty-body POST is the supported invocation; if CCHQ now requires a full app-state JSON, ` +
            `re-discover the endpoint via skills/app-release/SKILL.md § Probe procedure.`,
        );
      }
      const build = parsed?.saved_app ?? parsed;
      const build_id = build?._id ?? build?.id;
      if (!build_id) {
        // CCHQ's documented "build rejected" shape: 200 with
        // `{saved_app: null, error_html: "<html string>"}`. The
        // error_html names the affected form / menu / line:col and is
        // what the CCHQ UI shows the user. Surface it as a typed error
        // so callers can catch it (and so the operator sees the actual
        // diagnostic instead of raw JSON).
        const errorHtml = typeof parsed?.error_html === 'string' ? parsed.error_html : null;
        if (errorHtml) {
          throw new BuildRejectedError(
            args.app_id,
            summarizeServerErrorBody(errorHtml, 'text/html'),
            errorHtml,
          );
        }
        throw new Error(
          `commcare_make_build POST ${path} returned 200 but no build _id in saved_app and no error_html. ` +
            `Unrecognized response shape — body: ${JSON.stringify(parsed).slice(0, 400)}`,
        );
      }
      return {
        build_id: String(build_id),
        version: typeof build.version === 'number' ? build.version : null,
        built_on: typeof build.built_on === 'string' ? build.built_on : null,
      };
    });
  }

  /**
   * POST /a/<domain>/apps/view/<app_id>/releases/release/<build_id>/
   * Body: ajax=true&is_released=true
   */
  async releaseBuild(args: ReleaseBuildArgs): Promise<ReleaseBuildResult> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${args.domain}/apps/view/${args.app_id}/releases/release/${args.build_id}/`;
      const refreshPath = `/a/${args.domain}/apps/view/${args.app_id}/releases/`;
      const refreshRes = await request.get(`${this.opts.baseUrl}${refreshPath}`, {
        maxRedirects: 0,
      });
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(refreshRes, `commcare_release_build GET ${refreshPath}`);
      }
      const csrf = await this.csrfFromCookies(request);
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: 'ajax=true&is_released=true',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${refreshPath}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_release_build POST ${path}`);
      }
      if (res.status() !== 200) {
        throw new Error(
          `commcare_release_build POST ${path} returned ${res.status()}: ` +
            (await res.text()).slice(0, 300),
        );
      }
      let parsed: any;
      try {
        parsed = JSON.parse(await res.text());
      } catch {
        // Some CCHQ versions return 200+HTML on success; treat absence of error as success
        parsed = { is_released: true };
      }
      return {
        build_id: args.build_id,
        is_released: parsed.is_released === true,
        latest_released_version:
          typeof parsed.latest_released_version === 'number'
            ? parsed.latest_released_version
            : null,
      };
    });
  }

  /**
   * GET /a/<domain>/apps/api/download_ccz/?app_id=<id>&latest=release
   * (or with explicit build_id). Returns the raw CCZ + a marker count
   * grepped from inflated form XML. Uses CCHQ HQ API auth fallback if
   * cookie auth fails — the `?api_key` query-string variant works
   * regardless of session staleness.
   */
  async downloadCcz(args: DownloadCczArgs): Promise<DownloadCczResult> {
    return this.runWithSessionRetry(async (request) => {
      const qs = new URLSearchParams({ app_id: args.app_id });
      if (args.build_id) {
        qs.set('app_id', args.build_id); // download_ccz takes either app_id or build_id
      } else {
        qs.set('latest', 'release');
      }
      if (args.include_multimedia === true) {
        qs.set('include_multimedia', 'true');
      }
      const path = `/a/${args.domain}/apps/api/download_ccz/?${qs.toString()}`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, { maxRedirects: 0 });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_download_ccz GET ${path}`);
      }
      const status = res.status();
      if (status !== 200) {
        return { status, size_bytes: 0 };
      }
      const buf = await res.body();
      const size = buf.byteLength;
      // Skip base64 round-trip + marker grep on > 25 MB CCZs to keep MCP
      // responses small. If the operator needs the bytes for a larger app,
      // they should download via curl directly.
      if (size > 25 * 1024 * 1024) {
        return { status, size_bytes: size };
      }
      // CCZ is a ZIP whose entries are typically DEFLATE-compressed; the
      // form XML is NOT readable from the raw zip bytes. Inflate in memory
      // (fflate.unzipSync, no temp files) and grep the decompressed XML.
      // Pre-0.10.56 this scanned the raw zip bytes and silently returned
      // {deliver:0,module:0,task:0,assessment:0} for every released app —
      // see commcare-setup-summary for the leep-paint-collection 2026-05-01
      // failure mode and the manual-decode triangulation.
      const connect_markers = computeConnectMarkers(buf);
      // `projected_connect_state` is the deterministic projection of
      // what Connect's HQ→Connect sync will create from this CCZ.
      // `connect_markers` is the legacy count-only output retained for
      // one release; PR-2 gates `app-release` Step 6 + `pdd-to-deliver-app`
      // Step 4a on `projected_connect_state.collision_count === 0`. See
      // `DownloadCczResult` for full mechanism.
      const projected_connect_state = simulateConnectSync(buf);
      return {
        status,
        size_bytes: size,
        ccz_base64: buf.toString('base64'),
        connect_markers,
        projected_connect_state,
      };
    });
  }

  /**
   * POST /a/<domain>/apps/edit_form_attr/<app_id>/<form_unique_id>/xform/
   *
   * CCHQ surgical form-XML patch endpoint (handler:
   * `corehq/apps/app_manager/views/forms.py::_edit_form_attr`, mounted on
   * `corehq/apps/app_manager/urls.py`). Form data:
   *
   *   `xform`  — full replacement XForm XML (urlencoded as a form field).
   *   `sha1`   — optional concurrency token. CCHQ accepts the field; if
   *              the live form's sha1 differs, the handler may reject
   *              with 409 (response shape includes `sha1` + `message`).
   *              Verified live 2026-05-03 that the success response does
   *              NOT echo the new sha1 — the field exists for input-side
   *              validation only.
   *
   * Auth: `@login_or_digest` accepts session cookies (the only path we test
   * here — same Playwright APIRequestContext as `commcare_make_build`).
   * The CSRF token is read from `csrftoken` cookie on `commcarehq.org`,
   * mirroring `makeBuild` / `releaseBuild` exactly.
   *
   * Response (verified live 2026-05-03 against connect-ace-prod):
   *   200 application/json
   *   {"corrections": {}, "update": {"app-version": <int>}}
   *
   * Note: this just patches the **draft**; you MUST follow with
   * `commcare_make_build` + `commcare_release_build` to make the patched
   * form discoverable downstream (Connect, FLW devices).
   */
  async patchXform(args: PatchXformArgs): Promise<PatchXformResult> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${args.domain}/apps/edit_form_attr/${args.app_id}/${args.form_unique_id}/xform/`;
      // Refresh CSRF + cookie via the form's edit page (mirrors makeBuild's
      // refresh-the-releases-page-first pattern). The view URL also exercises
      // the same `@login_or_digest` auth so a 302 here surfaces an expired
      // session up front rather than waiting for the POST to return HTML.
      const refreshPath = `/a/${args.domain}/apps/view/${args.app_id}/`;
      const refreshRes = await request.get(`${this.opts.baseUrl}${refreshPath}`, {
        maxRedirects: 0,
      });
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(refreshRes, `commcare_patch_xform GET ${refreshPath}`);
      }
      const csrf = await this.csrfFromCookies(request);

      // Build the form-encoded body. Using URLSearchParams ensures the XForm
      // XML's `&`, `<`, `>`, `+`, `=`, and `#` are all percent-escaped.
      const form = new URLSearchParams();
      form.set('xform', args.new_xform_xml);
      if (args.sha1) form.set('sha1', args.sha1);

      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: form.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${refreshPath}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_patch_xform POST ${path}`);
      }
      const status = res.status();
      const body = await res.text();

      // sha1 mismatch — when the caller passed a sha1 and CCHQ rejects
      // with the standard JSON-body conflict shape, surface as typed err.
      if ((status === 409 || status === 422) && args.sha1) {
        let parsed: { message?: string; sha1?: string } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* fall through to generic error */
        }
        if (parsed.sha1) {
          throw new XformConflictError(parsed.sha1, args.sha1);
        }
      }

      if (status !== 200) {
        throw new Error(
          `commcare_patch_xform POST ${path} returned ${status}: ${body.slice(0, 300)}`,
        );
      }

      let parsed: {
        corrections?: Record<string, unknown>;
        update?: { 'app-version'?: number };
      } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(
          `commcare_patch_xform POST ${path} returned 200 but body was not JSON. ` +
            'Endpoint likely changed; re-probe via dimagi/commcare-hq forms.py.',
        );
      }
      const appVersion = parsed.update?.['app-version'];
      if (typeof appVersion !== 'number') {
        throw new Error(
          `commcare_patch_xform POST ${path} returned 200 but JSON body had no update.app-version: ${body.slice(0, 300)}`,
        );
      }
      return {
        status,
        app_version: appVersion,
        ...(parsed.corrections && Object.keys(parsed.corrections).length > 0
          ? { corrections: parsed.corrections }
          : {}),
      };
    });
  }

  /**
   * POST /a/<domain>/apps/<app_id>/multimedia/uploaded/<media_type>/
   *
   * Upload binary multimedia (PNG, JPEG, MP3, …) into the app's
   * `multimedia_map` so subsequent `make_build` bundles it into the
   * generated CCZ. Endpoint mounted on
   * `corehq/apps/hqmedia/views.py::ProcessImageFileUploadView` (and sibling
   * audio/video/text variants); see `corehq/apps/hqmedia/urls.py`.
   *
   * Required form fields:
   *   `Filedata` — file bytes (field name fixed by
   *                BaseProcessUploadedView.upload_filename = 'Filedata').
   *   `path`     — `jr://file/commcare/<media_type>/<filename>.<ext>`.
   *                File extension MUST match the uploaded payload, else
   *                `validate_file` raises BadMediaFileException → 400.
   *
   * Auth: `@require_permission(HqPermissions.edit_apps)` — accepts the
   * same Playwright session-cookie auth as `patchXform`. CSRF read from
   * the cookie jar after a refresh GET to `/apps/view/<app_id>/`.
   *
   * Response (verified live 2026-05-05 against connect-ace-prod):
   *   200 OK with `Content-Type: text/html` (CCHQ uses `HttpResponse(json.dumps(...))`
   *   which defaults the type to text/html — the body IS valid JSON).
   *   `{ "ref": { "path", "uid"<md5>, "m_id"<couch _id>, "url", "updated", "media_type" }, "errors": [] }`
   *
   * **Important orphan-pruning gotcha (skill-side, NOT this atom).** CCHQ's
   * `clean_paths()` strips multimedia entries that no form references on
   * the next `make_build`. The skill must patch the form XML to reference
   * `jr://...` BEFORE calling this atom and `make_build`. The atom only
   * owns the upload step.
   */
  async uploadMultimedia(args: UploadMultimediaArgs): Promise<UploadMultimediaResult> {
    return this.runWithSessionRetry(async (request) => {
      const mediaType = mediaTypeFromContentType(args.content_type);
      const path = `/a/${args.domain}/apps/${args.app_id}/multimedia/uploaded/${mediaType}/`;
      const refreshPath = `/a/${args.domain}/apps/view/${args.app_id}/`;

      // Refresh CSRF + session via the app view page (mirrors patchXform).
      const refreshRes = await request.get(`${this.opts.baseUrl}${refreshPath}`, {
        maxRedirects: 0,
      });
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(
          refreshRes,
          `commcare_upload_multimedia GET ${refreshPath}`,
        );
      }
      const csrf = await this.csrfFromCookies(request);

      // Derive filename from media_path (last URI segment).
      const filename = args.media_path.split('/').pop() ?? 'unnamed';

      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        multipart: {
          Filedata: {
            name: filename,
            mimeType: args.content_type,
            buffer: args.file_bytes,
          },
          path: args.media_path,
        },
        headers: {
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${refreshPath}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(
          res,
          `commcare_upload_multimedia POST ${path}`,
        );
      }
      const status = res.status();
      const body = await res.text();

      if (status !== 200) {
        // Try to surface CCHQ's `errors[]` array first; fall back to body slice.
        let errs: string[] = [];
        try {
          const j = JSON.parse(body) as { errors?: string[] };
          if (Array.isArray(j?.errors)) errs = j.errors;
        } catch {
          /* fall through to body slice */
        }
        const errMsg = errs.length ? errs.join('; ') : body.slice(0, 300);
        throw new Error(
          `commcare_upload_multimedia POST ${path} returned ${status}: ${errMsg}`,
        );
      }

      // 200 path. Body is JSON despite the text/html content-type CCHQ sends.
      let parsed: { ref?: { m_id?: string; uid?: string }; errors?: string[] } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(
          `commcare_upload_multimedia POST ${path} returned 200 but body was not JSON: ${body.slice(0, 200)}`,
        );
      }
      if (parsed.errors && parsed.errors.length > 0) {
        throw new Error(
          `commcare_upload_multimedia errors: ${parsed.errors.join('; ')}`,
        );
      }
      if (!parsed.ref?.m_id || !parsed.ref?.uid) {
        throw new Error(
          `commcare_upload_multimedia response missing ref.m_id / ref.uid: ${body.slice(0, 200)}`,
        );
      }
      return {
        multimedia_id: parsed.ref.m_id,
        file_hash_md5: parsed.ref.uid,
      };
    });
  }

  private async csrfFromCookies(request: APIRequestContext): Promise<string | undefined> {
    const state = await request.storageState();
    const cookie = state.cookies.find((c) => c.name === 'csrftoken' && c.domain.includes('commcarehq'));
    return cookie?.value;
  }

  /**
   * Build the `Authorization: ApiKey <username>:<key>` header value used by
   * Tastypie endpoints that require API key auth (LookupTableResource,
   * LookupTableItemResource, and most CommCareUserResource calls).
   * Throws a typed error if the credentials aren't configured.
   */
  private apiKeyAuthHeader(atomLabel: string): string {
    const u = this.opts.hqUsername;
    const k = this.opts.hqApiKey;
    if (!u || !k) {
      throw new Error(
        `${atomLabel}: HQ API-key credentials not configured. ` +
          `ACE_HQ_USERNAME + ACE_HQ_API_KEY must be set in the plugin .env. ` +
          `Run /ace:doctor to verify.`,
      );
    }
    return `ApiKey ${u}:${k}`;
  }

  /**
   * List CommCare HQ applications in a domain.
   *
   * Uses CCHQ's REST API at GET /a/<domain>/api/v0.4/application/ (the
   * endpoint is domain-scoped; the unscoped /api/v0.4/application/?domain=
   * form returns 404 even though the TaskPie resource accepts a `domain`
   * query param — Django's URL routing requires the /a/<domain>/ prefix).
   * The endpoint accepts session cookies (LoginAndDomainAuthentication with
   * allow_session_auth=True), so we reuse the existing PlaywrightSession
   * cookie jar — no separate API key needed.
   *
   * Returns only the fields ACE's sweep needs: `id` (app_id), `name`, plus
   * the `doc_type` so callers can spot soft-deleted apps (those have
   * doc_type ending in `-Deleted`; the live listing already filters them
   * out server-side, but the field is preserved for any caller that
   * cross-checks against `commcare_delete_app`'s soft-delete behavior).
   *
   * Used by `/ace:sweep hq` to enumerate the universe of apps in the
   * ACE-owned domain before diffing against the live-set.
   */
  async listApps(args: { domain: string }): Promise<{ apps: Array<{ id: string; name: string; doc_type?: string }> }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${encodeURIComponent(args.domain)}/api/v0.4/application/`;
      const res = await request.get(`${this.opts.baseUrl}${path}`, { maxRedirects: 0 });
      if (res.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(res, `commcare_list_apps GET ${path}`);
      }
      if (res.status() !== 200) {
        throw new Error(
          `commcare_list_apps GET ${path} returned ${res.status()}: ` +
            (await res.text()).slice(0, 300),
        );
      }
      const parsed = JSON.parse(await res.text()) as {
        objects?: Array<{ id?: string; _id?: string; name?: string; doc_type?: string }>;
      };
      const apps = (parsed.objects ?? []).map((o) => ({
        id: o.id ?? o._id ?? '',
        name: o.name ?? '',
        doc_type: o.doc_type,
      })).filter((a) => a.id);
      return { apps };
    });
  }

  /**
   * Soft-delete a CommCare HQ application.
   *
   * Routes through CCHQ's web view at POST /a/<domain>/apps/delete_app/<app_id>/
   * (no REST API equivalent — the view soft-deletes by mutating doc_type to
   * `<original>-Deleted` and creating a `DeleteApplicationRecord` for undo).
   * Decorators: `@no_conflict_require_POST` + `@require_can_edit_apps`.
   *
   * CSRF token must come from the cookie jar (Django middleware requirement);
   * the existing csrfFromCookies helper handles this. Response is a 302
   * redirect to the domain dashboard.
   *
   * Restoration is possible via `undo_delete_app/<record_id>/` but this atom
   * doesn't return the record id (the redirect doesn't expose it). To recover
   * a deleted app, use the HQ admin UI's "deleted applications" list.
   */
  async deleteApp(args: { domain: string; app_id: string }): Promise<{ deleted: true }> {
    return this.runWithSessionRetry(async (request) => {
      const path = `/a/${args.domain}/apps/delete_app/${args.app_id}/`;
      // Refresh CSRF by GETting the apps listing — same pattern as makeBuild.
      const refreshPath = `/a/${args.domain}/apps/`;
      const refreshRes = await request.get(`${this.opts.baseUrl}${refreshPath}`, {
        maxRedirects: 0,
      });
      if (refreshRes.status() === 302) {
        CommCareBackend.assertNotLoginRedirect(refreshRes, `commcare_delete_app GET ${refreshPath}`);
      }
      const csrf = await this.csrfFromCookies(request);
      const res = await request.post(`${this.opts.baseUrl}${path}`, {
        data: '',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf ?? '',
          Referer: `${this.opts.baseUrl}${refreshPath}`,
        },
        maxRedirects: 0,
      });
      if (res.status() === 302) {
        // Success is a 302 to the domain dashboard. Session-expired-redirect
        // would point at /login/ — assertNotLoginRedirect throws SessionExpired
        // in that case so runWithSessionRetry recovers automatically.
        const location = res.headers()['location'] || '';
        if (/\/login\/?(\?|$)/.test(location)) {
          throw new SessionExpiredError();
        }
        return { deleted: true as const };
      }
      throw new Error(
        `commcare_delete_app POST ${path} returned ${res.status()}: ` +
          (await res.text()).slice(0, 300),
      );
    });
  }
}

/**
 * Map a standard MIME type to the CCHQ media-type URL segment used by
 * `/a/<domain>/apps/<app_id>/multimedia/uploaded/<media_type>/`. CCHQ's
 * `corehq/apps/hqmedia/urls.py` mounts four sibling views (image, audio,
 * video, text) on the same `BaseProcessFileUploadView` shape — only the
 * URL segment + the `media_class` differ.
 *
 * Exported for unit tests + future skill-side validation.
 */
export function mediaTypeFromContentType(ct: string): 'image' | 'audio' | 'video' | 'text' {
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('text/')) return 'text';
  throw new Error(`commcare_upload_multimedia: unsupported content_type ${ct}`);
}

/**
 * Count Connect-namespace marker elements inside a CCZ buffer.
 *
 * Scans every `*.xml` entry in the zip after inflating it in memory and
 * matches both the default-namespace shape (Nova's autobuild output —
 * `<deliver xmlns="http://commcareconnect.com/data/v1/learn">`) and the
 * legacy `learn:`-prefixed shape. Files that don't decompress (corrupt
 * entries, unsupported compression methods) are skipped silently rather
 * than failing the whole call — a partial count is more useful than no
 * count, and the per-form re-fetch in `app-connect-coverage` Step 4 is
 * the actual gate.
 *
 * Exported for unit tests.
 */
export function computeConnectMarkers(cczBuf: Buffer): {
  deliver: number;
  module: number;
  task: number;
  assessment: number;
} {
  let combined = '';
  try {
    const entries = unzipSync(new Uint8Array(cczBuf), {
      filter: (file) => file.name.endsWith('.xml'),
    });
    for (const name of Object.keys(entries)) {
      try {
        combined += strFromU8(entries[name]) + '\n';
      } catch {
        // Skip non-UTF8 / binary entries that slipped past the .xml filter.
      }
    }
  } catch {
    // If the buffer isn't a valid zip we return all zeros — the caller
    // already has the size and status, and a non-CCZ payload is the
    // diagnostic on its own.
    return { deliver: 0, module: 0, task: 0, assessment: 0 };
  }
  const count = (re: RegExp) => (combined.match(re) || []).length;
  return {
    deliver: count(/<(?:learn:)?deliver\b[^>]*xmlns="http:\/\/commcareconnect\.com[^"]*"|<learn:deliver\b/g),
    module: count(/<(?:learn:)?module\b[^>]*xmlns="http:\/\/commcareconnect\.com[^"]*"|<learn:module\b/g),
    task: count(/<(?:learn:)?task\b[^>]*xmlns="http:\/\/commcareconnect\.com[^"]*"|<learn:task\b/g),
    assessment: count(/<(?:learn:)?assessment\b[^>]*xmlns="http:\/\/commcareconnect\.com[^"]*"|<learn:assessment\b/g),
  };
}

/**
 * Project the exact set of LearnModule/DeliverUnit/TaskUnit/Assessment
 * records Connect's `sync_learn_modules_and_deliver_units` will create
 * after this CCZ is released, plus the slug-collision groups Connect
 * will silently dedup.
 *
 * Direct port of `commcare-connect`'s logic:
 *   - `commcare_connect/opportunity/app_xml.py:extract_*` walks every
 *     form XML and yields one record per `<learn:deliver>` /
 *     `<learn:module>` / `<learn:task>` / `<learn:assessment>` block.
 *   - `commcare_connect/opportunity/tasks.py:sync_learn_modules_and_deliver_units`
 *     calls `DeliverUnit.objects.get_or_create(app=app, slug=block.id, ...)`
 *     and `LearnModule.objects.update_or_create(app=app, slug=block.id, ...)`.
 *
 * Implication: the `(app, slug)` pair is the unique key. Two forms
 * emitting the same `id` collapse into ONE record on Connect's side,
 * with the first-seen `name` winning. For DeliverUnits this is a
 * billing-correctness bug — every collapsed-but-non-first form's
 * submissions go unpaid because there's no payment_unit pointing at it.
 *
 * Form-XML failures (corrupt entries, unsupported compression methods)
 * are skipped silently — same shape as `computeConnectMarkers`. A
 * partial projection plus structured collision detail is more useful
 * than a hard fail.
 *
 * Exported for unit tests + future skill-side validation.
 */
export function simulateConnectSync(cczBuf: Buffer): ConnectSyncProjection {
  // Per block type: ordered map slug -> first-seen record (mirrors
  // get_or_create semantics — the first form to claim a slug wins).
  const records = {
    deliver: new Map<string, ProjectedRecord>(),
    module: new Map<string, ProjectedRecord>(),
    task: new Map<string, ProjectedRecord>(),
    assessment: new Map<string, ProjectedRecord>(),
  };
  // Per block type: every hit, in extraction order, for collision detection.
  const hits = {
    deliver: [] as { slug: string; name?: string; form: string }[],
    module: [] as { slug: string; name?: string; form: string }[],
    task: [] as { slug: string; name?: string; form: string }[],
    assessment: [] as { slug: string; name?: string; form: string }[],
  };

  let entries: Record<string, Uint8Array> = {};
  try {
    entries = unzipSync(new Uint8Array(cczBuf), {
      filter: (file) => /^modules-\d+\/forms-\d+\.xml$/.test(file.name),
    });
  } catch {
    // Same fallback as computeConnectMarkers — return empty projection.
    return emptyProjection();
  }

  // Walk forms in lexicographic order so first-seen is deterministic
  // across runs (mirrors what Connect's sync sees from CCHQ's CCZ stream).
  const formPaths = Object.keys(entries).sort();

  for (const path of formPaths) {
    let xml: string;
    try {
      xml = strFromU8(entries[path]);
    } catch {
      continue;
    }
    extractBlocks(xml, path, records, hits);
  }

  const collisions = {
    deliver_units: collisionsFor(hits.deliver),
    learn_modules: collisionsFor(hits.module),
    task_units: collisionsFor(hits.task),
    assessments: collisionsFor(hits.assessment),
  };
  const collision_count =
    collisions.deliver_units.length +
    collisions.learn_modules.length +
    collisions.task_units.length +
    collisions.assessments.length;

  const deliver_units = Array.from(records.deliver.values());
  const learn_modules = Array.from(records.module.values());
  const task_units = Array.from(records.task.values());
  const assessments = Array.from(records.assessment.values());

  const oversized_slugs = {
    deliver_units: deliver_units.filter((r) => r.slug.length > SLUG_LENGTH_LIMIT),
    learn_modules: learn_modules.filter((r) => r.slug.length > SLUG_LENGTH_LIMIT),
    task_units: task_units.filter((r) => r.slug.length > SLUG_LENGTH_LIMIT),
    assessments: assessments.filter((r) => r.slug.length > SLUG_LENGTH_LIMIT),
  };
  const max_slug_length = Math.max(
    0,
    ...deliver_units.map((r) => r.slug.length),
    ...learn_modules.map((r) => r.slug.length),
    ...task_units.map((r) => r.slug.length),
    ...assessments.map((r) => r.slug.length),
  );

  return {
    deliver_units,
    learn_modules,
    task_units,
    assessments,
    collisions,
    collision_count,
    slug_length_limit: SLUG_LENGTH_LIMIT,
    max_slug_length,
    oversized_slugs,
  };
}

/**
 * Connect's `LearnModule.slug` / `DeliverUnit.slug` `SlugField()` default
 * max_length. Module slugs that exceed this trigger the Postgres
 * `character varying(50)` `DataError` → uncaught HTTP 500 documented above.
 * When the upstream commcare-connect PR widens these columns, bump this
 * constant in lock-step.
 */
export const SLUG_LENGTH_LIMIT = 50;

function emptyProjection(): ConnectSyncProjection {
  return {
    deliver_units: [],
    learn_modules: [],
    task_units: [],
    assessments: [],
    collisions: {
      deliver_units: [],
      learn_modules: [],
      task_units: [],
      assessments: [],
    },
    collision_count: 0,
    slug_length_limit: SLUG_LENGTH_LIMIT,
    max_slug_length: 0,
    oversized_slugs: {
      deliver_units: [],
      learn_modules: [],
      task_units: [],
      assessments: [],
    },
  };
}

/**
 * Match every `<learn:foo>` or default-namespace `<foo xmlns="...connect...">`
 * element of the four block types. Captures the `id` attribute and the
 * inner content (so we can pull `<learn:name>`, `<learn:description>`,
 * `<learn:time_estimate>` text).
 *
 * Two regex shapes per type — same as `computeConnectMarkers` — to handle
 * Nova's autobuild output (default-namespace) and the legacy `learn:`-
 * prefixed shape simultaneously.
 */
const BLOCK_PATTERNS: Record<keyof typeof TYPE_KEYS, RegExp> = {
  deliver: makePattern('deliver'),
  module: makePattern('module'),
  task: makePattern('task'),
  assessment: makePattern('assessment'),
};
// Type alias keys; declared after the regex map for readability.
const TYPE_KEYS = { deliver: 1, module: 1, task: 1, assessment: 1 } as const;

function makePattern(name: string): RegExp {
  // Matches either `<learn:NAME ... id="X" ...>...</learn:NAME>` OR
  // `<NAME xmlns="...connect..." ... id="X" ...>...</NAME>`. The `[^>]*?`
  // sequences are deliberately non-greedy so attribute order doesn't
  // matter (id can come before or after xmlns).
  return new RegExp(
    `<(?:learn:)?${name}\\b[^>]*\\bid="([^"]+)"[^>]*xmlns="http:\\/\\/commcareconnect\\.com[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:learn:)?${name}>` +
      `|<learn:${name}\\b[^>]*\\bid="([^"]+)"[^>]*>([\\s\\S]*?)<\\/learn:${name}>` +
      `|<(?:learn:)?${name}\\b[^>]*xmlns="http:\\/\\/commcareconnect\\.com[^"]*"[^>]*\\bid="([^"]+)"[^>]*>([\\s\\S]*?)<\\/(?:learn:)?${name}>`,
    'g',
  );
}

function extractInner(inner: string, tag: string): string | undefined {
  const m = inner.match(
    new RegExp(`<(?:learn:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:learn:)?${tag}>`),
  );
  return m ? m[1].trim() : undefined;
}

function extractBlocks(
  xml: string,
  formPath: string,
  records: {
    deliver: Map<string, ProjectedRecord>;
    module: Map<string, ProjectedRecord>;
    task: Map<string, ProjectedRecord>;
    assessment: Map<string, ProjectedRecord>;
  },
  hits: {
    deliver: { slug: string; name?: string; form: string }[];
    module: { slug: string; name?: string; form: string }[];
    task: { slug: string; name?: string; form: string }[];
    assessment: { slug: string; name?: string; form: string }[];
  },
): void {
  for (const type of Object.keys(TYPE_KEYS) as (keyof typeof TYPE_KEYS)[]) {
    const re = new RegExp(BLOCK_PATTERNS[type].source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      // The pattern has 3 alternative groups, each yielding (id, inner).
      // Whichever alternative matched, exactly one (id, inner) pair is set.
      const slug = m[1] ?? m[3] ?? m[5];
      const inner = m[2] ?? m[4] ?? m[6] ?? '';
      if (!slug) continue;
      const name = extractInner(inner, 'name');
      const description = extractInner(inner, 'description');
      const timeStr = extractInner(inner, 'time_estimate');
      const time_estimate = timeStr !== undefined && timeStr !== '' ? Number(timeStr) : undefined;

      hits[type].push({ slug, name, form: formPath });
      if (!records[type].has(slug)) {
        // First-seen wins (matches get_or_create / update_or_create semantics).
        const rec: ProjectedRecord = { slug, first_seen_in: formPath };
        if (name !== undefined) rec.name = name;
        if (type === 'module' || type === 'task') {
          if (description !== undefined) rec.description = description;
        }
        if (type === 'module' && time_estimate !== undefined && !Number.isNaN(time_estimate)) {
          rec.time_estimate = time_estimate;
        }
        records[type].set(slug, rec);
      }
    }
  }
}

function collisionsFor(
  hits: { slug: string; name?: string; form: string }[],
): ProjectedCollision[] {
  const bySlug = new Map<string, { slug: string; name?: string; form: string }[]>();
  for (const h of hits) {
    const arr = bySlug.get(h.slug) ?? [];
    arr.push(h);
    bySlug.set(h.slug, arr);
  }
  const out: ProjectedCollision[] = [];
  for (const [slug, hs] of bySlug) {
    if (hs.length < 2) continue;
    const [kept, ...dropped] = hs;
    out.push({
      slug,
      kept: { name: kept.name, form: kept.form },
      dropped: dropped.map((h) => ({ name: h.name, form: h.form })),
      forms: hs.map((h) => h.form),
    });
  }
  return out;
}

/**
 * Patch the empty `<user_score/>` element inside a Connect `<assessment>`
 * block to point at `/data/total_score` (the Nova-emitted score-aggregator
 * node). Returns `{ patched, xml }` — `patched` is true iff the function
 * actually rewrote at least one element (so the caller can decide whether
 * to skip the re-upload entirely).
 *
 * Why this exists: Nova's autobuild always emits `<user_score/>` (empty)
 * inside the assessment block of every quiz form, even when the blueprint
 * declares `connect.assessment.user_score: "/data/total_score"`. Connect's
 * runtime treats the element's text content as the XPath into the form
 * data, so an empty element makes `/opportunity/init/` 500 with no useful
 * server-side message. Tracker: nova-plugin#5 (compile_app render gap),
 * nova-plugin#6 (`connect: null` on a quiz form gets auto-restored). Both
 * upstream blockers gate ACE Phase 4 today.
 *
 * Match scope: only `<user_score/>` elements that appear inside an
 * `<assessment ... xmlns="http://commcareconnect.com/data/v1/learn">`
 * block. We intentionally don't touch unrelated `<user_score>` elements
 * elsewhere in the form (none exist in current Nova output, but the
 * scoping guard makes the patch safe to re-run on any form).
 *
 * Re-running on an already-patched form is a no-op (returns
 * `{ patched: false, xml }` because the matcher only fires on empty/
 * `<user_score />` shapes).
 *
 * Exported for unit tests + the `commcare-form-patch` skill.
 */
export function applyUserScorePatch(xml: string): { patched: boolean; xml: string } {
  // Find each <assessment ... xmlns="...connect..."> ... </assessment> block
  // and rewrite an empty <user_score/> inside. Capture group 1 is the leading
  // tag + attrs, 2 is the body, 3 is the closing tag — we do the body rewrite
  // in JS then reassemble. Multi-line `s` flag (or [\s\S]) for nested newlines.
  const assessmentRe = /(<assessment\b[^>]*xmlns="http:\/\/commcareconnect\.com\/data\/v1\/learn"[^>]*>)([\s\S]*?)(<\/assessment>)/g;
  // Inside the body, match either <user_score/> or <user_score /> or
  // <user_score></user_score>. We only patch the EMPTY shape; never overwrite
  // a populated element (so the helper is idempotent + safe to re-run).
  const emptyUserScoreRe = /<user_score\s*\/>|<user_score\s*>\s*<\/user_score>/g;

  let patchedAny = false;
  const newXml = xml.replace(assessmentRe, (match, open, body, close) => {
    const newBody = body.replace(emptyUserScoreRe, () => {
      patchedAny = true;
      return '<user_score>/data/total_score</user_score>';
    });
    return `${open}${newBody}${close}`;
  });
  return { patched: patchedAny, xml: newXml };
}

/**
 * Strip wrapper elements that hold a single `commcareconnect`-namespaced
 * inner element (`<assessment>` on quiz forms, `<module>` on learn forms,
 * `<deliver>`/`<task>` on deliver forms) plus their `<bind>` references.
 * Returns `{ patched, xml, removedWrappers }` — `patched` is true iff the
 * function actually removed at least one wrapper.
 *
 * Why this exists (root-cause finding 2026-05-03): the `user-score` patch
 * alone does NOT unblock Connect's `/opportunity/init/`. Connect's parser
 * rejects ANY Learn app whose forms carry `commcareconnect`-namespaced
 * markup of any kind — `<assessment>` on quiz forms, `<module>` on learn
 * forms, etc. The reference working app (Turmeric Learn
 * `76fd5f0e2834454bb946bdf9ae9bff71`) has ZERO `commcareconnect`
 * references in suite.xml, profile.ccpr, or any form XML — its quiz forms
 * encode the score as a plain `<user_score/>` field calculated via
 * `<bind ... calculate=...>`, and learn forms have no module markup at
 * all. Connect derives the assessment/module relationship from the
 * suite-level metadata, not from in-form markup. Nova's renderer emits
 * the in-form markup anyway (nova-plugin#5/#6 + suspected #7).
 *
 * Surgical rewrite: for each wrapper element whose body is exactly one
 * connect-namespaced inner element (`<X xmlns="…connect…">…</X>`), drop
 * the wrapper (open through close) AND any
 * `<bind nodeset="/data/<wrapper>…"/>` binds that reference it.
 * Idempotent — re-running on a clean form is a no-op.
 *
 * Match scope: ONLY wrappers that contain a single child which is a
 * `commcareconnect`-namespaced element. Wrappers around unrelated
 * content (or around connect-namespaced content with siblings) are
 * untouched.
 *
 * Exported for unit tests + the `commcare-form-patch` skill.
 */
export function applyAssessmentRemovalPatch(
  xml: string,
): { patched: boolean; xml: string; removedWrappers: string[] } {
  // Match a wrapper element that contains exactly one connect-namespaced
  // `<assessment>` inner element. Capture group 1 = leading newline+indent
  // (drop blank lines), 2 = wrapper element name, 3 = literal "assessment"
  // (used for the closing-tag backref so the match is well-formed XML).
  //
  // The inner-element capture is restricted to literal `assessment` since
  // 0.13.206 — prior versions used `[A-Za-z_][\w\-.]*` which also matched
  // `<learn:module>` wrappers and silently destroyed Learn-app module
  // markers. The post-patch CCZ ended up with `connect_markers.module: 0`
  // even when Nova emitted modules correctly, and Connect's `Sync
  // Deliver Units` reported "No learning required" because the CCZ
  // genuinely had no learn:module elements left.
  //
  // Diagnosed live on turmeric run 20260513-0616 Phase 6 retry — Learn
  // build v14 (post-patch) had 13 forms patched and zero surviving
  // module markers. See `applyAssessmentRemovalPatch over-stripped
  // learn:module elements` regression test.
  const wrapperRe =
    /(\n[ \t]*)?<([A-Za-z_][\w\-.]*)>\s*<(assessment)\b[^>]*xmlns="http:\/\/commcareconnect\.com\/[^"]*"[^>]*>[\s\S]*?<\/\3>\s*<\/\2>/g;

  const removed: string[] = [];
  let xml1 = xml.replace(wrapperRe, (_match, _lead, name) => {
    removed.push(name);
    return '';
  });

  if (removed.length === 0) {
    return { patched: false, xml, removedWrappers: [] };
  }

  // Strip the binds that reference the removed wrappers. Bind shapes:
  //   <bind nodeset="/data/<wrapper>"/>
  //   <bind nodeset="/data/<wrapper>/assessment/user_score" calculate="…"/>
  // Always single-line, always self-closing in CCHQ output. Match the leading
  // newline+indent so we don't leave blank lines either.
  for (const name of removed) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `[^>]*` (not `[^/>]*`) — bind attrs can carry XPath values like
    // calculate="/data/total_score" that contain forward slashes.
    const bindRe = new RegExp(
      `(\\n[ \\t]*)?<bind\\s+nodeset="/data/${escaped}(?:/[^"]*)?"[^>]*\\/>`,
      'g',
    );
    xml1 = xml1.replace(bindRe, '');
  }

  return { patched: true, xml: xml1, removedWrappers: removed };
}

// ── Post-patch CCZ marker verification ────────────────────────────────
//
// Class-level preventer for the bug class that landed on turmeric run
// 20260513-0616 Phase 6: `commcare-form-patch` reported success while
// the post-patch CCZ had zero `<learn:module>` elements (the broken
// pre-0.13.206 regex stripped module wrappers along with assessment
// wrappers). Phase 2 marked `gates.commcare-setup: passed` and the
// downstream symptom only surfaced two phases later as "No learning
// required" in the Connect FLW home.
//
// The preventer: every caller of `applyAssessmentRemovalPatch` MUST
// run this assertion AFTER re-building + re-releasing the CCZ. If a
// marker the source declared went to zero in the post-patch CCZ,
// throw with a precise class name — the operator (or future MCP
// atom) rolls back to the prior build rather than shipping a build
// missing markers Connect needs.

export interface ConnectMarkerCounts {
  deliver: number;
  module: number;
  task: number;
  assessment: number;
}

export class PostPatchMarkerLossError extends Error {
  constructor(
    public readonly droppedToZero: Array<keyof ConnectMarkerCounts>,
    public readonly pre: ConnectMarkerCounts,
    public readonly post: ConnectMarkerCounts,
  ) {
    super(
      `Post-patch CCZ is missing markers the source declared: ${droppedToZero.join(', ')}. ` +
        `pre=${JSON.stringify(pre)} post=${JSON.stringify(post)}. ` +
        `Roll back the released build and investigate the patcher (mcp/connect/backends/commcare.ts:applyAssessmentRemovalPatch).`,
    );
    this.name = 'PostPatchMarkerLossError';
  }
}

/**
 * Assert that the post-patch CCZ retained the markers Connect needs.
 * Throws `PostPatchMarkerLossError` if any marker the source declared
 * went to zero. Module markers MUST survive (the patcher's documented
 * scope is assessment-only); assessment markers MAY decrease (that's
 * the patcher's job) but should not go to zero if the source had any
 * assessments. Deliver/task counts MUST be unchanged (the patcher
 * doesn't touch Deliver-app forms).
 *
 * Callers (the `commcare-form-patch` skill orchestration today, a
 * future `commcare_patch_xform` MCP atom tomorrow) MUST run this
 * after re-build + re-release and before flipping the
 * `commcare-form-patch.status: done` in run_state.yaml.
 */
export function assertPostPatchMarkersSurvive(
  pre: ConnectMarkerCounts,
  post: ConnectMarkerCounts,
): void {
  const droppedToZero: Array<keyof ConnectMarkerCounts> = [];
  // Module markers: zero tolerance for drops. The patcher's scope is
  // assessment-only; module wrappers MUST survive.
  if (pre.module > 0 && post.module === 0) droppedToZero.push('module');
  // Deliver / task: untouched by the Learn-only patch scope. Going to
  // zero is a regression even if the source had any.
  if (pre.deliver > 0 && post.deliver === 0) droppedToZero.push('deliver');
  if (pre.task > 0 && post.task === 0) droppedToZero.push('task');
  // Assessment markers are NOT asserted here. The patcher's documented
  // job is to strip in-form `<assessment xmlns="...connect">` wrappers,
  // and Connect derives assessment relationships from suite-level
  // module/form metadata — not from in-form markup the patcher targets.
  //
  // Nova-shaped Learn apps emit zero `<learn:assessment>` suite-level
  // refs (verified live on turmeric run 20260513-2243), so the
  // pre-patch `assessment` count is purely the in-form wrappers the
  // patcher will strip. Driving `assessment` to zero is the patcher
  // succeeding, not a regression. Asserting on it produced a false-
  // positive halt on a correctly-patched build (turmeric 20260513-2243
  // Phase 3 commcare-form-patch step).
  //
  // If a future Nova / CCHQ release starts emitting suite-level
  // assessment refs that the patcher should preserve, reintroduce the
  // assertion with the distinction "wrapper count" vs "suite-ref count"
  // measured separately — see `computeConnectMarkers` for the place to
  // split the regex.
  if (droppedToZero.length > 0) {
    throw new PostPatchMarkerLossError(droppedToZero, pre, post);
  }
}
