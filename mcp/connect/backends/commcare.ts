import type { APIRequestContext, APIResponse } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { PlaywrightSession } from '../auth/playwright-session.js';
import { SessionExpiredError } from '../errors.js';
import { resolvePluginDataDir } from '../../../lib/plugin-data-dir.js';

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
}

export interface MakeBuildArgs {
  domain: string;
  app_id: string;
  comment?: string;
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
  /**
   * Absolute path to the on-disk CCZ. Written under
   * `${CLAUDE_PLUGIN_DATA}/ccz-cache/<build_id|app_id>-<status>-<sha8>.ccz`.
   * Replaces the pre-0.13.116 inline `ccz_base64` payload, which the MCP
   * transport silently truncated above ~10K-token responses.
   * Callers should open this path directly. The file is left in place;
   * callers are responsible for cleanup if they need it.
   */
  ccz_path?: string;
  /** Hex-encoded sha256 of the CCZ bytes. Useful for de-dup / cache invalidation. */
  ccz_sha256?: string;
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
        throw new Error(
          `commcare_make_build POST ${path} returned 200 but no build _id in saved_app. ` +
            `This shape changes when the app fails XForm well-formedness — body: ${JSON.stringify(parsed).slice(0, 400)}`,
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
      // Always persist bytes to disk and return a path. Inline base64 was
      // removed in 0.13.116 because the MCP transport silently truncated
      // large base64 payloads (~10K-token cap) — a 29 KB CCZ came back
      // missing 2.5 KB of trailing bytes, which made every `unzip` reject
      // the file. Callers now read from `ccz_path`.
      const sha = createHash('sha256').update(buf).digest('hex');
      const sha8 = sha.slice(0, 8);
      const idForName = args.build_id ?? args.app_id;
      const status_label = args.build_id ? 'build' : 'release';
      const ccz_path = writeCczToCache(buf, `${idForName}-${status_label}-${sha8}.ccz`);

      // Skip marker grep on > 25 MB CCZs (cheap CCZ-on-disk; expensive
      // inflate). The caller still gets `ccz_path` and can inspect the
      // archive directly if needed.
      if (size > 25 * 1024 * 1024) {
        return { status, size_bytes: size, ccz_path, ccz_sha256: sha };
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
        ccz_path,
        ccz_sha256: sha,
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
 * Resolve the on-disk cache directory for downloaded CCZs and write
 * `buf` to `<cache>/<filename>`. Falls back to `os.tmpdir()/ace-ccz-cache`
 * when `${CLAUDE_PLUGIN_DATA}` is unresolvable (test environments). Creates
 * the directory recursively. Returns the absolute path written.
 *
 * Exported for unit tests.
 */
export function writeCczToCache(buf: Buffer, filename: string): string {
  const dataDir = resolvePluginDataDir(import.meta.url) ?? path.join(os.tmpdir(), 'ace-ccz-cache-fallback');
  const cacheDir = path.join(dataDir, 'ccz-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, filename);
  fs.writeFileSync(out, buf);
  return out;
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

  return {
    deliver_units: Array.from(records.deliver.values()),
    learn_modules: Array.from(records.module.values()),
    task_units: Array.from(records.task.values()),
    assessments: Array.from(records.assessment.values()),
    collisions,
    collision_count,
  };
}

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
 * upstream blockers gate ACE Phase 3 today.
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
  // inner element. Capture group 1 = leading newline+indent (drop blank
  // lines), 2 = wrapper element name, 3 = inner element name (used for
  // the closing-tag backref so we match well-formed XML).
  const wrapperRe =
    /(\n[ \t]*)?<([A-Za-z_][\w\-.]*)>\s*<([A-Za-z_][\w\-.]*)\b[^>]*xmlns="http:\/\/commcareconnect\.com\/[^"]*"[^>]*>[\s\S]*?<\/\3>\s*<\/\2>/g;

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
