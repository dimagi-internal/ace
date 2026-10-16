/**
 * Labs MAY draw a report's body inside a sandboxed iframe. When it does, every
 * scene target ACE authors against that report has to enter the frame; when it
 * does not, no target may (ace#2885).
 *
 * ## What changed upstream
 *
 * connect-labs moved page and workflow render code into an `allow-scripts`-only
 * iframe at `/labs/sandbox/render/` (dimagi-internal/connect-labs#2449 pages,
 * #2466 workflows opt-in, #2470 the 40 checked templates, all merged
 * 2026-10-12..13). The frame has an opaque origin, and the outer labs page
 * keeps only the breadcrumb and the scope picker. Observed on programme report
 * 8529 run 8894: the top-level `document.body.innerText` was 270 characters
 * ("Opportunities: 5 selected"), and the report text was in the frame
 * `…/labs/sandbox/render/?run_id=8894&program_id=10115`.
 *
 * That breaks two things that read the TOP page:
 *
 *  1. **Scene targets.** canopy's recorder resolves a target with
 *     `page.locator(…)` / `page.get_by_*(…)` on the top frame, so
 *     `css:tr:has-text("…")` and `role:tab:Benchmarks` no longer match. On
 *     `smallholder-seasonal/20261012-1549` scene 1's `wait_for` failed the
 *     first render. The fix that worked was to prefix every target with
 *     {@link LABS_SANDBOX_FRAME_PREFIX}.
 *  2. **On-screen text.** The recorder's `scene_<N>_page_text.json` is
 *     `document.body.innerText` of the top page only. A figure check that reads
 *     it cannot see any report figure. Fetching the render URL is no way round
 *     this either: the shell is "fixed, data-free … same bytes for everyone"
 *     (connect-labs `workflow/sandbox.py`). Measured: 1,536 bytes, title "Page",
 *     no run id in the body. The report data arrives over a MessageChannel
 *     bridge, so only a live browser that ENTERS the frame can read it.
 *     `scripts/capture-scene-text.ts` is that capture path, and
 *     {@link combineFrameTexts} is the text the figure check reads.
 *
 * Every ACE helper that writes or reads a labs report target goes through this
 * module, so the frame selector lives in exactly one place.
 *
 * ## The frame is CONDITIONAL: decide per page from what a capture observed
 *
 * Labs does not frame every report. On 2026-10-16 (smallholder-seasonal/
 * 20261015-1402, Phase 7) the indicator programme report (workflow 10049), the
 * worker review (10051) and the opp reports drew their body on the TOP page.
 * A Playwright probe of the run page listed no `/labs/sandbox/render/` iframe
 * (`{"iframes":[],"topPageHasReportText":true}`, ace#2885 reopen comment), and
 * the owner's note (2026-10-13) is that the sandbox is still being evaluated
 * per report. A URL therefore cannot say which shape a page has. Deciding from
 * the URL alone flagged all 14 targets of that run's spec, and following the
 * rewrite would have made every one MISS.
 *
 * No single selector covers both shapes. Playwright refuses a frame locator
 * inside `locator.or()` / `internal:or=` ("Frame locators are not allowed
 * inside composite locators", checked in headless chromium on playwright
 * 1.59.1), and canopy's recorder cannot branch on the page. So a target is
 * written for the shape the page HAS, and the shape comes from
 * `scripts/capture-scene-text.ts`, which records every child frame
 * ({@link framingFromCaptures}). {@link checkLabsReportFrameTargets} flags in
 * both directions against that observation, and says nothing for a scene whose
 * shape nobody observed.
 *
 * Pure: no I/O.
 */

/** The labs sandbox frame. `src` keeps its query (`?run_id=…`), so match on the path. */
export const LABS_SANDBOX_FRAME_SELECTOR = 'iframe[src*="/labs/sandbox/render/"]';

/** The path every labs sandbox frame is served from. */
export const LABS_SANDBOX_RENDER_PATH = '/labs/sandbox/render/';

/**
 * The selector chain that enters the sandbox frame. This is what
 * `page.frameLocator(sel).locator(…)` serialises to, and `page.locator()`
 * accepts it as a string. It is the exact prefix the DDD agent used to fix
 * `smallholder-seasonal/20261012-1549`.
 */
export const LABS_SANDBOX_FRAME_PREFIX = `${LABS_SANDBOX_FRAME_SELECTOR} >> internal:control=enter-frame >> `;

const RECORDER_PREFIX = /^(css|text|testid|aria|role):/i;

/** Does this recorder target already resolve inside the labs sandbox frame? */
export function isInLabsReportFrame(target: string | undefined): boolean {
  return (target ?? '').includes('internal:control=enter-frame');
}

const q = (s: string) => JSON.stringify(s);

/**
 * canopy `targets.py`'s bare-target heuristic (`looks_like_selector`), ported
 * as-is so a bare target converts the same way the recorder would read it.
 */
function looksLikeSelector(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if ('#.[:'.includes(t[0]) && t.length > 1 && /[A-Za-z0-9\-_*[]/.test(t[1])) return true;
  if (/^[A-Za-z]/.test(t) && /[>[.#:]/.test(t)) return true;
  return false;
}

/**
 * The Playwright selector string a canopy recorder target resolves to, with the
 * same exactness canopy `targets.py` passes to each `get_by_*` call:
 *
 *   css:X                → X
 *   role:tab:Benchmarks  → internal:role=tab[name="Benchmarks"s]  (exact, as canopy)
 *   role:button          → internal:role=button
 *   text:Foo             → internal:text="Foo"i                    (get_by_text, not exact)
 *   testid:foo           → internal:testid=[data-testid="foo"s]
 *   aria:Foo             → internal:label="Foo"i                   (get_by_label, exact=False)
 *   bare                 → as css if it looks like a selector, else as text
 *
 * These are the strings `page.getByRole(…)` and the rest serialise to, so
 * `page.locator()` accepts them as part of a selector chain.
 */
export function recorderTargetToSelector(target: string): string {
  const m = RECORDER_PREFIX.exec(target);
  const kind = m ? m[1].toLowerCase() : looksLikeSelector(target) ? 'css' : 'text';
  const value = m ? target.slice(m[0].length) : target;
  switch (kind) {
    case 'css':
      return value;
    case 'role': {
      const sep = value.indexOf(':');
      return sep < 0 ? `internal:role=${value}` : `internal:role=${value.slice(0, sep)}[name=${q(value.slice(sep + 1))}s]`;
    }
    case 'testid':
      return `internal:testid=[data-testid=${q(value)}s]`;
    case 'aria':
      return `internal:label=${q(value)}i`;
    default:
      return `internal:text=${q(value)}i`;
  }
}

/**
 * Rewrite a canopy recorder target so it resolves INSIDE the labs sandbox
 * frame. The result is always a `css:` target, because only `page.locator()`
 * takes a selector chain. For example, `role:tab:Benchmarks` becomes
 * `css:iframe[src*="/labs/sandbox/render/"] >> internal:control=enter-frame >> internal:role=tab[name="Benchmarks"s]`.
 *
 * Idempotent: a target that already enters the frame is returned unchanged.
 */
export function inLabsReportFrame(target: string): string {
  if (isInLabsReportFrame(target)) return target;
  return `css:${LABS_SANDBOX_FRAME_PREFIX}${recorderTargetToSelector(target)}`;
}

/**
 * The inverse of {@link inLabsReportFrame}: the same target on a report that
 * draws its body on the top page. A target that does not enter the frame is
 * returned unchanged. The result stays a `css:` target, because the inner
 * selector may be an `internal:` engine string that only `page.locator()` reads.
 */
export function outOfLabsReportFrame(target: string): string {
  const framed = `css:${LABS_SANDBOX_FRAME_PREFIX}`;
  return target.startsWith(framed) ? `css:${target.slice(framed.length)}` : target;
}

/**
 * Is a scene's surface a labs report, whose body labs MAY draw in the sandbox
 * frame? It says nothing about whether it does (see the module note).
 * A `${…}` realized var counts: in a `demo-narrative` spec every one names a
 * labs dashboard (`base_url` is labs, and each var is a `*_par_url` /
 * `*_review_url` from `realized.json`). So does a resolved labs workflow run or
 * page URL.
 */
export function isLabsReportSurface(url: string | null | undefined): boolean {
  if (!url) return false;
  if (/^\$\{[^}]+\}/.test(url.trim())) return true;
  return /labs\.connect\.dimagi\.com\/labs\/(workflow\/\d+\/run|p)\//.test(url) || /^\/labs\/(workflow\/\d+\/run|p)\//.test(url);
}

/** Actions whose `target` is an element (canopy `narrative/models.py`); `goto`'s target is a URL. */
const TARGETED_KINDS = new Set(['click', 'click_menu', 'fill', 'select', 'hover', 'scroll_to', 'wait_for', 'upload']);

export interface FramedScene {
  title?: string;
  url?: string | null;
  actions?: Array<{ kind: string; target?: string }>;
  restore?: Array<{ kind: string; target?: string }>;
}

export interface FrameTargetFinding {
  kind: 'labs-report-target-outside-frame' | 'labs-report-target-in-absent-frame';
  scene: string;
  detail: string;
}

/** What a capture saw a scene's page draw: the report in the sandbox frame, or on the top page. */
export type SurfaceFraming = 'framed' | 'unframed';

/** A capture of one scene, as `scene_<N>_page_text.json` records it (N 1-based). */
export interface FramingCapture {
  scene_index: number;
  /** Every child frame. Absent on canopy's own capture, which reads the top page only. */
  frame_texts?: readonly FrameText[];
}

/**
 * Each captured scene's framing, keyed by 1-based scene index. Only a capture
 * that recorded its child frames (`frame_texts`, as `capture-scene-text.ts`
 * writes) can answer. canopy's top-page-only capture is left out, because it
 * cannot tell "no frame" from "did not look".
 */
export function framingFromCaptures(captures: readonly FramingCapture[]): Map<number, SurfaceFraming> {
  const out = new Map<number, SurfaceFraming>();
  for (const c of captures) {
    if (c.frame_texts === undefined) continue;
    out.set(c.scene_index, c.frame_texts.some((f) => isSandboxFrameUrl(f.url)) ? 'framed' : 'unframed');
  }
  return out;
}

/**
 * Flag every action target on a labs report surface whose shape does not match
 * what the capture observed for that scene. `framing` is keyed by 1-based scene
 * index, from {@link framingFromCaptures}. A scene with no `url` is on the
 * previous scene's page (`demo-narrative` § Step 3's first-scene-only `url` rule).
 *
 *  - Observed `framed`: a target that does not enter the frame misses
 *    (`labs-report-target-outside-frame`; the fix is {@link inLabsReportFrame}).
 *  - Observed `unframed`: a target that enters the frame misses, because there
 *    is no frame (`labs-report-target-in-absent-frame`; the fix is
 *    {@link outOfLabsReportFrame}).
 *  - Not observed: no finding. The URL cannot say which shape labs serves, so
 *    a guess here is wrong whenever labs flips a report (ace#2885, reopened
 *    2026-10-16).
 *
 * This FLAGS rather than rejects, like every check in `ddd-scene-actions`. The
 * outer labs page still draws the breadcrumb and the scope picker, and a target
 * aimed at those is right as written. The finding carries the rewritten target,
 * so resolving it is one paste.
 */
export function checkLabsReportFrameTargets(
  scenes: readonly FramedScene[],
  framing: ReadonlyMap<number, SurfaceFraming> = new Map(),
): FrameTargetFinding[] {
  const findings: FrameTargetFinding[] = [];
  let surface: string | null | undefined = null;
  (scenes ?? []).forEach((s, i) => {
    if (s.url) surface = s.url;
    const shape = framing.get(i + 1);
    if (!shape || !isLabsReportSurface(surface)) return;
    const name = s.title ?? '(untitled)';
    for (const a of [...(s.actions ?? []), ...(s.restore ?? [])]) {
      if (!a.target || !TARGETED_KINDS.has(a.kind)) continue;
      if (a.kind === 'wait_for' && /^\d+$/.test(a.target.trim())) continue; // an all-digits wait_for is a pause
      const inside = isInLabsReportFrame(a.target);
      if (shape === 'framed' && !inside) {
        findings.push({
          kind: 'labs-report-target-outside-frame',
          scene: name,
          detail:
            `${a.kind} "${a.target}" is on a labs report that the capture saw drawn in the ${LABS_SANDBOX_RENDER_PATH} ` +
            'iframe. The recorder resolves targets on the TOP page, so this misses (ace#2885). Write it as ' +
            `"${inLabsReportFrame(a.target)}" (inLabsReportFrame in lib/labs-report-frame.ts). Leave it only if it ` +
            'names the outer page (the breadcrumb or the scope picker).',
        });
      } else if (shape === 'unframed' && inside) {
        findings.push({
          kind: 'labs-report-target-in-absent-frame',
          scene: name,
          detail:
            `${a.kind} "${a.target}" enters the ${LABS_SANDBOX_RENDER_PATH} iframe, but the capture saw this report ` +
            'drawn on the top page with no sandbox frame, so the target misses (ace#2885). Write it as ' +
            `"${outOfLabsReportFrame(a.target)}" (outOfLabsReportFrame in lib/labs-report-frame.ts).`,
        });
      }
    }
  });
  return findings;
}

/** One frame's text, as a capture records it. */
export interface FrameText {
  url: string;
  text: string;
}

/** Is this the labs sandbox frame? */
export function isSandboxFrameUrl(url: string): boolean {
  return url.includes(LABS_SANDBOX_RENDER_PATH);
}

/**
 * The text a viewer actually reads: the outer page plus every child frame's
 * text. The sandbox frame comes first because it holds the report.
 */
export function combineFrameTexts(outer: string, frames: readonly FrameText[]): string {
  const ordered = [...frames].sort((a, b) => Number(isSandboxFrameUrl(b.url)) - Number(isSandboxFrameUrl(a.url)));
  return [...ordered.map((f) => f.text), outer].filter((t) => t && t.trim()).join('\n');
}
