// Shared plumbing for the two REMOTE mobile backends — `cloud.ts` (legacy
// ace-web `/api/mobile`) and `lease.ts` (canopy-web capability leases).
//
// Both drive an emulator they cannot see, over HTTP, and both hand callers
// the same on-disk shape MaestroBackend produces: artifacts downloaded from
// presigned URLs into the caller's screenshotDir, images surfaced as
// ScreenshotEntry. Extracted from cloud.ts so the second backend reuses the
// retry envelope, the download, the artifact-name containment (ace#1110) and
// the step normalisation instead of copying them — a copy would inherit none
// of the next fix.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isSafeArtifactName } from '../../../lib/contained-path.js';
import { MobileError } from '../errors.js';
import type { ScreenshotEntry, StepResult } from '../types.js';

export interface RetryConfig {
  /** Extra attempts after the first (2 → 3 attempts total). */
  retries: number;
  /** First backoff; doubles per attempt (250 ms, 500 ms, …). */
  backoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

export interface RetryOpts {
  retries?: number;
  backoffMs?: number;
  /** Hook for tests; defaults to setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export function resolveRetry(opts: RetryOpts | undefined): RetryConfig {
  return {
    retries: opts?.retries ?? 2,
    backoffMs: opts?.backoffMs ?? 250,
    sleep: opts?.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

export interface FetchOutcome {
  /** Undefined only when every attempt threw (transport failure). */
  response?: Response;
  lastError?: unknown;
  attempts: number;
}

/**
 * Bounded retry on transient transport failures + upstream-gateway 5xx.
 *
 * Retried: fetch throws (DNS hiccup, TCP reset, TLS handshake), 502, 503, 504.
 * NOT retried: AbortError (the caller's own timeout fired), every 4xx, and
 * every other status — those are deterministic from the request, so a retry
 * only delays the failure. 429 is deliberately not retried: a real rate limit
 * wants a longer back-off than this layer provides.
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  retry: RetryConfig,
): Promise<FetchOutcome> {
  let response: Response | undefined;
  let lastError: unknown;
  const maxAttempts = retry.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = init === undefined ? await fetchImpl(url) : await fetchImpl(url, init);
      if (
        attempt < maxAttempts &&
        (response.status === 502 || response.status === 503 || response.status === 504)
      ) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        await retry.sleep(retry.backoffMs * 2 ** (attempt - 1));
        continue;
      }
      lastError = undefined;
      break;
    } catch (e: unknown) {
      lastError = e;
      if ((e as Error).name === 'AbortError') break;
      if (attempt < maxAttempts) {
        await retry.sleep(retry.backoffMs * 2 ** (attempt - 1));
        continue;
      }
      break;
    }
  }
  return { response, lastError, attempts: maxAttempts };
}

/**
 * GET a presigned URL into `dest`, returning the byte count. Same retry
 * contract as API calls: one flaky screenshot must not fail a whole recipe.
 */
export async function downloadToFile(
  fetchImpl: typeof fetch,
  url: string,
  dest: string,
  retry: RetryConfig,
  errorCode = 'CLOUD_DOWNLOAD_FAILED',
): Promise<number> {
  const { response, lastError, attempts } = await fetchWithRetry(fetchImpl, url, undefined, retry);
  if (!response) {
    const err = lastError as Error | undefined;
    throw new MobileError(
      errorCode,
      `failed to fetch ${url} after ${attempts} attempt(s): ${err?.message ?? 'unknown'}`,
    );
  }
  if (!response.ok) {
    throw new MobileError(errorCode, `S3 GET ${url} returned ${response.status}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf.byteLength;
}

/** One remote artifact: a flat name plus a presigned GET URL. */
export interface RemoteArtifact {
  name: string;
  url: string;
  contentType: string;
}

/**
 * Download every artifact into `screenshotDir` and return the image ones as
 * ScreenshotEntry — the on-disk shape MaestroBackend leaves behind.
 *
 * ace#1110: `name` comes from the REMOTE side and `path.join` happily walks
 * out of screenshotDir on `../`. No legitimate artifact name carries a
 * separator, so an unsafe one is skipped with a warning rather than written.
 */
export async function materializeArtifacts(
  artifacts: RemoteArtifact[],
  screenshotDir: string,
  download: (url: string, dest: string) => Promise<number>,
  logTag = 'cloud',
): Promise<ScreenshotEntry[]> {
  await fs.mkdir(screenshotDir, { recursive: true });
  const screenshots: ScreenshotEntry[] = [];
  for (const art of artifacts) {
    if (!isSafeArtifactName(art.name)) {
      console.warn(`[ace-mobile] ${logTag}: skipping artifact with unsafe name ${JSON.stringify(art.name)} (ace#1110)`);
      continue;
    }
    const dest = path.join(screenshotDir, art.name);
    const bytes = await download(art.url, dest);
    if (art.contentType.startsWith('image/')) {
      screenshots.push({
        stepName: art.name.replace(/\.[a-z0-9]+$/i, ''),
        path: dest,
        takenAt: new Date().toISOString(),
        bytes,
      });
    }
  }
  return screenshots;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.yaml': 'application/yaml',
};

/** Content type from a file name, for artifact listings that omit it. */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

const VALID_STEP_STATUSES: ReadonlySet<StepResult['status']> = new Set([
  'pass',
  'fail',
  'skipped',
  'unknown',
]);

/**
 * Coerce a remote step (loose `string` status, `null`-able optionals) into
 * the typed StepResult. Unknown statuses fall through to 'unknown' so a new
 * server-side value can't crash the backend.
 */
export function normalizeRemoteStep(s: {
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

/**
 * Format an in-VM diagnostic snapshot (ace-web's `Diagnostics` dataclass,
 * which the in-VM `ace-mobile diagnose` ports) into a compact block for an
 * MCP tool_result message. Log tails are already capped server-side.
 */
export function formatDiagnostics(diag: Record<string, unknown>): string {
  const lines: string[] = [];
  const adbDevices = diag.adb_devices as Array<{ serial: string; state: string }> | undefined;
  const visible = diag.adb_visible_count as number | undefined;
  lines.push(
    `  adb devices: ${visible ?? 0} in 'device' state` +
      (adbDevices?.length
        ? ` (${adbDevices.map((d) => `${d.serial}=${d.state}`).join(', ')})`
        : ' (none)'),
  );
  const pid = diag.emulator_pid as number | null | undefined;
  lines.push(`  emulator process: ${pid ? `pid ${pid}` : 'not running'}`);
  const runnerState = diag.runner_service_state as string | undefined;
  lines.push(`  ace-mobile-runner.service: ${runnerState ?? 'unknown'}`);
  const markerPresent = diag.marker_present as boolean | undefined;
  const markerAge = diag.marker_age_seconds as number | null | undefined;
  lines.push(
    `  ready marker: ${markerPresent ? `present (age ${markerAge ?? '?'}s)` : 'absent'}`,
  );
  const runnerLog = (diag.runner_log_tail as string | undefined)?.trim();
  if (runnerLog) {
    lines.push('  --- runner.log tail ---');
    lines.push(...runnerLog.split('\n').map((l) => `    ${l}`));
  }
  const emuLog = (diag.emulator_log_tail as string | undefined)?.trim();
  if (emuLog) {
    lines.push('  --- emulator.log tail ---');
    lines.push(...emuLog.split('\n').map((l) => `    ${l}`));
  }
  return lines.join('\n');
}

/** RFC 7807 problem+json, as both ace-web and canopy-web return it. */
export interface Problem {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
  extras?: Record<string, unknown>;
}

/** Same node regex AvdBackend.parseHierarchy uses, for a dump read off a remote device. */
export function parseUiHierarchy(
  xml: string,
): Array<{ id?: string; text?: string; class?: string; bounds?: string }> {
  const out: Array<{ id?: string; text?: string; class?: string; bounds?: string }> = [];
  const nodeRe = /<node\s+([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const get = (k: string) => {
      const am = attrs.match(new RegExp(`${k}="([^"]*)"`));
      return am ? am[1] : undefined;
    };
    out.push({
      id: get('resource-id') || undefined,
      text: get('text') || undefined,
      class: get('class') || undefined,
      bounds: get('bounds') || undefined,
    });
  }
  return out;
}
