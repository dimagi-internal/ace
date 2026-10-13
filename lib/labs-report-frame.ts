/**
 * Labs draws a report's body inside a sandboxed iframe, so every scene target
 * ACE authors against a labs report has to enter that frame (ace#2885).
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
 * Is a scene's surface a labs report, whose body is drawn in the sandbox frame?
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
  kind: 'labs-report-target-outside-frame';
  scene: string;
  detail: string;
}

/**
 * Flag every action target on a labs report surface that does not enter the
 * sandbox frame. A scene with no `url` is on the previous scene's page
 * (`demo-narrative` § Step 3's first-scene-only `url` rule).
 *
 * This FLAGS rather than rejects, like every check in `ddd-scene-actions`. The
 * outer labs page still draws the breadcrumb and the scope picker, and a target
 * aimed at those is right as written. The finding carries the rewritten target,
 * so resolving it is one paste.
 */
export function checkLabsReportFrameTargets(scenes: readonly FramedScene[]): FrameTargetFinding[] {
  const findings: FrameTargetFinding[] = [];
  let surface: string | null | undefined = null;
  for (const s of scenes ?? []) {
    if (s.url) surface = s.url;
    if (!isLabsReportSurface(surface)) continue;
    const name = s.title ?? '(untitled)';
    for (const a of [...(s.actions ?? []), ...(s.restore ?? [])]) {
      if (!a.target || !TARGETED_KINDS.has(a.kind) || isInLabsReportFrame(a.target)) continue;
      if (a.kind === 'wait_for' && /^\d+$/.test(a.target.trim())) continue; // an all-digits wait_for is a pause
      findings.push({
        kind: 'labs-report-target-outside-frame',
        scene: name,
        detail:
          `${a.kind} "${a.target}" is on a labs report, whose body labs draws in the ${LABS_SANDBOX_RENDER_PATH} ` +
          'iframe. The recorder resolves targets on the TOP page, so this misses (ace#2885). Write it as ' +
          `"${inLabsReportFrame(a.target)}" (inLabsReportFrame in lib/labs-report-frame.ts). Leave it only if it ` +
          'names the outer page (the breadcrumb or the scope picker).',
      });
    }
  }
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
