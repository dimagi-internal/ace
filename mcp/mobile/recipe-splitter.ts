// mcp/mobile/recipe-splitter.ts
//
// Split a Maestro recipe into chunks at top-level `takeScreenshot:`
// boundaries so the harness can dump the AVD's UI hierarchy XML between
// chunks — capturing one XML dump per screenshot the recipe takes.
//
// Why this exists. Maestro's gRPC driver locks the on-device
// `uiautomator` service exclusively while a `maestro test` run is
// active, so a parallel `adb shell uiautomator dump` from a separate
// host process fails (verified live 2026-05-14 — see
// docs/learnings/2026-05-14-atlas-side-channel-capture.md). The only
// reliable window where the dump can run is BETWEEN Maestro processes.
// Splitting one recipe into N sub-recipes that each end on a
// `takeScreenshot` step gives us N quiet windows — one per logical
// surface — without rewriting the recipe authoring model.
//
// What "top-level takeScreenshot" means. Only steps that are direct
// children of the flow document trigger splits. A `takeScreenshot:`
// nested inside a `runFlow.commands:` block does NOT split — those
// sub-flow screenshots fall into whichever parent chunk contains them.
// This keeps inline conditional blocks (the common case in our static
// palette) atomic, which matches recipe-author intent.
//
// Header preservation. The recipe's metadata block (`appId:`,
// `name:`, etc.) — everything before the first `---` separator —
// is replicated at the head of every chunk. Maestro requires this on
// each invocation. The `launchApp` step is NOT auto-added; if the
// original recipe didn't have one, the chunks won't either (Maestro
// uses the `appId` to attach to the running app, which is correct for
// our use case where chunk 1 leaves the app foregrounded for chunk 2).

import * as fs from 'node:fs';

/** One chunk of a split recipe. */
export interface RecipeChunk {
  /**
   * Valid Maestro recipe YAML for this chunk — header + steps. Ready
   * to write to disk and invoke via `maestro test`.
   */
  yaml: string;
  /**
   * Set iff this chunk ends with a top-level `takeScreenshot:` step.
   * Names the screenshot; the caller writes the matching UI dump as
   * `<screenshotName>.xml` alongside the `<screenshotName>.png` that
   * Maestro produces.
   */
  screenshotName?: string;
  /**
   * 0-based index of this chunk in the original recipe. Useful for
   * naming temp files and surfacing per-chunk errors.
   */
  index: number;
}

/** Options for {@link splitRecipeAtScreenshots}. */
export interface SplitOptions {
  /**
   * Open a dump window at every top-level `runFlow` boundary, not just
   * at top-level `takeScreenshot`. Branch screens — the ones inside
   * `runFlow.commands` — are exactly the "which screen am I on"
   * decision points, and today they're captured as pixels with no
   * element tree because a dump only happens at `takeScreenshot`
   * boundaries. EXPENSIVE — one extra `maestro test` invocation per
   * window. Default false; only a tier-1 `unmapped-surface`
   * classification justifies turning it on.
   *
   * Two top-level `runFlow`s directly adjacent to each other (no other
   * top-level step between them) share ONE window at that seam — not an
   * independent `-post` for the first plus an empty `-pre` for the
   * second. Nothing executes between two back-to-back runFlows, so a
   * second dump there would capture the identical screen the first
   * already captured (zero diagnostic value) while still paying the
   * full cost this option warns about (a whole extra `maestro test`
   * invocation) — and, per `runRecipeWithDumps`'s fail-fast contract, a
   * chunk with an empty flow section risks Maestro rejecting it outright
   * and aborting every remaining chunk.
   *
   * The same empty-flow-chunk hazard applies to the very FIRST top-level
   * step in the recipe: if it's a `runFlow`, a naive `-pre` split there
   * would finalize a chunk containing only whatever preamble preceded
   * it — and recipe preambles are typically pure comments, which parse
   * to no steps at all. That leading `-pre` is therefore suppressed
   * unconditionally; its preamble folds into the first runFlow's own
   * `-post` chunk instead. No chunk this option ever produces should
   * have an empty flow section — that's the invariant a dedicated test
   * enforces, not just these two documented cases.
   *
   * Boundary chunks set
   * `screenshotName` to `-branch<N>-pre` / `-branch<N>-post` (leading
   * hyphen is part of the name — see the test asserting
   * `/-branch\d+-pre$/` in test/mcp/mobile/recipe-splitter.test.ts; no
   * live caller consumes this yet, so there's no established
   * concatenation convention to match beyond that test contract).
   */
  captureAllBoundaries?: boolean;
}

/**
 * Split a recipe at top-level `takeScreenshot:` boundaries (always),
 * plus — when `opts.captureAllBoundaries` is set — at every top-level
 * `runFlow:` boundary too.
 *
 * Returns the chunks in order. The final chunk's `screenshotName`
 * MAY be undefined when the recipe doesn't end with a screenshot —
 * those "tail" chunks still need to run (they do meaningful work) but
 * don't trigger a post-chunk dump.
 *
 * Pure function — does not read from `recipePath` argument; takes the
 * body directly. (Callers wrap with `fs.readFileSync` separately so the
 * splitter is trivially testable.)
 */
export function splitRecipeAtScreenshots(body: string, opts: SplitOptions = {}): RecipeChunk[] {
  // Recipe shape: header (metadata) `\n---\n` body (flow steps).
  // Maestro allows multiple `---` blocks but our recipes only use one
  // separator. Reject anything else — we'd otherwise silently
  // misinterpret a multi-doc YAML.
  const separators = body.split(/^---\s*$/m);
  if (separators.length < 2) {
    // No flow section yet — return a single chunk that is the entire
    // body so the caller can still invoke Maestro (which will
    // validate the structural error in its own way).
    return [{ yaml: body, index: 0 }];
  }
  if (separators.length > 2) {
    throw new Error(
      'recipe-splitter: recipe has more than one `---` separator; ' +
        'splitting multi-document recipes is not supported. Reduce to ' +
        'one header + one flow section.',
    );
  }
  const header = separators[0];
  const flow = separators[1];

  // Walk the flow line-by-line; identify top-level steps by their
  // leading dash at column 0 (`- foo:`). A step that is just
  // `- takeScreenshot: "name"` or `- takeScreenshot:\n    ...` triggers
  // a split AFTER it. We track indentation: a step at column 0 starts a
  // new top-level item, and everything indented under it belongs to
  // that item — including `runFlow.commands` blocks where nested
  // `takeScreenshot:` does NOT split (those screenshots become part of
  // the surrounding chunk).
  const lines = flow.split('\n');
  const chunks: { lines: string[]; screenshotName?: string }[] = [];
  let current: { lines: string[]; screenshotName?: string } = { lines: [] };

  // State for tracking whether we're currently inside a top-level step
  // (depth > 0) or between them (depth 0). We only ever split between
  // top-level steps.
  let inTopLevelStep = false;
  let pendingScreenshotName: string | undefined;
  // Only used when opts.captureAllBoundaries is set. pendingRunFlowClose
  // tracks whether the top-level step we just finished was a `runFlow`
  // (so the NEXT top-level step boundary is that runFlow's "-post"
  // window). runFlowIndex numbers top-level runFlows in document order
  // for deterministic, collision-free boundary names.
  let pendingRunFlowClose = false;
  let runFlowIndex = 0;
  // Tracks whether we've reached the first top-level step yet. A `-pre`
  // split immediately before the FIRST top-level step in the flow would
  // finalize a chunk containing only whatever preamble preceded it —
  // and in both calibration recipes that preamble is pure comments (no
  // real steps), which is itself an empty-flow chunk by another name.
  // Suppressing the very first `-pre` folds that preamble into the
  // first runFlow's own `-post` chunk instead of emitting a wasted
  // window for it.
  let sawFirstTopLevelStep = false;

  const finalize = () => {
    if (pendingScreenshotName !== undefined) {
      current.screenshotName = pendingScreenshotName;
      pendingScreenshotName = undefined;
    }
    // Always push, even if empty — empty trailing chunks are filtered
    // at return-time so the caller never invokes Maestro on whitespace.
    chunks.push(current);
    current = { lines: [] };
    inTopLevelStep = false;
  };

  // Match `- takeScreenshot: "name"` and `- takeScreenshot: name` and
  // `- takeScreenshot:` (with name on the next line as a string scalar
  // under `path:` — but our codebase only uses the inline form, so we
  // restrict to inline). Accept either no quotes, double quotes, or
  // single quotes around the name.
  const takeScreenshotRe = /^-\s+takeScreenshot:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/;
  const topLevelStepRe = /^-\s+/;
  const topLevelRunFlowRe = /^-\s+runFlow:/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTopLevelStep = topLevelStepRe.test(line);

    if (isTopLevelStep) {
      // We're starting a new top-level step. If the previous one was a
      // `takeScreenshot` (recorded in pendingScreenshotName), this is
      // the moment to split — finalize current chunk, start a new one.
      const startsRunFlow = topLevelRunFlowRe.test(line);
      if (pendingScreenshotName !== undefined) {
        finalize();
      } else if (
        opts.captureAllBoundaries &&
        sawFirstTopLevelStep &&
        (startsRunFlow || pendingRunFlowClose)
      ) {
        // Split BEFORE a runFlow (the `-pre` window) and AFTER the
        // previous step if IT was a runFlow (the `-post` window). Two
        // back-to-back top-level runFlows share ONE boundary window here
        // — labeled as the first one's `-post` — rather than an
        // independent `-post` + empty `-pre` pair: nothing runs between
        // them, so a second dump would just be a duplicate of the first
        // one's screen, paid for at full `maestro test` cost. Gated on
        // `sawFirstTopLevelStep` so the very first top-level step in the
        // file never opens a `-pre` window against bare preamble (see
        // the flag's declaration above).
        pendingScreenshotName = pendingRunFlowClose
          ? `-branch${runFlowIndex - 1}-post`
          : `-branch${runFlowIndex}-pre`;
        finalize();
      }
      pendingRunFlowClose = startsRunFlow;
      if (startsRunFlow) {
        runFlowIndex++;
      }
      sawFirstTopLevelStep = true;
      inTopLevelStep = true;

      const match = line.match(takeScreenshotRe);
      if (match) {
        pendingScreenshotName = match[1] ?? match[2] ?? match[3];
      }
    }
    current.lines.push(line);
  }
  // Final flush.
  finalize();

  return chunks
    .filter((c) => c.lines.some((l) => l.trim() !== ''))
    .map((c, index) => ({
      yaml: header + '---\n' + c.lines.join('\n'),
      screenshotName: c.screenshotName,
      index,
    }));
}

/**
 * Convenience wrapper that reads `recipePath` from disk and delegates.
 * Forwards `opts` to `splitRecipeAtScreenshots` (both optional) so this
 * wrapper carries the same opt-in `captureAllBoundaries` capability as
 * its underlying implementation — a caller reading a recipe off disk
 * shouldn't have a narrower contract than one that already has the body
 * in memory. Backward-compatible: existing zero-arg-`opts` callers are
 * unaffected.
 */
export function splitRecipeFileAtScreenshots(
  recipePath: string,
  opts: SplitOptions = {},
): RecipeChunk[] {
  const body = fs.readFileSync(recipePath, 'utf8');
  return splitRecipeAtScreenshots(body, opts);
}
