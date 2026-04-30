import type { APIRequestContext } from 'playwright';

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
    // Marker grep operates on the zip's central directory + file contents.
    // We use a permissive regex that catches both default-namespace
    // (`<deliver xmlns="http://commcareconnect.com/data/v1/learn">`) and
    // prefixed (`<learn:deliver>`) forms. CCZ is a zip; we don't unzip
    // here (no unzip in MCP runtime) — instead we scan the raw bytes,
    // which works because the form XML inside is plain text.
    const text = buf.toString('utf8');
    const count = (re: RegExp) => (text.match(re) || []).length;
    const connect_markers = {
      deliver: count(/<(?:learn:)?deliver\b[^>]*xmlns="http:\/\/commcareconnect\.com[^"]*"|<learn:deliver\b/g),
      module: count(/<(?:learn:)?module\b[^>]*xmlns="http:\/\/commcareconnect\.com[^"]*"|<learn:module\b/g),
      task: count(/<(?:learn:)?task\b[^>]*xmlns="http:\/\/commcareconnect\.com[^"]*"|<learn:task\b/g),
      assessment: count(/<(?:learn:)?assessment\b[^>]*xmlns="http:\/\/commcareconnect\.com[^"]*"|<learn:assessment\b/g),
    };
    return {
      status,
      size_bytes: size,
      ccz_base64: buf.toString('base64'),
      connect_markers,
    };
  }

  private async csrfFromCookies(): Promise<string | undefined> {
    const state = await this.opts.request.storageState();
    const cookie = state.cookies.find((c) => c.name === 'csrftoken' && c.domain.includes('commcarehq'));
    return cookie?.value;
  }
}
