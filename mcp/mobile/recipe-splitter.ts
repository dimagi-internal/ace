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
   * Every top-level `runFlow` gets its OWN `-pre` and `-post` window,
   * unconditionally — even a `runFlow` immediately adjacent to another
   * top-level `runFlow` (no other step between them) still yields both
   * boundary windows, one of them a zero-step chunk. Boundary chunks
   * set `screenshotName` to `-branch<N>-pre` / `-branch<N>-post` (note
   * the leading hyphen: the caller concatenates `<recipe-id>` directly
   * with `screenshotName`, so the hyphen is the separator, producing
   * `<recipe-id>-branch<N>-pre.xml` on disk).
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
      } else if (opts.captureAllBoundaries && pendingRunFlowClose) {
        // The step we just finished was a top-level runFlow — close its
        // `-post` window before deciding whether the step we're about to
        // start needs its own `-pre` window (below). Deliberately NOT
        // merged with the `-pre` check below: two top-level `runFlow`s
        // back-to-back (no other step between them) still get BOTH the
        // first one's `-post` and the second one's `-pre` as independent
        // windows, even though that means finalizing an empty chunk here
        // — every runFlow boundary gets its own window, unconditionally.
        // Leading hyphen is deliberate: the caller concatenates
        // `<recipe-id>` directly with `screenshotName`, so this string
        // supplies its own separator (`<recipe-id>-branch0-post.xml`).
        pendingScreenshotName = `-branch${runFlowIndex - 1}-post`;
        finalize();
      }
      if (opts.captureAllBoundaries && startsRunFlow) {
        // `-pre` window immediately before this runFlow starts.
        pendingScreenshotName = `-branch${runFlowIndex}-pre`;
        finalize();
      }
      pendingRunFlowClose = startsRunFlow;
      if (startsRunFlow) {
        runFlowIndex++;
      }
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
    // Drop chunks that are BOTH empty and unnamed — the ordinary "tail
    // chunk when the recipe ends exactly on a takeScreenshot" case.
    // A chunk WITH a screenshotName is kept even when empty: back-to-back
    // top-level `runFlow`s under captureAllBoundaries legitimately
    // produce a zero-line `-post`/`-pre` pair at their shared boundary,
    // and each one still needs to run (as a no-op `maestro test`) so the
    // caller gets its dump window.
    .filter((c) => c.screenshotName !== undefined || c.lines.some((l) => l.trim() !== ''))
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
