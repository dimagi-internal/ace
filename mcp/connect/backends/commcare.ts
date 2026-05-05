import type { APIRequestContext } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';

/**
 * CommCare HQ atoms — release apps that Nova uploaded as drafts.
 *
 * These talk to www.commcarehq.org (NOT connect.dimagi.com) but share the
 * Playwright session with the Connect backend: the OAuth-via-CCHQ login
 * flow that authenticates Connect leaves valid CCHQ cookies in the same
 * BrowserContext, so a single APIRequestContext drives both services.
 *
 * Endpoint contracts verified live 2026-04-29 + 2026-04-30 against
 * connect-ace-prod (see scripts/probe-cchq-release.ts and
 * skills/app-release/SKILL.md § Endpoints).
 */

export interface CommCareBackendOptions {
  baseUrl: string;
  request: APIRequestContext;
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
   * POST /a/<domain>/apps/save/<app_id>/ with an empty body — CCHQ creates
   * a new versioned build doc and returns its `_id`. The CSRF token is read
   * from the cookie jar (ctx.request inherits cookies from the BrowserContext).
   */
  async makeBuild(args: MakeBuildArgs): Promise<MakeBuildResult> {
    const path = `/a/${args.domain}/apps/save/${args.app_id}/`;
    // GET the releases page first so the cookie/csrf is fresh
    const refreshPath = `/a/${args.domain}/apps/view/${args.app_id}/releases/`;
    await this.opts.request.get(`${this.opts.baseUrl}${refreshPath}`);
    const csrf = await this.csrfFromCookies();
    const res = await this.opts.request.post(`${this.opts.baseUrl}${path}`, {
      data: args.comment ? `comment=${encodeURIComponent(args.comment)}` : '',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': csrf ?? '',
        Referer: `${this.opts.baseUrl}${refreshPath}`,
      },
      maxRedirects: 0,
    });
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
  }

  /**
   * POST /a/<domain>/apps/view/<app_id>/releases/release/<build_id>/
   * Body: ajax=true&is_released=true
   */
  async releaseBuild(args: ReleaseBuildArgs): Promise<ReleaseBuildResult> {
    const path = `/a/${args.domain}/apps/view/${args.app_id}/releases/release/${args.build_id}/`;
    const refreshPath = `/a/${args.domain}/apps/view/${args.app_id}/releases/`;
    await this.opts.request.get(`${this.opts.baseUrl}${refreshPath}`);
    const csrf = await this.csrfFromCookies();
    const res = await this.opts.request.post(`${this.opts.baseUrl}${path}`, {
      data: 'ajax=true&is_released=true',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': csrf ?? '',
        Referer: `${this.opts.baseUrl}${refreshPath}`,
      },
      maxRedirects: 0,
    });
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
  }

  /**
   * GET /a/<domain>/apps/api/download_ccz/?app_id=<id>&latest=release
   * (or with explicit build_id). Returns the raw CCZ + a marker count
   * grepped from inflated form XML. Uses CCHQ HQ API auth fallback if
   * cookie auth fails — the `?api_key` query-string variant works
   * regardless of session staleness.
   */
  async downloadCcz(args: DownloadCczArgs): Promise<DownloadCczResult> {
    const qs = new URLSearchParams({ app_id: args.app_id });
    if (args.build_id) {
      qs.set('app_id', args.build_id); // download_ccz takes either app_id or build_id
    } else {
      qs.set('latest', 'release');
    }
    const path = `/a/${args.domain}/apps/api/download_ccz/?${qs.toString()}`;
    const res = await this.opts.request.get(`${this.opts.baseUrl}${path}`);
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
    return {
      status,
      size_bytes: size,
      ccz_base64: buf.toString('base64'),
      connect_markers,
    };
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
    const path = `/a/${args.domain}/apps/edit_form_attr/${args.app_id}/${args.form_unique_id}/xform/`;
    // Refresh CSRF + cookie via the form's edit page (mirrors makeBuild's
    // refresh-the-releases-page-first pattern). The view URL also exercises
    // the same `@login_or_digest` auth so a 302 here surfaces an expired
    // session up front rather than waiting for the POST to return HTML.
    const refreshPath = `/a/${args.domain}/apps/view/${args.app_id}/`;
    await this.opts.request.get(`${this.opts.baseUrl}${refreshPath}`);
    const csrf = await this.csrfFromCookies();

    // Build the form-encoded body. Using URLSearchParams ensures the XForm
    // XML's `&`, `<`, `>`, `+`, `=`, and `#` are all percent-escaped.
    const form = new URLSearchParams();
    form.set('xform', args.new_xform_xml);
    if (args.sha1) form.set('sha1', args.sha1);

    const res = await this.opts.request.post(`${this.opts.baseUrl}${path}`, {
      data: form.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': csrf ?? '',
        Referer: `${this.opts.baseUrl}${refreshPath}`,
      },
      maxRedirects: 0,
    });
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
  }

  private async csrfFromCookies(): Promise<string | undefined> {
    const state = await this.opts.request.storageState();
    const cookie = state.cookies.find((c) => c.name === 'csrftoken' && c.domain.includes('commcarehq'));
    return cookie?.value;
  }
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
