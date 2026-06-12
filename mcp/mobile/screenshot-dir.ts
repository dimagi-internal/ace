// mcp/mobile/screenshot-dir.ts
//
// Per-execution screenshot-directory freshness (jjackson/ace#756).
//
// `mobile_run_recipe`'s screenshot directory used to persist across
// executions (and across sessions on a shared runner), so stale PNGs
// from a PRIOR run sat exactly where fresh ones land. A failed recipe
// then left the dir populated with plausible-looking artifacts, and a
// downstream consumer could (and did, bednet-spot-check 20260612-1220)
// read them as if the failed run had produced them. The structural fix:
// wipe-and-recreate the directory at execution start, so the dir a
// dispatch reports contains ONLY artifacts from that dispatch.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Wipe and recreate a per-execution screenshot directory so it contains
 * ONLY artifacts written by the current execution.
 *
 * Called by `MobileClient.runRecipe` AFTER `prepareRecipeForMaestro`
 * (so a recipe that happens to live inside the dir has already been
 * copied into the resolved temp dir) and BEFORE dispatching to either
 * backend — local Maestro writes PNGs into this dir directly; the cloud
 * backend downloads S3 artifacts into it. One choke point covers both.
 *
 * Guard rails: refuses obviously-dangerous targets (filesystem root,
 * single-segment paths like `/tmp`, the home directory, the cwd) with a
 * typed-message throw instead of an rm -rf. Screenshot dirs are always
 * caller-scoped subdirs (e.g. `/tmp/ace-screenshots/journey-learn`).
 */
export function resetScreenshotDir(dir: string): void {
  const resolved = path.resolve(dir);
  const { root } = path.parse(resolved);
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  if (
    resolved === root ||
    segments.length < 2 ||
    resolved === os.homedir() ||
    resolved === process.cwd()
  ) {
    throw new Error(
      `resetScreenshotDir: refusing to wipe "${resolved}" — too shallow or a ` +
        `protected location (root / single-segment path / home / cwd). Pass a ` +
        `dedicated per-execution subdirectory, e.g. /tmp/ace-screenshots/<recipe>.`,
    );
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}
