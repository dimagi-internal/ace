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
  /**
   * The adb serial the recipe actually ran against (`emulator-5554`).
   *
   * Recorded because provenance without it cannot answer "was this frame
   * taken on the device this run provisioned?" — and on a multi-emulator host
   * that is a real question. On 2026-08-14 two emulators ran the SAME AVD,
   * both registered to the same test user, so a recipe could land on either
   * and nothing in the artifact said which (dimagi-internal/ace#1396).
   * Optional: absent on cloud runs and on older sidecars.
   */
  device_serial?: string;
  written_at_epoch_ms: number;
  /**
   * Set when a LATER dispatch observed this artifact still sitting in the
   * screenshot dir: the id of that later dispatch. `dispatch_id` above stays
   * the PRODUCING dispatch's, which is the whole point — see
   * `resolveArtifactProvenance` (dimagi-internal/ace#2237).
   */
  superseded_by?: string;
  /** Epoch ms at which the superseding dispatch observed the artifact. */
  superseded_at_epoch_ms?: number;
  /**
   * True iff this artifact predates the dispatch that last observed it —
   * i.e. it survived that dispatch's screenshot-dir wipe (`00-*` ground
   * truth, `*-FAILURE.*` forensics) rather than being produced by it.
   */
  carried_over?: boolean;
}

/**
 * `dispatch_id` recorded for a carried-over artifact whose PRODUCING dispatch
 * is unknowable — it carries no sidecar, e.g. because it was written by an
 * ACE version that predates forensics stamping. Deliberately not a valid
 * dispatch id (`^\d{13}-[a-z0-9]{6}$`), so the documented consumer
 * comparison (`prov.dispatch_id !== currentDispatch`) classifies it as stale
 * rather than silently claiming the current dispatch produced it.
 */
export const UNKNOWN_PRIOR_DISPATCH_ID = 'unknown-prior-dispatch';

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
  deviceSerial?: string;
  writtenAtEpochMs: number;
}): ScreenshotProvenance {
  const p: ScreenshotProvenance = {
    recipe_id: args.recipeId,
    dispatch_id: args.dispatchId,
    ace_version: args.aceVersion,
    written_at_epoch_ms: args.writtenAtEpochMs,
  };
  if (args.gitSha !== undefined) p.git_sha = args.gitSha;
  if (args.deviceSerial !== undefined) p.device_serial = args.deviceSerial;
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

/**
 * Decide what provenance an artifact should carry after THIS dispatch has
 * observed it — the fix for dimagi-internal/ace#2237.
 *
 * The screenshot-dir wipe is deliberately selective (ace#1034): `00-*`
 * ground truth and `*-FAILURE.*` forensics survive it, so a leg that fails
 * once and then passes leaves the PRIOR attempt's frames sitting next to the
 * retry's captures. The stamper runs at harvest time over everything in the
 * dir, so it used to overwrite those preserved files with the CURRENT
 * dispatch's id — defeating the one comparison the stamp exists for. Observed
 * on spark-facilitator/20260907-1120: a `journey-deliver-FAILURE.png` captured
 * ~6h earlier, on a different plugin version and a different emulator serial,
 * came back carrying the current dispatch's id, version and serial.
 *
 * The rule: **mtime decides.** The wipe means an artifact older than this
 * dispatch's start cannot have been produced by it — so its provenance is
 * kept (or, absent a sidecar, honestly marked unknown) and only annotated
 * with `superseded_by`. Anything the dispatch actually wrote (including a
 * fresh `*-FAILURE.png` that overwrote a preserved one of the same name) has
 * a current mtime and is stamped as this dispatch's, even if a stale sidecar
 * from the prior attempt is still lying next to it.
 *
 * Consequence worth stating: a `00-*` ground-truth frame written by the
 * calling SKILL just before `runRecipe` also predates the dispatch, so it is
 * now marked `carried_over` with no dispatch id rather than claiming this
 * dispatch produced it. That is the honest reading — the dispatch didn't
 * produce it — and it is what the `#756` freshness contract already means.
 */
export function resolveArtifactProvenance(args: {
  /** Sidecar already next to the artifact, if any. */
  existing?: ScreenshotProvenance;
  /** Provenance built for the dispatch doing the stamping. */
  current: ScreenshotProvenance;
  /** Artifact mtime. Undefined when unstattable — then `existing` decides. */
  fileMtimeEpochMs?: number;
  /** Epoch ms at which the current dispatch began (before the dir wipe). */
  dispatchStartedAtEpochMs: number;
}): ScreenshotProvenance {
  const { existing, current, fileMtimeEpochMs, dispatchStartedAtEpochMs } = args;

  const producedByCurrent =
    fileMtimeEpochMs !== undefined
      ? fileMtimeEpochMs >= dispatchStartedAtEpochMs
      : existing === undefined || existing.dispatch_id === current.dispatch_id;

  if (producedByCurrent) return current;

  const origin: ScreenshotProvenance = existing ?? {
    recipe_id: current.recipe_id,
    dispatch_id: UNKNOWN_PRIOR_DISPATCH_ID,
    // Not `current`'s version/serial: the artifact was written by a dispatch
    // we know nothing about, and inventing plausible context is precisely the
    // failure #2237 reports.
    ace_version: 'unknown',
    written_at_epoch_ms: fileMtimeEpochMs ?? current.written_at_epoch_ms,
  };

  return {
    ...origin,
    carried_over: true,
    superseded_by: current.dispatch_id,
    superseded_at_epoch_ms: current.written_at_epoch_ms,
  };
}

/**
 * Whether an artifact's provenance says it was NOT produced by the dispatch
 * asking. The comparison the module header documents, as a function so
 * consumers stop hand-rolling it (and so `carried_over` can't be missed).
 */
export function isCarryover(
  prov: ScreenshotProvenance | undefined,
  currentDispatchId: string,
): boolean {
  if (!prov) return true;
  return prov.dispatch_id !== currentDispatchId;
}

/** Anything with a host path that can carry a provenance sidecar. */
export interface StampableArtifact {
  path: string;
  provenance?: ScreenshotProvenance;
}

/**
 * Stamp a batch of harvested artifacts, preserving the provenance of any that
 * this dispatch did not produce. Writes the sidecar AND sets `.provenance` on
 * each entry, so the atom result and the on-disk sidecar can never disagree.
 *
 * Best-effort per artifact: a write failure is reported through `onError` and
 * never throws — provenance is forensics, not a load-bearing invariant.
 */
export function stampArtifactProvenance(args: {
  artifacts: StampableArtifact[];
  current: ScreenshotProvenance;
  dispatchStartedAtEpochMs: number;
  onError?: (artifactPath: string, err: unknown) => void;
}): void {
  for (const a of args.artifacts) {
    try {
      const resolved = resolveArtifactProvenance({
        existing: readProvenanceSidecar(a.path),
        current: args.current,
        fileMtimeEpochMs: artifactMtimeEpochMs(a.path),
        dispatchStartedAtEpochMs: args.dispatchStartedAtEpochMs,
      });
      writeProvenanceSidecar(a.path, resolved);
      a.provenance = resolved;
    } catch (e) {
      args.onError?.(a.path, e);
    }
  }
}

function artifactMtimeEpochMs(p: string): number | undefined {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
}
