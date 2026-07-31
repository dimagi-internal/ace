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
//
// The wipe is SELECTIVE (jjackson/ace#1034): a blanket rm -rf destroyed
// the `00-postlearn-landing.xml` ground-truth dump the Deliver leg's
// SKILL captures into the same dir BEFORE the recipe runs, plus the
// `*-FAILURE.{png,xml}` forensics from a prior failed attempt — i.e. the
// evidence for the very failure being diagnosed (and the atlas-drift
// harvest that reads `*-FAILURE.xml`). Observed live on
// bednet-spot-check/20260728-2222. So: `00-`-prefixed files (pre-recipe
// ground truth) and `*-FAILURE.*` files (failure forensics) survive the
// wipe; every ordinary capture output (other *.png / *.xml / *.mp4 /
// sidecars / nested dirs) is still removed — #756's intent holds: no
// stale ordinary capture may masquerade as a fresh one.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Files the start-of-run wipe must NOT delete (jjackson/ace#1034):
 * - `00-*` — pre-recipe ground-truth artifacts (e.g. the #618
 *   `00-postlearn-landing.xml` dump captured before the Deliver leg).
 * - `*-FAILURE.*` — forensics auto-captured on a prior failed attempt;
 *   also the atlas-drift harvester's input.
 */
export function isPreservedArtifact(name: string): boolean {
  return name.startsWith('00-') || /-FAILURE\./.test(name);
}

/**
 * Wipe and recreate a per-execution screenshot directory so it contains
 * ONLY artifacts written by the current execution (plus preserved
 * ground-truth / forensic files — see `isPreservedArtifact`).
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
  fs.mkdirSync(resolved, { recursive: true });
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (entry.isFile() && isPreservedArtifact(entry.name)) continue;
    fs.rmSync(path.join(resolved, entry.name), { recursive: true, force: true });
  }
}
