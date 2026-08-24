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
// SEPARATE-FILE subflows are different, and that difference is
// dimagi-internal/ace#1570. `runFlow: file: form-advance.yaml` is not an
// inline block — it is a whole other recipe with its OWN top-level
// `takeScreenshot:` steps, and ACE's Phase-3 authoring idiom
// (skills/app-test-cases/SKILL.md) composes journeys almost entirely out
// of those calls. Every palette file under `recipes/static/` screenshots.
// Reading only the parent's text, the splitter saw nothing to split on, so
// a 97-step Learn journey ran as `chunk 1/1`: ONE Maestro invocation, ONE
// watchdog budget, and ONE UI dump for the whole walk. On
// hh-poverty-targeting/20260819-1435 that single chunk was killed by the
// then-flat 600s watchdog while still advancing — and Connect's Learn
// completion is ONE-WAY per (test user, opportunity), so the kill
// permanently consumed the precondition and cost the run.
//
// So: when the caller supplies `resolveSubflow`, a top-level
// `runFlow: file:` into a palette that screenshots as its FIRST or LAST
// top-level step opens a boundary at that exact point — before the
// runFlow for a leading screenshot, after it for a trailing one. That
// mirrors what the subflow does on-device, so `<name>.xml` still pairs
// with the `<name>.png` Maestro writes. Without a resolver the behaviour
// is bit-for-bit what it was before; the resolver is the whole seam.
//
// Header preservation. The recipe's metadata block (`appId:`,
// `name:`, etc.) — everything before the first `---` separator —
// is replicated at the head of every chunk. Maestro requires this on
// each invocation. The `launchApp` step is NOT auto-added; if the
// original recipe didn't have one, the chunks won't either (Maestro
// uses the `appId` to attach to the running app, which is correct for
// our use case where chunk 1 leaves the app foregrounded for chunk 2).

import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

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
   * Boundary chunks set `screenshotName` to `branch<N>-pre` /
   * `branch<N>-post` — NO leading hyphen. `screenshotName` becomes a
   * bare filename (`<screenshotName>.xml` / `.png`, see
   * `captureUiDump` in `backends/maestro.ts`), and a leading `-` there
   * produces files that read as CLI flags to every shell tool
   * (`-branch0-pre.xml`). See the test asserting `/^branch\d+-pre$/`
   * in test/mcp/mobile/recipe-splitter.test.ts; no live caller
   * consumes this yet, so there's no established concatenation
   * convention to match beyond that test contract.
   */
  captureAllBoundaries?: boolean;
  /**
   * Reads the body of a `runFlow: file:` target by the filename the recipe
   * names, or returns `null` when it can't be resolved. Supplying it turns on
   * subflow-aware splitting (dimagi-internal/ace#1570); omitting it leaves the
   * splitter's behaviour exactly as it was before that fix.
   *
   * Production callers hand in a reader rooted at the RESOLVED recipe's own
   * directory — `prepareRecipeForMaestro` copies every palette file next to
   * the top-level recipe, which is also how Maestro itself resolves these
   * refs, so the splitter reads precisely the bytes the device will run.
   */
  resolveSubflow?: (filename: string) => string | null;
}

/**
 * Where a subflow takes its own top-level screenshots, at the two positions a
 * PARENT recipe can act on. A screenshot in the middle of a subflow is not
 * representable as a parent-level chunk boundary and is deliberately not
 * reported — the parent cannot split inside another file.
 *
 * Names are returned as AUTHORED, placeholders intact (`${SCREENSHOT_NAME}`);
 * resolving them against a call site's `env:` block is the caller's job.
 */
export interface SubflowScreenshotContract {
  /** Name template iff the subflow's FIRST top-level step is a takeScreenshot. */
  leading?: string;
  /** Name template iff the subflow's LAST top-level step is a takeScreenshot. */
  trailing?: string;
}

// Match `- takeScreenshot: "name"` / `'name'` / `name`, optional trailing
// comment. Shared by the splitter and the subflow describer so both agree on
// what counts as a screenshot step.
const TAKE_SCREENSHOT_RE = /^-\s+takeScreenshot:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/;
const TOP_LEVEL_STEP_RE = /^-\s+/;
const TOP_LEVEL_RUNFLOW_RE = /^-\s+runFlow:/;

/** The flow section of a recipe body — everything after the single `---`. */
function flowSection(body: string): string {
  const parts = body.split(/^---\s*$/m);
  return parts.length >= 2 ? parts.slice(1).join('\n') : body;
}

/**
 * Steps that observe the current surface without changing it, so they can sit
 * between a subflow's screenshot and the subflow's edge without invalidating
 * the boundary. Deliberately assertions ONLY.
 *
 * `extendedWaitUntil` and `waitForAnimationToEnd` are excluded even though
 * they take no action: a wait exists precisely BECAUSE the surface is still
 * changing, so the screen at the parent's boundary need not be the screen the
 * subflow's screenshot captured. Every palette here that leads with a wait
 * (`learn-tap-module.yaml`) therefore reports no leading boundary — the
 * conservative answer, since a mismatched dump is worse than a missing one.
 */
const SCREEN_NEUTRAL_STEPS = new Set(['assertVisible', 'assertNotVisible', 'assertTrue']);

/** `- tapOn:` → `tapOn`. */
function topLevelStepKey(line: string): string | undefined {
  const m = line.match(/^-\s+([A-Za-z][A-Za-z0-9_]*)/);
  return m ? m[1] : undefined;
}

/**
 * Read a subflow's leading/trailing top-level screenshot steps.
 *
 * "Leading" means nothing that could change the surface runs before it, and
 * "trailing" means nothing that could change the surface runs after it — so
 * the screen at the parent's chunk boundary IS the screen in the PNG. That is
 * the whole correctness condition for pairing `<name>.xml` with `<name>.png`.
 *
 * Deliberately a line scan on the same shapes the splitter already
 * recognises, not a YAML parse: it must agree with the splitter's notion of
 * "top-level step" exactly, and a shape it doesn't recognise degrades to "no
 * boundary" (today's behaviour) rather than to a wrong boundary.
 */
export function describeSubflowScreenshots(body: string): SubflowScreenshotContract {
  const steps = flowSection(body)
    .split('\n')
    .filter((l) => TOP_LEVEL_STEP_RE.test(l));
  const nameOf = (line: string | undefined): string | undefined => {
    const m = line?.match(TAKE_SCREENSHOT_RE);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  };
  const isNeutral = (line: string) => {
    const key = topLevelStepKey(line);
    return key !== undefined && SCREEN_NEUTRAL_STEPS.has(key);
  };
  const first = steps.find((l) => !isNeutral(l));
  const last = [...steps].reverse().find((l) => !isNeutral(l));
  const leading = nameOf(first);
  const trailing = nameOf(last);
  return {
    ...(leading !== undefined ? { leading } : {}),
    ...(trailing !== undefined ? { trailing } : {}),
  };
}

/**
 * Parse ONE top-level step block that starts with `- runFlow:` into the
 * subflow file it calls plus the `env:` bindings it passes. Returns `null`
 * for an inline `runFlow` (a `when:`/`commands:` block with no `file:`) —
 * those stay atomic, exactly as the module header says.
 */
function parseTopLevelRunFlow(
  blockLines: string[],
): { file: string; env: Record<string, string> } | null {
  let doc: unknown;
  try {
    doc = parseYaml(blockLines.join('\n'));
  } catch {
    return null;
  }
  if (!Array.isArray(doc) || doc.length !== 1) return null;
  const item = doc[0] as Record<string, unknown> | null;
  if (item === null || typeof item !== 'object') return null;
  const runFlow = (item as Record<string, unknown>).runFlow;
  // Scalar shorthand: `- runFlow: form-advance.yaml`.
  if (typeof runFlow === 'string') return { file: runFlow, env: {} };
  if (runFlow === null || typeof runFlow !== 'object' || Array.isArray(runFlow)) return null;
  const file = (runFlow as Record<string, unknown>).file;
  if (typeof file !== 'string' || file === '') return null;
  const rawEnv = (runFlow as Record<string, unknown>).env;
  const env: Record<string, string> = {};
  if (rawEnv !== null && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
    for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue;
      env[k] = String(v);
    }
  }
  return { file, env };
}

/**
 * Substitute a call site's `env:` bindings into a subflow's screenshot-name
 * template. Returns `undefined` when anything is left unresolved — an unbound
 * call site must never produce a literal `${SCREENSHOT_NAME}.xml` on disk
 * (the ace#1033 class). The boundary is still taken; only the dump is skipped.
 */
function resolveNameTemplate(tpl: string, env: Record<string, string>): string | undefined {
  const out = tpl.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(env, key) ? env[key] : whole,
  );
  if (out.includes('${') || out.trim() === '') return undefined;
  // A leading `-` becomes a filename that reads as a CLI flag to every shell
  // tool — same rule the captureAllBoundaries names follow.
  if (out.startsWith('-')) return undefined;
  return out;
}

/**
 * Boundary a palette `runFlow` opens, with names already resolved.
 *
 * `has*` and `*Name` are separate on purpose: an unbound call site still
 * earns its chunk boundary (a fresh watchdog budget, a smaller failure blast
 * radius) even though no dump can be named for it.
 */
interface PaletteBoundary {
  hasLeading: boolean;
  leadingName?: string;
  hasTrailing: boolean;
  trailingName?: string;
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
  // Set when the step just walked was a palette `runFlow` whose subflow
  // screenshots LAST (ace#1570): the boundary belongs after that runFlow, so
  // the next top-level step must finalize even if no name could be resolved
  // for the dump.
  let pendingSplit = false;

  const finalize = () => {
    if (pendingScreenshotName !== undefined) {
      current.screenshotName = pendingScreenshotName;
      pendingScreenshotName = undefined;
    }
    pendingSplit = false;
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
  const takeScreenshotRe = TAKE_SCREENSHOT_RE;
  const topLevelStepRe = TOP_LEVEL_STEP_RE;
  const topLevelRunFlowRe = TOP_LEVEL_RUNFLOW_RE;

  // Pre-pass (ace#1570): which top-level `runFlow: file:` steps call a palette
  // that screenshots as its own first/last step, and under what name. Needs a
  // whole step block (the `file:`/`env:` keys sit on the lines AFTER the
  // dash), so it can't be folded into the single-line walk below.
  const paletteBoundaries = new Map<number, PaletteBoundary>();
  if (opts.resolveSubflow) {
    const starts: number[] = [];
    for (let i = 0; i < lines.length; i++) if (topLevelStepRe.test(lines[i])) starts.push(i);
    for (let s = 0; s < starts.length; s++) {
      const start = starts[s];
      if (!topLevelRunFlowRe.test(lines[start])) continue;
      const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
      const call = parseTopLevelRunFlow(lines.slice(start, end));
      if (!call) continue;
      const subBody = opts.resolveSubflow(call.file);
      if (subBody === null || subBody === undefined) continue;
      const contract = describeSubflowScreenshots(subBody);
      const leadingName =
        contract.leading !== undefined ? resolveNameTemplate(contract.leading, call.env) : undefined;
      const trailingName =
        contract.trailing !== undefined
          ? resolveNameTemplate(contract.trailing, call.env)
          : undefined;
      if (contract.leading === undefined && contract.trailing === undefined) continue;
      paletteBoundaries.set(start, {
        hasLeading: contract.leading !== undefined,
        leadingName,
        hasTrailing: contract.trailing !== undefined,
        trailingName,
      });
    }
  }

  /**
   * Does the chunk being accumulated already carry a real step? A split that
   * finalizes a chunk with none produces a header-only recipe, which Maestro
   * rejects outright — and `runRecipeWithDumps` fails fast, aborting every
   * remaining chunk. Guards both the leading split immediately after another
   * split (nothing has run in between, so a second dump would photograph the
   * same screen) and the very first step in a file, whose preamble is
   * typically pure comments.
   */
  const currentHasStep = () => current.lines.some((l) => topLevelStepRe.test(l));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTopLevelStep = topLevelStepRe.test(line);

    if (isTopLevelStep) {
      // We're starting a new top-level step. If the previous one was a
      // `takeScreenshot` (recorded in pendingScreenshotName), this is
      // the moment to split — finalize current chunk, start a new one.
      const startsRunFlow = topLevelRunFlowRe.test(line);
      const palette = paletteBoundaries.get(i);
      if (pendingScreenshotName !== undefined || pendingSplit) {
        finalize();
      } else if (palette?.hasLeading && currentHasStep()) {
        // The subflow's FIRST action is its screenshot, so the surface it
        // captures is the one on screen right NOW — split before the runFlow
        // and let the dump window name itself after that screenshot.
        pendingScreenshotName = palette.leadingName;
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
          ? `branch${runFlowIndex - 1}-post`
          : `branch${runFlowIndex}-pre`;
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
      if (palette?.hasTrailing) {
        // The subflow's LAST action is its screenshot, so the surface it
        // captures is the one left on screen once this runFlow returns —
        // exactly what a top-level `takeScreenshot` step means here.
        pendingScreenshotName = palette.trailingName;
        pendingSplit = true;
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
