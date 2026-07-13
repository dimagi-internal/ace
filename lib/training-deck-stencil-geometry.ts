/**
 * Training-deck stencil text-box geometry — the SINGLE SOURCE of the
 * per-stencil text-box layout (slide dimensions, brand palette, and the
 * 14 per-stencil {{TOKEN}} text-box builders).
 *
 * Consumed by:
 *  - `scripts/bootstrap-training-deck-template.ts` (template minting)
 *  - `scripts/rerender-training-deck-in-place.ts` (same-link re-render;
 *    rebuilds stencils inside an already-rendered deck — ace#864)
 *  - `lib/training-deck-spec.ts` (the mobile_flow caption-alignment logic
 *    derives its programmatic caption geometry from these constants so
 *    the N=4 output matches the stencil grid)
 *
 * Geometry carried over from bootstrap v3.4 (where it proved publishable)
 * through v5.8. Edit HERE — never re-copy these builders into a script.
 */

import type { StencilKey } from './training-deck-spec.js';

// ---------------------------------------------------------------------------
// Slide dimensions (EMU)
// ---------------------------------------------------------------------------

export const SLIDE_W = 9_144_000; // 10"
export const SLIDE_H = 5_143_500; // 5.625"
export const MARGIN = 457_200;    // 0.5"

// ---------------------------------------------------------------------------
// Dimagi brand palette
// ---------------------------------------------------------------------------

export const FONT_FAMILY = 'Work Sans';
export type RgbColor = { red: number; green: number; blue: number };

export const COLOR_INDIGO = { red: 0x13 / 255, green: 0x01 / 255, blue: 0x68 / 255 };
export const COLOR_WHITE = { red: 1, green: 1, blue: 1 };
export const COLOR_GRAY = { red: 0x5F / 255, green: 0x6A / 255, blue: 0x7D / 255 };

// ---------------------------------------------------------------------------
// Text-box request helper
// ---------------------------------------------------------------------------

export interface TextBox {
  id: string;
  pageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  bold?: boolean;
  color?: RgbColor;
}

export function textBoxRequests(tb: TextBox): Record<string, unknown>[] {
  const style: Record<string, unknown> = {
    fontSize: { magnitude: tb.fontSize, unit: 'PT' },
    fontFamily: FONT_FAMILY,
  };
  const fields = ['fontSize', 'fontFamily'];
  if (tb.bold) {
    style.bold = true;
    fields.push('bold');
  }
  if (tb.color) {
    style.foregroundColor = { opaqueColor: { rgbColor: tb.color } };
    fields.push('foregroundColor');
  }
  return [
    {
      createShape: {
        objectId: tb.id,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: tb.pageId,
          size: {
            height: { magnitude: tb.h, unit: 'EMU' },
            width: { magnitude: tb.w, unit: 'EMU' },
          },
          transform: { scaleX: 1, scaleY: 1, translateX: tb.x, translateY: tb.y, unit: 'EMU' },
        },
      },
    },
    { insertText: { objectId: tb.id, text: tb.text, insertionIndex: 0 } },
    { updateTextStyle: { objectId: tb.id, textRange: { type: 'ALL' }, style, fields: fields.join(',') } },
  ];
}

// ---------------------------------------------------------------------------
// Per-stencil text-box builders (geometry carried over from v3.4 where
// it proved publishable). Colors picked to read against the Dimagi
// background each stencil clones.
// ---------------------------------------------------------------------------

export function buildCoverTextBoxes(pageId: string): Record<string, unknown>[] {
  // Dark indigo background → white title + white subtitle/date.
  // Title font drops 40pt → 32pt (v5.3 fix) so longer opp names like
  // "Bednet Spot-Check (E2E Smoke)" fit on one line without wrapping
  // mid-word past the topographic illustration on the right.
  const w = SLIDE_W - MARGIN * 2 - 200_000;
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: 1_500_000, w, h: 1_400_000,
      fontSize: 32, bold: true, color: COLOR_WHITE,
    }),
    ...textBoxRequests({
      id: `${pageId}_subtitle`, pageId, text: '{{SUBTITLE}}',
      x: MARGIN, y: 3_100_000, w, h: 600_000,
      fontSize: 18, color: COLOR_WHITE,
    }),
    ...textBoxRequests({
      id: `${pageId}_date`, pageId, text: '{{DATE}}',
      x: MARGIN, y: 3_800_000, w, h: 500_000,
      fontSize: 14, color: COLOR_WHITE,
    }),
  ];
}

export function buildSectionTextBoxes(pageId: string): Record<string, unknown>[] {
  // Light-indigo background → white title, vertically centered.
  const titleH = 1_200_000;
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: (SLIDE_H - titleH) / 2, w: SLIDE_W - MARGIN * 2, h: titleH,
      fontSize: 38, bold: true, color: COLOR_WHITE,
    }),
  ];
}

export function buildAgendaTextBoxes(pageId: string): Record<string, unknown>[] {
  // Body font bumped 14pt → 16pt (v5.3) so agenda items read large.
  // Bullet markers (•) are added by lib/training-deck-spec.ts on the
  // agenda body string — see the `case 'agenda'` branch.
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_body`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_200_000, w: SLIDE_W - MARGIN * 2, h: 3_500_000,
      fontSize: 16, color: COLOR_GRAY,
    }),
  ];
}

export function buildContentTextBoxes(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_body`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_200_000, w: SLIDE_W - MARGIN * 2, h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

export function buildWalkthroughTextBoxes(pageId: string): Record<string, unknown>[] {
  // v5.3: widen left col 35% → 45% so body text doesn't wrap every
  // 5-7 words. Image area on the right correspondingly shrinks 62% →
  // 52%, but phone screenshots preserve aspect ratio so the rendered
  // image still fits within the new image zone.
  const leftW = Math.round(SLIDE_W * 0.45) - MARGIN;
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: leftW, h: 1_000_000,
      fontSize: 22, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_body`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_500_000, w: leftW, h: 3_400_000,
      fontSize: 13, color: COLOR_GRAY,
    }),
  ];
}

export function buildMobileFlowTextBoxes(pageId: string): Record<string, unknown>[] {
  const captionW = Math.round((SLIDE_W - MARGIN * 2) / 4);
  const captionY = SLIDE_H - 700_000;
  const reqs: Record<string, unknown>[] = [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
  ];
  for (let i = 0; i < 4; i++) {
    reqs.push(...textBoxRequests({
      id: `${pageId}_cap${i}`, pageId, text: `{{STEP_${i}_CAPTION}}`,
      x: MARGIN + i * captionW, y: captionY,
      w: captionW - 50_000, h: 500_000,
      fontSize: 11, color: COLOR_GRAY,
    }));
  }
  return reqs;
}

export function buildWebScreenTextBoxes(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_caption`, pageId, text: '{{CAPTION}}',
      x: MARGIN, y: SLIDE_H - 600_000, w: SLIDE_W - MARGIN * 2, h: 500_000,
      fontSize: 12, color: COLOR_GRAY,
    }),
  ];
}

export function buildMobileZoomTextBoxes(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_callouts`, pageId, text: '{{CALLOUTS}}',
      x: MARGIN, y: 1_200_000, w: Math.round(SLIDE_W * 0.4), h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

export function buildTwoColumnTextBoxes(pageId: string): Record<string, unknown>[] {
  const colW = Math.round((SLIDE_W - MARGIN * 3) / 2);
  const rightX = MARGIN * 2 + colW;
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_lhead`, pageId, text: '{{LEFT_HEADING}}',
      x: MARGIN, y: 1_300_000, w: colW, h: 500_000,
      fontSize: 16, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_lbody`, pageId, text: '{{LEFT_BODY}}',
      x: MARGIN, y: 1_800_000, w: colW, h: 3_000_000,
      fontSize: 13, color: COLOR_GRAY,
    }),
    ...textBoxRequests({
      id: `${pageId}_rhead`, pageId, text: '{{RIGHT_HEADING}}',
      x: rightX, y: 1_300_000, w: colW, h: 500_000,
      fontSize: 16, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_rbody`, pageId, text: '{{RIGHT_BODY}}',
      x: rightX, y: 1_800_000, w: colW, h: 3_000_000,
      fontSize: 13, color: COLOR_GRAY,
    }),
  ];
}

export function buildStatsTextBoxes(pageId: string): Record<string, unknown>[] {
  // v5.3: vertically center the stat numbers + labels within the canvas
  // below the title (previously stats clustered in upper half, leaving
  // ~50% dead space at the bottom). Numbers y 1.9M → 2.4M; labels
  // y 3.0M → 3.6M. Net: stats sit centered between title bottom (1.2in)
  // and slide bottom (5.625in).
  const colW = Math.round((SLIDE_W - MARGIN * 2) / 3);
  const reqs: Record<string, unknown>[] = [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
  ];
  for (let i = 1; i <= 3; i++) {
    const x = MARGIN + (i - 1) * colW;
    reqs.push(...textBoxRequests({
      id: `${pageId}_stat${i}`, pageId, text: `{{STAT${i}}}`,
      x, y: 2_400_000, w: colW - 100_000, h: 900_000,
      // 24pt fits "USD 1.50-3.00" (13 chars) on one line at ~3in column.
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }));
    reqs.push(...textBoxRequests({
      id: `${pageId}_stat${i}_label`, pageId, text: `{{STAT${i}_LABEL}}`,
      x, y: 3_600_000, w: colW - 100_000, h: 900_000,
      fontSize: 13, color: COLOR_GRAY,
    }));
  }
  return reqs;
}

export function buildTimelineTextBoxes(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_body`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_200_000, w: SLIDE_W - MARGIN * 2, h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

export function buildChecklistTextBoxes(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_body`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_200_000, w: SLIDE_W - MARGIN * 2, h: 3_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

export function buildExerciseTextBoxes(pageId: string): Record<string, unknown>[] {
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2 - 1_800_000, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_duration`, pageId, text: '{{DURATION}}',
      x: SLIDE_W - MARGIN - 1_700_000, y: MARGIN + 100_000,
      w: 1_700_000, h: 500_000,
      fontSize: 14, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_body`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 1_500_000, w: SLIDE_W - MARGIN * 2, h: 3_200_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

export function buildClosingTextBoxes(pageId: string): Record<string, unknown>[] {
  // Closing source has topographic illustration on the right ~30%, so
  // text lives in the left ~65%.
  const leftW = Math.round(SLIDE_W * 0.65) - MARGIN;
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: 1_200_000, w: leftW, h: 900_000,
      fontSize: 32, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_body`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 2_300_000, w: leftW, h: 2_500_000,
      fontSize: 14, color: COLOR_GRAY,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Decorative clone-leftover detection
// ---------------------------------------------------------------------------

/**
 * 12pt in EMU — an ELLIPSE rendered at-or-under this in BOTH dimensions
 * is a decorative dot, never content.
 */
export const DECORATIVE_LEFTOVER_MAX_EMU = 152_400;

/** Minimal Slides pageElement shape the predicate inspects. */
export interface PageElementLike {
  objectId?: string | null;
  size?: {
    width?: { magnitude?: number | null } | null;
    height?: { magnitude?: number | null } | null;
  } | null;
  transform?: { scaleX?: number | null; scaleY?: number | null } | null;
  shape?: { shapeType?: string | null; text?: unknown } | null;
  image?: unknown;
}

/**
 * True for shapes that are decorative clone-leftovers from a Dimagi
 * source slide: shapeType ELLIPSE rendered ≤ 12pt in BOTH dimensions
 * (rendered = declared size × transform scale). The motivating instance:
 * a 6×6pt ellipse at ~(292pt, 110pt) cloned from the Dimagi walkthrough
 * source page (shared by mobile_zoom) — it survived the bootstrap's
 * text/image strips (too small for the image threshold, not a text
 * shape) and self-propagated through in-place re-renders as a stray
 * blue dot on every walkthrough-derived slide. Deliberately narrow:
 * never matches the accent-bar RECTANGLEs, the logo IMAGE (no `shape`),
 * or any TEXT_BOX.
 */
export function isDecorativeLeftover(el: PageElementLike): boolean {
  if (!el.shape || el.shape.shapeType !== 'ELLIPSE') return false;
  const w = (el.size?.width?.magnitude ?? 0) * (el.transform?.scaleX ?? 1);
  const h = (el.size?.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1);
  if (w <= 0 || h <= 0) return false; // size unknown — can't confirm; leave it
  return w <= DECORATIVE_LEFTOVER_MAX_EMU && h <= DECORATIVE_LEFTOVER_MAX_EMU;
}

export const STENCIL_TEXT_BUILDERS: Record<StencilKey, (pageId: string) => Array<Record<string, unknown>>> = {
  cover: buildCoverTextBoxes,
  section: buildSectionTextBoxes,
  agenda: buildAgendaTextBoxes,
  content: buildContentTextBoxes,
  walkthrough: buildWalkthroughTextBoxes,
  mobile_flow: buildMobileFlowTextBoxes,
  web_screen: buildWebScreenTextBoxes,
  mobile_zoom: buildMobileZoomTextBoxes,
  two_column: buildTwoColumnTextBoxes,
  stats: buildStatsTextBoxes,
  timeline: buildTimelineTextBoxes,
  checklist: buildChecklistTextBoxes,
  exercise: buildExerciseTextBoxes,
  closing: buildClosingTextBoxes,
};
