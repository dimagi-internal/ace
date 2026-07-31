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
//
// The wipe is also DISPATCH-SCOPED (dimagi-internal/ace#1130). Two
// different journeys used to be able to share one `screenshotDir`, so the
// legitimate start-of-run wipe for journey B landed on journey A's
// finished, PASSING evidence. Observed live on
// bednet-spot-check/20260731-1353: the Learn leg passed, produced a full
// screenshot set + video, and the Deliver leg's wipe deleted it —
// unrecoverable, because Learn completion is one-way per (test user,
// opportunity) (#568/#570), so the only remediation is a fresh
// `/ace:run`. The fix is NOT a wider preserve-list (that would re-open
// #756's class): `mobile_run_recipe` now writes into a per-recipe
// namespace UNDER the caller's dir (`dispatchOutputDir`), and the wipe
// targets only that namespace. A dispatch can therefore only ever clear
// its OWN prior output, by construction — a caller cannot express
// "two recipes, one output dir" at all.
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
 * Shared guard rail for anything this module is about to recursively
 * delete under (or hand to a backend as a writable output root): refuse
 * the filesystem root, single-segment paths like `/tmp`, the home
 * directory and the cwd with a typed-message throw instead of an rm -rf.
 *
 * Applied to the caller-supplied ROOT as well as the derived per-recipe
 * namespace, so namespacing (which adds a path segment) can never be a
 * way to smuggle a shallow path past the check — e.g. `screenshotDir:
 * '/tmp'` is still rejected outright rather than becoming a wipe of
 * `/tmp/<recipe>/`. Narrowing the wipe root further (an allow-listed
 * base such as `/tmp/ace-screenshots/`) is dimagi-internal/ace#1111's
 * job, not this module's.
 */
function assertSafeWipeTarget(resolved: string, fnName: string): void {
  const { root } = path.parse(resolved);
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  if (
    resolved === root ||
    segments.length < 2 ||
    resolved === os.homedir() ||
    resolved === process.cwd()
  ) {
    throw new Error(
      `${fnName}: refusing to wipe "${resolved}" — too shallow or a ` +
        `protected location (root / single-segment path / home / cwd). Pass a ` +
        `dedicated per-execution subdirectory, e.g. /tmp/ace-screenshots/<recipe>.`,
    );
  }
}

/**
 * Derive the dispatch-scoped output directory for one `mobile_run_recipe`
 * execution (dimagi-internal/ace#1130).
 *
 * The caller passes a run-scoped ROOT (e.g.
 * `/tmp/ace-screenshots/<run-id>`); every dispatch writes into
 * `<root>/<recipeId>/` and the start-of-run wipe targets ONLY that
 * subdirectory. Consequences, all structural rather than advisory:
 *
 * - Two different recipes (the Learn leg's `journey-learn`, the Deliver
 *   leg's `connect-resume-opp` / `journey-deliver`) CANNOT share an
 *   output directory even if the caller passes the same root, so a wipe
 *   can never destroy another journey's finished evidence.
 * - Re-dispatching the SAME recipe still clears that recipe's own prior
 *   ordinary output, which is exactly #756's guarantee (no stale capture
 *   may masquerade as a fresh one) — and #1034's preserve-list still
 *   spares `00-*` ground truth + `*-FAILURE.*` forensics inside it.
 * - The blast radius of the wipe equals the dispatch, by construction.
 *
 * Namespacing by recipe id rather than by the (unique-per-invocation)
 * dispatch id is deliberate: a unique-per-invocation directory would make
 * the wipe vacuous and leave every superseded attempt's ordinary PNGs on
 * disk in sibling directories, which is #756's stale-carryover class
 * again one level up. Provenance (which DOES carry `dispatch_id`) stays
 * the per-invocation identity; the directory is the per-recipe namespace.
 */
export function dispatchOutputDir(root: string, recipeId: string): string {
  const resolvedRoot = path.resolve(root);
  assertSafeWipeTarget(resolvedRoot, 'dispatchOutputDir');
  return path.join(resolvedRoot, recipeNamespace(recipeId));
}

/**
 * Reduce a recipe id to a single safe path segment. `recipeId` is derived
 * from a recipe filename, so it is already a basename in practice — this
 * is defence in depth so no `../` or separator can escape the root.
 */
export function recipeNamespace(recipeId: string): string {
  const slug = path
    .basename(String(recipeId ?? ''))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  if (!slug) {
    throw new Error(
      `dispatchOutputDir: cannot derive an output namespace from recipe id ` +
        `"${recipeId}" — expected a recipe filename like "journey-learn".`,
    );
  }
  return slug;
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
  assertSafeWipeTarget(resolved, 'resetScreenshotDir');
  fs.mkdirSync(resolved, { recursive: true });
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (entry.isFile() && isPreservedArtifact(entry.name)) continue;
    fs.rmSync(path.join(resolved, entry.name), { recursive: true, force: true });
  }
}
