/**
 * Per-screenshot provenance — closes the silent stale-carryover class.
 *
 * Sidecar JSON next to every PNG: `<png>.meta.json`. Non-invasive (PNG
 * bytes unchanged, so training-slide pipelines that consume the PNG
 * directly are unaffected) and deterministic (consumers can read the
 * sidecar to know which dispatch produced the PNG).
 *
 * Consumer pattern for stale detection:
 *
 *   const currentDispatch = newDispatchId();   // per dispatch
 *   // ... harness writes sidecars with that dispatch_id ...
 *   const prov = readProvenanceSidecar(pngPath);
 *   if (!prov || prov.dispatch_id !== currentDispatch) {
 *     // STALE — PNG was not produced by this dispatch
 *   }
 *
 * Shape rationale: `recipe_id` + `dispatch_id` + `ace_version` +
 * `git_sha` + `written_at_epoch_ms`. dispatch_id is the primary
 * staleness key; the others give forensic context when a screenshot
 * is discovered out-of-band (e.g. attached to a bug report).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

export interface ScreenshotProvenance {
  recipe_id: string;
  dispatch_id: string;
  ace_version: string;
  /** Short git SHA when this is a git checkout; absent in tarball installs. */
  git_sha?: string;
  written_at_epoch_ms: number;
}

export function sidecarPathFor(pngPath: string): string {
  return `${pngPath}.meta.json`;
}

/**
 * Generate a fresh dispatch ID. Shape: `<epoch_ms>-<random6>`. Stable
 * sort order across same-millisecond calls is unnecessary; the random
 * suffix is the disambiguator.
 *
 * Format is regex-friendly (`^\d{13}-[a-z0-9]{6}$`) so tests can match
 * structurally without piping through a UUID library.
 */
export function newDispatchId(): string {
  const ts = Date.now().toString();
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${ts}-${rand}`;
}

export function buildProvenance(args: {
  recipeId: string;
  dispatchId: string;
  aceVersion: string;
  gitSha?: string;
  writtenAtEpochMs: number;
}): ScreenshotProvenance {
  const p: ScreenshotProvenance = {
    recipe_id: args.recipeId,
    dispatch_id: args.dispatchId,
    ace_version: args.aceVersion,
    written_at_epoch_ms: args.writtenAtEpochMs,
  };
  if (args.gitSha !== undefined) p.git_sha = args.gitSha;
  return p;
}

export function writeProvenanceSidecar(
  pngPath: string,
  prov: ScreenshotProvenance,
): void {
  fs.writeFileSync(sidecarPathFor(pngPath), JSON.stringify(prov, null, 2));
}

export function readProvenanceSidecar(
  pngPath: string,
): ScreenshotProvenance | undefined {
  const p = sidecarPathFor(pngPath);
  if (!fs.existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (!isProvenance(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isProvenance(x: unknown): x is ScreenshotProvenance {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.recipe_id === 'string' &&
    typeof o.dispatch_id === 'string' &&
    typeof o.ace_version === 'string' &&
    typeof o.written_at_epoch_ms === 'number'
  );
}

let cachedGitSha: string | undefined | null = null;

/**
 * Read the short git SHA of the running ACE checkout. Cached after
 * first call. Returns undefined when not in a git checkout (tarball
 * install, CI without `.git` etc.).
 *
 * The cache key is the process — every MCP subprocess restart will
 * re-probe, which is fine. Within a single MCP subprocess lifetime
 * the SHA can't change because the on-disk code can't change without
 * a /reload-plugins + full Claude restart.
 */
export function getGitSha(cwd?: string): string | undefined {
  if (cachedGitSha !== null) return cachedGitSha ?? undefined;
  try {
    const sha = execSync('git rev-parse --short=12 HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (/^[0-9a-f]{7,40}$/.test(sha)) {
      cachedGitSha = sha;
      return sha;
    }
  } catch {
    // fall through
  }
  cachedGitSha = undefined;
  return undefined;
}

/**
 * Test-only: reset the cached git SHA. Production code should never
 * call this.
 */
export function _resetGitShaCacheForTests(): void {
  cachedGitSha = null;
}

let cachedAceVersion: string | undefined | null = null;

/**
 * Read the running ACE version from the repo-root VERSION file.
 * Cached after first call. Returns 'unknown' if the file is missing or
 * unreadable rather than throwing — provenance is best-effort
 * forensics, not a load-bearing invariant. Within a single MCP
 * subprocess the version can't change without a full restart, so the
 * cache is safe.
 */
export function getAceVersion(): string {
  if (cachedAceVersion !== null) return cachedAceVersion ?? 'unknown';
  try {
    // lib/screenshot-provenance.ts → <repo>/VERSION
    const here = fileURLToPath(import.meta.url);
    const versionPath = path.resolve(path.dirname(here), '..', 'VERSION');
    const v = fs.readFileSync(versionPath, 'utf8').trim();
    if (v.length > 0) {
      cachedAceVersion = v;
      return v;
    }
  } catch {
    // fall through
  }
  cachedAceVersion = undefined;
  return 'unknown';
}

/**
 * Test-only: reset the cached ACE version. Production code should
 * never call this.
 */
export function _resetAceVersionCacheForTests(): void {
  cachedAceVersion = null;
}
