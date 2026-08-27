/**
 * Rescue-harvest of Maestro's own debug bundle (dimagi-internal/ace — Phase 6
 * stranded-capture gap).
 *
 * **The defect this closes.** Maestro writes `takeScreenshot` PNGs into its
 * process CWD (which `MaestroBackend` points at the dispatch output dir) AND
 * into its debug bundle under `~/.maestro/tests/<timestamp>/<flow>/
 * takeScreenshot/`. `collectScreenshots` only ever reads the dispatch dir, and
 * only ever runs on a path where the shell call RETURNED. A watchdog expiry
 * does not return: ace#1164 converts it into a thrown
 * `MobileError('MAESTRO_STALL')`, so no `RecipeRunResult` is ever built, the
 * collect never happens, and everything Maestro had already captured is
 * abandoned in place.
 *
 * ace#1570 sized the budget so a long Learn chunk survives, and ace#1164 made
 * the stall loud and un-retried — but neither recovers the captures of a walk
 * that DOES stall. Until this module, the stall's own remediation hint was
 * "go read `~/.maestro/tests/<latest>/maestro.log` yourself".
 *
 * Seen live on `turmeric-market-study/20260807-1903` (2026-08-26): the
 * dispatch reported `screenshots_shipped: 0` while 57 real, non-zero PNGs
 * covering six Learn modules sat in
 * `~/.maestro/tests/2026-08-26_193734/chunk-0/takeScreenshot/`. The captures
 * existed; the harness just never looked. Same signature on
 * hh-poverty-targeting/20260819-1435 (59 good screenshots, ace#1570).
 *
 * **Freshness (jjackson/ace#756).** The hard rule is that a dispatch's
 * screenshot dir must contain ONLY artifacts from THAT execution — a stale
 * PNG sitting where a fresh one belongs is indistinguishable from output and
 * has previously made a failed run read as a passing one. This harvester is
 * therefore bounded on BOTH sides:
 *
 *   - `since` — only bundle dirs touched at or after this dispatch started
 *     are considered, so a previous run's bundle can never be pulled in.
 *   - `rescued--` filename prefix — every harvested PNG is renamed, so it can
 *     never be mistaken for a step capture the recipe actually completed, and
 *     an existing same-named PNG in the dispatch dir is never overwritten.
 *
 * Rescued captures are debugging + reporting evidence. They do NOT convert a
 * failed dispatch into a passing one: `status` stays `fail`, and #756 still
 * forbids presenting them as a clean journey set.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Prefix stamped on every harvested file. See the #756 note above. */
export const RESCUED_PREFIX = 'rescued--';

/**
 * Filesystem-timestamp slack, in ms.
 *
 * Maestro creates its bundle dir a moment BEFORE the first screenshot lands,
 * and some filesystems (and container bind mounts) round mtime to whole
 * seconds. Without slack, the bundle for the dispatch we just ran can sort
 * marginally older than `since` and be skipped — the exact case this module
 * exists to catch. 5s is far below the gap between two real dispatches.
 */
export const MTIME_SLACK_MS = 5_000;

export interface HarvestOpts {
  /** Dispatch output dir. Rescued files are written here. */
  screenshotDir: string;
  /** `Date.now()` captured immediately before the `maestro` invocation. */
  since: number;
  /** Override `~/.maestro` (tests, or a non-default `MAESTRO_CLI_HOME`). */
  maestroHome?: string;
  log?: (msg: string) => void;
}

export interface HarvestResult {
  /** Absolute paths of files written into `screenshotDir`. */
  rescued: string[];
  /** Bundle dirs considered in scope by the `since` filter. */
  sourceDirs: string[];
  /** PNGs found but not copied (already present, or zero-byte). */
  skipped: number;
  /** Absolute path of the rescued `maestro.log`, when one was found. */
  logPath?: string;
}

/** Resolve Maestro's bundle root, honouring `MAESTRO_CLI_HOME`. */
export function maestroTestsRoot(
  maestroHome?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const home = maestroHome ?? env.MAESTRO_CLI_HOME ?? path.join(os.homedir(), '.maestro');
  return path.join(home, 'tests');
}

function listPngsRecursive(dir: string, out: string[] = [], depth = 0): string[] {
  // Bundles are shallow (`<ts>/<flow>/takeScreenshot/*.png`); the depth cap
  // is a symlink-loop backstop, not a real structural limit.
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listPngsRecursive(full, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}

/**
 * Copy every fresh PNG from Maestro's debug bundle into the dispatch dir.
 *
 * Best-effort throughout — every filesystem error is swallowed and reported
 * via the returned counts. A rescue attempt must never be able to change a
 * dispatch's verdict or throw over the real failure that triggered it.
 */
export function harvestMaestroDebugScreenshots(opts: HarvestOpts): HarvestResult {
  const result: HarvestResult = { rescued: [], sourceDirs: [], skipped: 0 };
  const root = maestroTestsRoot(opts.maestroHome);

  let runDirs: string[];
  try {
    runDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    // No bundle root at all — Maestro never ran on this host, or a custom
    // MAESTRO_CLI_HOME we can't read. Nothing to rescue.
    return result;
  }

  const cutoff = opts.since - MTIME_SLACK_MS;
  for (const dir of runDirs) {
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) result.sourceDirs.push(dir);
    } catch {
      /* raced away mid-scan — ignore */
    }
  }
  if (result.sourceDirs.length === 0) return result;

  try {
    fs.mkdirSync(opts.screenshotDir, { recursive: true });
  } catch {
    return result;
  }

  for (const dir of result.sourceDirs.sort()) {
    for (const src of listPngsRecursive(dir)) {
      try {
        if (fs.statSync(src).size === 0) {
          result.skipped += 1;
          continue;
        }
        const base = path.basename(src);
        // Never shadow a PNG the dispatch itself wrote.
        if (fs.existsSync(path.join(opts.screenshotDir, base))) {
          result.skipped += 1;
          continue;
        }
        // Flow name disambiguates same-named screenshots across chunks
        // (`chunk-0/takeScreenshot/foo.png` vs `chunk-1/.../foo.png`).
        const flow = path.basename(path.dirname(path.dirname(src)));
        const dest = path.join(opts.screenshotDir, `${RESCUED_PREFIX}${flow}--${base}`);
        if (fs.existsSync(dest)) {
          result.skipped += 1;
          continue;
        }
        fs.copyFileSync(src, dest);
        result.rescued.push(dest);
      } catch {
        result.skipped += 1;
      }
    }

    // `maestro.log` is the only artifact that shows where a killed walk
    // actually died — the dispatch's own `*-FAILURE.xml` is dumped after the
    // app has already returned to the Connect jobs list, so it reads like a
    // claim/resume stall no matter what really happened. Pulling the log in
    // here is what stops the next operator re-deriving that the hard way.
    if (!result.logPath) {
      const srcLog = path.join(dir, 'maestro.log');
      try {
        if (fs.existsSync(srcLog)) {
          const destLog = path.join(opts.screenshotDir, `${RESCUED_PREFIX}maestro.log`);
          fs.copyFileSync(srcLog, destLog);
          result.logPath = destLog;
        }
      } catch {
        /* best-effort */
      }
    }
  }

  if (result.rescued.length > 0 || result.logPath) {
    opts.log?.(
      `harvestMaestroDebugScreenshots: rescued ${result.rescued.length} PNG(s)` +
        `${result.logPath ? ' + maestro.log' : ''} from ${result.sourceDirs.length} bundle dir(s) ` +
        `into ${opts.screenshotDir} (skipped ${result.skipped})`,
    );
  }
  return result;
}
