/**
 * Narration ↔ screen: every figure a scene SAYS must be on that scene's END
 * FRAME, and a page edit must not silently falsify a locked claim (ace#2727).
 *
 * Two observed failures on spark-facilitator/20261004-1706's Phase 7 demo:
 *
 *  1. Narration cited "100% as of 12 Jul" — a value the page shows only in a
 *     hover tooltip. `demo-narrative` step 2c's only figure rule says "never
 *     claim a figure the saved run does not show", and a tooltip value IS in
 *     the saved run, so the rule passed it. The viewer never sees it: the judged
 *     still and the video's end frame are taken with no cursor over the cell.
 *     The rule checked the DATA; nothing checked the FRAME.
 *
 *  2. During the DDD loop a template-workflow page fix merged two identical
 *     peer-median columns. The fix was a fair product change, but the narration
 *     was LOCKED and said "both peer medians" — so the edit made a locked claim
 *     false, and nobody re-read the claims of the scenes that page appears in.
 *
 * (1) is decidable from the spec: `checkNarratedFiguresOnScreen` requires every
 * narrated figure to be ANCHORED — written into the scene's `features[].verify`
 * (where on the end frame it is) or a `wait_for` target (a gate that proves the
 * page rendered it) — and refuses an anchor that is a hover/tooltip. It FLAGS
 * rather than rejects, like `checkSceneCardinality`: it reads the spec, not the
 * rendered page, so the author resolves each flag by anchoring the figure or
 * cutting it from the narration.
 *
 * (2) is a runtime discipline in canopy's loop, which ACE does not own; ACE's
 * lever is the dispatch. `narrationClaimsBySurface` builds the per-page ledger
 * of locked claims that `agents/synthetic-data-and-workflows.md` Step 3 hands
 * the loop with the rule: re-check these before any edit to that page.
 *
 * (3) The spec check above cannot see what the page PRINTS. Labs draws its
 * reports inside the `/labs/sandbox/render/` iframe (ace#2885), so a capture
 * of the top page's text is blind to every report figure.
 * `checkNarratedFiguresAgainstScreenText` reads a capture that entered the
 * frame (`scripts/capture-scene-text.ts`, which records `frame_texts`). Given an
 * outer-page-only capture (canopy's `scene_<N>_page_text.json`) of a labs
 * report scene, it says the capture is blind once per scene. It does not flag
 * every figure as missing.
 *
 * Pure: no I/O.
 */

import { combineFrameTexts, isLabsReportSurface, type FrameText } from './labs-report-frame.js';

export interface NarrationAction {
  kind: string;
  target?: string;
}

export interface NarrationFeature {
  description?: string;
  verify?: string;
}

/** The subset of a canopy `Scene` this module reads. */
export interface NarratedScene {
  id?: string;
  title?: string;
  url?: string | null;
  /** canopy `Scene.narrative` — one string or a list of beats. */
  narrative?: string | string[];
  actions?: NarrationAction[];
  features?: NarrationFeature[];
}

export type NarrationFindingKind =
  /** A narrated figure no `features[].verify` or `wait_for` anchors to the end frame. */
  | 'unanchored-figure'
  /** A narrated figure whose only anchor is a hover / tooltip — not in the end frame. */
  | 'hover-only-figure'
  /** ace#2885 — a narrated figure absent from the scene's captured on-screen text (frames included). */
  | 'figure-not-on-screen'
  /** ace#2885 — the capture read only the top page of a labs report, so it cannot see the report's figures. */
  | 'screen-text-outer-page-only';

export interface NarrationFinding {
  kind: NarrationFindingKind;
  scene: string;
  figure: string;
  detail: string;
}

export interface NarrationReport {
  ok: boolean;
  findings: NarrationFinding[];
}

const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|' +
  'Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\b';

/**
 * What counts as a figure: a percentage, an "N of M" count, a decimal, a money
 * amount, or a calendar date ("12 Jul", "July 12", "2026-07-12"). Bare integers
 * are left out on purpose — "Step 7" and "13 weeks" are labels and spans, and
 * flagging them would bury the real findings (ace#1893's lesson: a noisy flag
 * costs the author's trust in every flag after it).
 */
const FIGURE_PATTERNS: readonly RegExp[] = [
  /\b\d+(?:\.\d+)?\s?%/g,
  /\b\d+\s+(?:of|out of)\s+\d+\b/gi,
  /(?:USD|US\$|\$|MWK|KES|UGX|NGN)\s?\d[\d,]*(?:\.\d+)?/g,
  new RegExp(`\\b\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?`, 'g'),
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\b`, 'g'),
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d+\.\d+\b/g,
];

/** Words that mark an anchor (or the narration itself) as hover-only. */
const HOVER_WORDS = /\b(hover(?:ing|ed)?|tooltip|mouse-?over|on hover|title attribute)\b/i;

export function narrationText(narrative: string | string[] | undefined): string {
  if (Array.isArray(narrative)) return narrative.join(' ');
  return narrative ?? '';
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').replace(/\s%/g, '%').trim();

/** Every figure in `text`, deduplicated, longest first (so "12 Jul 2026" wins over "12 Jul"). */
export function extractNarratedFigures(text: string): string[] {
  const found: Array<{ s: string; start: number; end: number }> = [];
  for (const re of FIGURE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      found.push({ s: m[0].trim(), start, end: start + m[0].length });
    }
  }
  found.sort((a, b) => b.end - b.start - (a.end - a.start));
  const kept: typeof found = [];
  for (const f of found) {
    if (kept.some((k) => f.start >= k.start && f.end <= k.end)) continue; // inside a longer figure
    kept.push(f);
  }
  return [...new Set(kept.sort((a, b) => a.start - b.start).map((k) => k.s))];
}

function sceneName(s: NarratedScene, i: number): string {
  return s.id || s.title || `scene ${i + 1}`;
}

/**
 * Every narrated figure must be visible in the scene's end frame: anchored by a
 * `features[].verify` sentence or a `wait_for` target that contains it, and not
 * only by a hover/tooltip.
 */
export function checkNarratedFiguresOnScreen(scenes: readonly NarratedScene[]): NarrationReport {
  const findings: NarrationFinding[] = [];
  scenes.forEach((scene, i) => {
    const said = narrationText(scene.narrative);
    const figures = extractNarratedFigures(said);
    if (!figures.length) return;
    const name = sceneName(scene, i);
    const anchors: Array<{ text: string; hover: boolean }> = [
      ...(scene.features ?? []).map((f) => ({ text: f.verify ?? '', hover: HOVER_WORDS.test(f.verify ?? '') })),
      ...(scene.actions ?? [])
        .filter((a) => a.kind === 'wait_for')
        .map((a) => ({ text: a.target ?? '', hover: false })),
      // A hover action's target is an anchor only in the sense that the value
      // appears under the cursor — which is exactly the hover-only case.
      ...(scene.actions ?? [])
        .filter((a) => a.kind === 'hover')
        .map((a) => ({ text: a.target ?? '', hover: true })),
    ];
    const narrationSaysHover = HOVER_WORDS.test(said);
    for (const fig of figures) {
      const hits = anchors.filter((a) => norm(a.text).includes(norm(fig)));
      const visible = hits.filter((a) => !a.hover);
      if (visible.length && !narrationSaysHover) continue;
      if (hits.length || narrationSaysHover) {
        findings.push({
          kind: 'hover-only-figure',
          scene: name,
          figure: fig,
          detail:
            `"${fig}" is narrated but shown only on hover — the judged still and the end frame have no tooltip open. ` +
            'Say a figure the frame prints, or make the page print it (a column, a chip, a caption), or cut it.',
        });
      } else {
        findings.push({
          kind: 'unanchored-figure',
          scene: name,
          figure: fig,
          detail:
            `"${fig}" is narrated but nothing anchors it to the end frame — write where it is visible into a ` +
            '`features[].verify` ("the SF_P1 column reads 62%") or gate on it with `wait_for`, or cut it from the narration.',
        });
      }
    }
  });
  return { ok: findings.length === 0, findings };
}

export interface SurfaceClaims {
  /** The page a run of scenes is on: the scene's `url`, inherited by follow-on scenes. */
  surface: string;
  scenes: Array<{ scene: string; narration: string; figures: string[] }>;
}

/**
 * The ledger of LOCKED narration claims per page (ace#2727). A follow-on scene
 * without a `url` is on the previous scene's page (`demo-narrative` § Step 3's
 * first-scene-only `url` rule), so it inherits that surface. Hand this to the
 * DDD loop: an edit to a page must leave every claim listed under it true.
 */
export function narrationClaimsBySurface(scenes: readonly NarratedScene[]): SurfaceClaims[] {
  const out: SurfaceClaims[] = [];
  let current = '(no url yet)';
  scenes.forEach((scene, i) => {
    if (scene.url) current = scene.url;
    let entry = out.find((e) => e.surface === current);
    if (!entry) {
      entry = { surface: current, scenes: [] };
      out.push(entry);
    }
    const narration = narrationText(scene.narrative);
    entry.scenes.push({ scene: sceneName(scene, i), narration, figures: extractNarratedFigures(narration) });
  });
  return out;
}

/** The ledger as the markdown block the Step 3 dispatch prompt carries. */
export function renderClaimsLedger(ledger: readonly SurfaceClaims[]): string {
  const lines: string[] = ['## Locked narration claims, by page (re-check before editing that page)'];
  for (const e of ledger) {
    lines.push('', `### ${e.surface}`);
    for (const s of e.scenes) {
      const figs = s.figures.length ? ` [figures: ${s.figures.join(', ')}]` : '';
      lines.push(`- **${s.scene}**: "${s.narration}"${figs}`);
    }
  }
  return lines.join('\n');
}

/**
 * One scene's captured on-screen text, in the layout canopy writes
 * (`scene_<N>_page_text.json`, N 1-based). `frame_texts` is present only when
 * the capture entered child frames (`scripts/capture-scene-text.ts`). canopy's
 * recorder writes `page_text` from the top page alone.
 */
export interface SceneScreenText {
  scene_index: number;
  page_text: string;
  frame_texts?: FrameText[];
}

/**
 * Check every narrated figure against the text the scene's end frame actually
 * printed, child frames included (ace#2885). Captures are keyed by canopy's
 * 1-based `scene_index`; a scene with no capture is skipped, as canopy's
 * `narrated_numbers` skips it.
 */
export function checkNarratedFiguresAgainstScreenText(
  scenes: readonly NarratedScene[],
  captures: readonly SceneScreenText[],
): NarrationReport {
  const findings: NarrationFinding[] = [];
  const byIndex = new Map(captures.map((c) => [c.scene_index, c]));
  let surface: string | null | undefined = null;
  scenes.forEach((scene, i) => {
    if (scene.url) surface = scene.url;
    const figures = extractNarratedFigures(narrationText(scene.narrative));
    const cap = byIndex.get(i + 1);
    if (!figures.length || !cap) return;
    const name = sceneName(scene, i);
    const onScreen = norm(combineFrameTexts(cap.page_text, cap.frame_texts ?? []));
    const missing = figures.filter((fig) => !onScreen.includes(norm(fig)));
    // ace#2885: labs frames some reports and not others. A top-page-only capture
    // of an UNFRAMED report holds the figures, so it is judged like any other.
    // Only when figures are missing can it not tell "not printed" from "printed
    // in a frame this capture never entered".
    if (missing.length && cap.frame_texts === undefined && isLabsReportSurface(surface)) {
      findings.push({
        kind: 'screen-text-outer-page-only',
        scene: name,
        figure: missing.join(', '),
        detail:
          'This capture read only the top page, and it does not print these figures. Labs may draw the report in ' +
          'the /labs/sandbox/render/ iframe, which canopy\'s recorder (top-page document.body.innerText) never ' +
          'enters. Re-capture with scripts/capture-scene-text.ts, which records every frame.',
      });
      return;
    }
    for (const fig of missing) {
      findings.push({
        kind: 'figure-not-on-screen',
        scene: name,
        figure: fig,
        detail:
          `"${fig}" is narrated, but the scene's captured end-frame text (child frames included) does not contain it. ` +
          'Say the figure the page prints, or cut it.',
      });
    }
  });
  return { ok: findings.length === 0, findings };
}
