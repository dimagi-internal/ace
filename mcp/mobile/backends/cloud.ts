// CloudBackend — drives the ACE cloud emulator (an EC2-hosted Android
// AVD owned by ace-web) over HTTP. The shape matches the AvdBackend +
// MaestroBackend pair so it can drop in behind MobileClient without
// any skill-level changes.
//
// Talks to ace-web's `/api/mobile/*` endpoints (Bearer auth via PAT).
// Recipes are POSTed as the literal YAML string in the request body —
// no shared filesystem with the runner. Screenshots come back as
// 1-hour-TTL S3 presigned URLs which this backend downloads to the
// caller's local screenshotDir, so callers see the same on-disk
// shape they'd see from MaestroBackend.
//
// Env config:
//   ACE_WEB_BASE_URL   — e.g. https://labs.connect.dimagi.com/ace
//   ACE_WEB_PAT_TOKEN  — PersonalToken minted via /ace:ace-web-pat-mint
//
// State model (post-2026-05-10 pivot away from AMI-baked snapshots):
//   The AMI bakes one *state* per CommCare APK version (declared in
//   /opt/ace/states.yaml on the instance). A state is just "this APK
//   is pre-installed". Each `/api/mobile/ensure-running` call cold-boots
//   the AVD and runs the registration recipes against it, producing a
//   fresh demo user every time (~3-4 minutes). The "AVD name" parameter
//   on MobileBackend's API is meaningless on cloud — there's one AVD per
//   ace-web tenant — but if it looks like a state name ("cc-2.62.0") we
//   forward it as the desired state. save/loadSnapshot do still work,
//   but they're session-scoped runtime snapshots (not persisted across
//   instance stop) — useful for within-run checkpoints, not for AMI bakes.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  MobileError,
  AvdBootError,
  RecipeValidationError,
} from '../errors.js';
import type {
  AvdInfo,
  ApkInfo,
  RecipeRunResult,
  ScreenshotEntry,
  StepResult,
  UiDumpResult,
  SnapshotResult,
} from '../types.js';

export interface CloudBackendOpts {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /**
   * Default state to request when callers pass no explicit AVD name.
   * Empty string means "let ace-web pick the AMI's `default` state".
   */
  defaultState?: string;
  /**
   * Per-request timeout in milliseconds. ace-web's `/api/mobile/ensure-running`
   * is a long-poll — server-side it waits up to 5 min for the in-instance
   * ready marker on cold boot. Bun's fetch enforces a default network
   * timeout (~5 min) that races this; default here is 10 min so legitimate
   * cold boots don't trip the client.
   */
  requestTimeoutMs?: number;
}

/** Shape of `/api/mobile/states`'s response data. */
export interface CloudState {
  name: string;
  snapshot: string;
  commcare_version: string;
  description?: string;
}

export interface CloudStatesCatalog {
  default: string;
  active: string | null;
  states: CloudState[];
}

/** Shape of `/api/mobile/run-recipe`'s response data. */
interface CloudArtifact {
  name: string;
  presigned_url: string;
  content_type: string;
}

interface CloudStep {
  index: number;
  name: string;
  status: string;            // 'pass' | 'fail' | 'skipped' | 'unknown' — narrowed at the boundary
  screenshot?: string | null;
  error?: string | null;
  duration_ms?: number | null;
}

interface CloudRunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  artifacts: CloudArtifact[];
  /** Optional — only present when ace-web parsed Maestro's commands JSON. */
  steps?: CloudStep[];
}

interface RunningState {
  instance_id: string;
  state: string; // EC2 state, NOT mobile state — confusing but it's what the API returns
  public_dns: string | null;
  started_at: string;
}

export class CloudBackend {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  readonly defaultState: string;

  constructor(opts: CloudBackendOpts = {}) {
    const baseUrl = opts.baseUrl ?? process.env.ACE_WEB_BASE_URL ?? '';
    const token = opts.token ?? process.env.ACE_WEB_PAT_TOKEN ?? '';
    if (!baseUrl) {
      throw new MobileError(
        'CLOUD_NOT_CONFIGURED',
        'ACE_WEB_BASE_URL is required for the cloud mobile backend',
        'Set ACE_WEB_BASE_URL to your ace-web deployment, e.g. https://labs.connect.dimagi.com/ace.',
      );
    }
    if (!token) {
      throw new MobileError(
        'CLOUD_NOT_CONFIGURED',
        'ACE_WEB_PAT_TOKEN is required for the cloud mobile backend',
        'Mint a PAT via /ace:ace-web-pat-mint and export ACE_WEB_PAT_TOKEN.',
      );
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultState = opts.defaultState ?? '';
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 600_000;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async ensureAvdRunning(name: string): Promise<AvdInfo> {
    const stateName = this.resolveState(name);
    const body: Record<string, string> = {};
    if (stateName) body.state = stateName;
    const result = await this.post<RunningState>('/api/mobile/ensure-running', body);
    return {
      name: stateName || name || 'cloud',
      // The cloud AVD is local to the EC2 instance; expose a synthetic
      // serial so callers that interpolate it into log lines get
      // something stable.
      serial: `cloud:${result.instance_id}`,
      status: 'booted',
    };
  }

  /**
   * Stop the cloud instance.
   *
   * Since ace-web #309, `/api/mobile/stop` refuses (503 singleton-busy)
   * if a recipe is in flight. Pass `force: true` to override — the
   * explicit "abort hung recipe" path. Plain accidental stops from a
   * concurrent skill now surface as a typed error instead of silently
   * killing the holder's flow.
   */
  async stopAvd(_name: string, opts: { force?: boolean } = {}): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts.force) body.force = true;
    await this.post<unknown>('/api/mobile/stop', body);
  }

  /**
   * On the cloud the "AVDs" the operator can pick are *named states*
   * (one per CommCare version baked into the AMI). Returning the
   * state names here lets the existing `mobile_list_avds` atom show
   * what's available without inventing a new atom.
   */
  async listAvds(): Promise<string[]> {
    const catalog = await this.listStates();
    return catalog.states.map((s) => s.name);
  }

  async listStates(): Promise<CloudStatesCatalog> {
    return this.get<CloudStatesCatalog>('/api/mobile/states');
  }

  // ── APK ─────────────────────────────────────────────────────────

  /**
   * Install an APK on the running cloud AVD.
   *
   * Note: the cold-boot path already installs the state's baked CommCare
   * APK (one per state in `/opt/ace/states.yaml`). This atom is for
   * *additional* APKs — release candidates, sibling apps, etc.
   *
   * `apk` must be an HTTPS URL the runner can fetch. Local paths are
   * not yet auto-uploaded — pre-upload to S3 (presigned PUT URL flow,
   * helper TODO) and pass the URL here.
   */
  async installApk(_avdName: string, apk: string): Promise<ApkInfo> {
    if (!/^https?:/.test(apk)) {
      throw new MobileError(
        'CLOUD_APK_LOCAL_PATH_UNSUPPORTED',
        `cloud installApk needs an HTTPS URL, got ${apk}`,
        'Upload the APK to S3 first (presigned PUT URL flow) and pass the URL here.',
      );
    }
    const result = await this.post<{
      package_name: string;
      version: string;
      version_code?: number;
    }>('/api/mobile/install-apk', { apk_url: apk });
    return {
      packageId: result.package_name,
      versionName: result.version,
      // ace-web surfaces version_code since #307; defaults to 0 if the
      // ace-web aapt parse didn't find it (shouldn't happen for valid
      // APKs). Older ace-web versions don't return the field at all —
      // we treat undefined the same as 0.
      versionCode: result.version_code ?? 0,
      path: apk,
    };
  }

  async uninstallApk(_avdName: string, _pkg: string): Promise<{ uninstalled: boolean }> {
    throw new MobileError(
      'CLOUD_UNSUPPORTED',
      'uninstallApk is not exposed by the cloud API',
      'Stop and re-start the instance to reset state, or rebuild the AMI without the APK.',
    );
  }

  // ── Snapshots ───────────────────────────────────────────────────
  //
  // Session-scoped: `adb emu avd snapshot save/load` writes to the
  // running emulator's QEMU disk, which lives on the EC2 instance's
  // root volume but is NOT persisted across instance stop/start (the
  // instance cold-boots fresh from the AMI on every start). Useful as
  // a within-run checkpoint — e.g. save before a destructive step and
  // load to retry — not as a persisted demo seed.

  async saveSnapshot(_avdName: string, snapshotName: string): Promise<SnapshotResult> {
    const result = await this.post<{ name: string; saved_at: string }>(
      '/api/mobile/save-snapshot',
      { name: snapshotName },
    );
    return {
      avdName: 'cloud',
      snapshotName: result.name,
      saved: true,
      output: `saved at ${result.saved_at}`,
    };
  }

  async loadSnapshot(_avdName: string, snapshotName: string): Promise<SnapshotResult> {
    const result = await this.post<{ name: string; loaded_at: string }>(
      '/api/mobile/load-snapshot',
      { name: snapshotName },
    );
    return {
      avdName: 'cloud',
      snapshotName: result.name,
      saved: true,
      output: `loaded at ${result.loaded_at}`,
    };
  }

  // ── UI dump ─────────────────────────────────────────────────────

  async captureUiDump(_avdName: string): Promise<UiDumpResult> {
    const result = await this.post<{
      xml: string;
      elements?: Array<{ id?: string; text?: string; class?: string; bounds?: string }>;
    }>('/api/mobile/capture-ui-dump', {});
    // ace-web parses the XML server-side since #308. Older ace-web
    // versions omit `elements`; surface an empty list in that case so
    // the call site doesn't need to defend against undefined.
    return { xml: result.xml, elements: result.elements ?? [] };
  }

  // ── Recipe execution ────────────────────────────────────────────

  /**
   * Run a Maestro recipe against the cloud AVD.
   *
   * `recipePath` is read from the local filesystem and POSTed as
   * `recipe_yaml` — ace-web has no shared FS with the plugin. Screenshot
   * artifacts come back as 1-hour-TTL S3 presigned URLs which we
   * download into `screenshotDir` so callers see the same on-disk
   * shape they'd see from MaestroBackend.
   */
  async runRecipe(
    recipePath: string,
    env: Record<string, string>,
    screenshotDir: string,
    opts: { state?: string; screenshotPrefix?: string } = {},
  ): Promise<RecipeRunResult> {
    let recipeYaml: string;
    try {
      recipeYaml = await fs.readFile(recipePath, 'utf8');
    } catch (e: unknown) {
      throw new RecipeValidationError(recipePath, `failed to read recipe: ${(e as Error).message}`);
    }

    const body: Record<string, unknown> = {
      recipe_yaml: recipeYaml,
      env: env || {},
    };
    if (opts.screenshotPrefix) body.screenshot_prefix = opts.screenshotPrefix;
    else body.screenshot_prefix = path.basename(recipePath, path.extname(recipePath));
    if (opts.state ?? this.defaultState) body.state = opts.state ?? this.defaultState;

    const result = await this.post<CloudRunResult>('/api/mobile/run-recipe', body);

    await fs.mkdir(screenshotDir, { recursive: true });
    const screenshots: ScreenshotEntry[] = [];
    for (const art of result.artifacts) {
      // Skip non-image artifacts — they go alongside but ScreenshotEntry
      // is specifically images per the type.
      const dest = path.join(screenshotDir, art.name);
      const bytes = await this.downloadTo(art.presigned_url, dest);
      if (art.content_type.startsWith('image/')) {
        screenshots.push({
          stepName: art.name.replace(/\.[a-z0-9]+$/i, ''),
          path: dest,
          takenAt: new Date().toISOString(),
          bytes,
        });
      }
    }

    return {
      status: result.exit_code === 0 ? 'pass' : 'fail',
      exitCode: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      screenshotsDir: screenshotDir,
      screenshots,
      steps: result.steps ? result.steps.map(normalizeCloudStep) : undefined,
    };
  }

  // ── HTTP plumbing ───────────────────────────────────────────────

  private resolveState(avdName: string): string {
    // The atom-level avdName is meaningless on cloud (one AVD per
    // tenant). If it looks like one of our state names ("cc-x.y.z" —
    // see /opt/ace/states.yaml on the runner) we forward it as the
    // requested state, otherwise fall back to the configured default
    // (empty string = "let ace-web pick the AMI's default state").
    if (avdName?.startsWith('cc-')) return avdName;
    return this.defaultState;
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(routePath: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${routePath}`;
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    headers.set('accept', 'application/json');

    // Explicit AbortSignal so Bun's default network idle timeout
    // (~5 min) doesn't race the legitimate cold-boot wait on
    // /api/mobile/ensure-running. init.signal wins if the caller
    // already passed one.
    const signal = init.signal ?? AbortSignal.timeout(this.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers, signal });
    } catch (e: unknown) {
      throw new MobileError(
        'CLOUD_FETCH_FAILED',
        `request to ${url} failed: ${(e as Error).message}`,
        'Check ACE_WEB_BASE_URL and your network reachability.',
      );
    }

    const text = await response.text();
    let payload: { data?: T; error?: { code: string; message: string } } = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // ace-web should always envelope; non-JSON likely means an
        // upstream gateway returned its own error page.
        throw new MobileError(
          'CLOUD_BAD_RESPONSE',
          `non-JSON response from ${url} (status ${response.status})`,
        );
      }
    }

    if (!response.ok || payload.error) {
      const code = payload.error?.code ?? `HTTP_${response.status}`;
      const message = payload.error?.message ?? `${url} returned ${response.status}`;
      // Map a few well-known codes to typed errors so skill-level
      // retry/abort logic works without string-matching.
      if (code === 'boot-timeout') {
        throw new AvdBootError('cloud', message);
      }
      throw new MobileError(`CLOUD_${code.toUpperCase().replace(/-/g, '_')}`, message);
    }

    return payload.data as T;
  }

  private async downloadTo(url: string, dest: string): Promise<number> {
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch (e: unknown) {
      throw new MobileError(
        'CLOUD_DOWNLOAD_FAILED',
        `failed to fetch ${url}: ${(e as Error).message}`,
      );
    }
    if (!response.ok) {
      throw new MobileError(
        'CLOUD_DOWNLOAD_FAILED',
        `S3 GET ${url} returned ${response.status}`,
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(dest, buf);
    return buf.byteLength;
  }
}


// ── helpers ────────────────────────────────────────────────────────────


const VALID_STEP_STATUSES: ReadonlySet<StepResult['status']> = new Set([
  'pass',
  'fail',
  'skipped',
  'unknown',
]);


/**
 * Coerce a CloudStep (which has loose `string` status and `null`-able
 * optionals) into the typed StepResult. Unknown statuses fall through
 * to 'unknown' so a future ace-web version emitting a new value can't
 * crash the cloud backend.
 */
function normalizeCloudStep(s: {
  index: number;
  name: string;
  status: string;
  screenshot?: string | null;
  error?: string | null;
  duration_ms?: number | null;
}): StepResult {
  const status: StepResult['status'] = VALID_STEP_STATUSES.has(s.status as StepResult['status'])
    ? (s.status as StepResult['status'])
    : 'unknown';
  return {
    index: s.index,
    name: s.name,
    status,
    screenshot: s.screenshot ?? undefined,
    error: s.error ?? undefined,
    durationMs: s.duration_ms ?? undefined,
  };
}
