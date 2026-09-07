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
/**
 * Body text on a DARK panel. Near-white rather than pure white so a paragraph
 * does not glare next to a white heading — still far above `LIGHT_TEXT_MIN`
 * (dimagi-internal/ace#1305).
 */
export const COLOR_LIGHT_GRAY = { red: 0xE6 / 255, green: 0xEA / 255, blue: 0xF2 / 255 };
/**
 * The Dimagi amber accent, read off the canonical deck's own accent bar
 * (`solidFill.rgbColor` on the left-edge RECTANGLE of page `g16117138c42_0_31`
 * and eight of its siblings) rather than eyeballed from a render.
 */
export const COLOR_AMBER = { red: 0.99607843, green: 0.6862745, blue: 0.19215687 };

// ---------------------------------------------------------------------------
// Image-placement geometry (consumed by the RENDER path, lib/training-deck-spec)
//
// These live here, beside the text-box builders, because an image and a text
// box on the same stencil must be laid out against each other. They used to be
// magic numbers inline in the render switch, which is how a phone screenshot
// came to be drawn straight over its own title and callouts (ace#2190).
// ---------------------------------------------------------------------------

/** Right edge of the `mobile_zoom` callouts column: MARGIN + 40% of the slide. */
export const MOBILE_ZOOM_CALLOUTS_RIGHT = MARGIN + Math.round(SLIDE_W * 0.4);

/** Bottom of the standard 24pt title band, shared by every titled stencil. */
export const TITLE_BAND_BOTTOM = MARGIN + 700_000;

/**
 * `mobile_zoom` phone frame — right column, below the title, source aspect.
 * A phone capture is ~1080x2400 (w/h ~= 0.45); the previous 0.686 stretched
 * every screenshot sideways.
 */
export const MOBILE_ZOOM_IMAGE = (() => {
  const left = MOBILE_ZOOM_CALLOUTS_RIGHT + 485_200; // gutter clear of callouts
  const top = TITLE_BAND_BOTTOM + 100_000;
  const h = SLIDE_H - MARGIN - top;
  const w = Math.round(h * 0.45);
  return { x: left + Math.round((SLIDE_W - MARGIN - left - w) / 2), y: top, w, h };
})();

/**
 * `mobile_flow` four-up band. `captionY` + `captionH` must land inside the
 * slide: captions previously began at SLIDE_H - 700_000 in a 500_000-tall box,
 * so a four-line caption ran off the bottom edge and was cut mid-word.
 */
export const MOBILE_FLOW = {
  phoneWidth: 1_828_800,
  phoneGap: 228_600,
  phoneHeight: 2_800_000,
  phoneY: 1_150_000,
  captionY: 4_030_000,
  captionH: 1_000_000,
} as const;

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
  /**
   * Vertical placement of the text WITHIN the box. Slides defaults to TOP,
   * which is why every body slide in the shipped deck packed its content into
   * the upper ~60% of the canvas and left the lower ~40% blank: the box
   * already spanned the full content area, but a six-line body simply hung
   * from its top edge.
   *
   * `MIDDLE` centres the block in the box, so a short body sits in the middle
   * of the canvas and a long one still fills it. Preferred over enlarging the
   * font, which trades dead space for overflow — Slides does not shrink text
   * to fit, so a body that outgrows its box just draws past the slide edge
   * (the ace#2190 sibling this suite already pins for `mobile_flow`).
   */
  contentAlignment?: 'TOP' | 'MIDDLE' | 'BOTTOM';
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
  const reqs: Record<string, unknown>[] = [
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
  if (tb.contentAlignment) {
    reqs.push({
      updateShapeProperties: {
        objectId: tb.id,
        shapeProperties: { contentAlignment: tb.contentAlignment },
        fields: 'contentAlignment',
      },
    });
  }
  return reqs;
}

// ---------------------------------------------------------------------------
// Filled-rectangle helper (chrome bars, stat rules, layout masks)
// ---------------------------------------------------------------------------

export interface FilledRect {
  id: string;
  pageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: RgbColor;
}

/** A borderless solid RECTANGLE — the primitive every drawn accent uses. */
export function filledRectRequests(r: FilledRect): Record<string, unknown>[] {
  return [
    {
      createShape: {
        objectId: r.id,
        shapeType: 'RECTANGLE',
        elementProperties: {
          pageObjectId: r.pageId,
          size: {
            height: { magnitude: r.h, unit: 'EMU' },
            width: { magnitude: r.w, unit: 'EMU' },
          },
          transform: { scaleX: 1, scaleY: 1, translateX: r.x, translateY: r.y, unit: 'EMU' },
        },
      },
    },
    {
      updateShapeProperties: {
        objectId: r.id,
        shapeProperties: {
          shapeBackgroundFill: { solidFill: { color: { rgbColor: r.color } } },
          outline: { propertyState: 'NOT_RENDERED' },
        },
        fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Body canvas
// ---------------------------------------------------------------------------

/** Top of the body canvas on every titled stencil (just under the title band). */
export const BODY_TOP = 1_200_000;
/** Bottom of the body canvas — the slide's own bottom margin, never past it. */
export const BODY_BOTTOM = SLIDE_H - MARGIN;
/** Height of a body box that spans the canvas exactly. */
export const BODY_H = BODY_BOTTOM - BODY_TOP;
/**
 * Base body size. 14pt left the canvas visibly under-filled at the paragraph
 * counts these decks actually carry; 16pt reads from the back of a room
 * without risking the overflow a larger jump would.
 */
export const BODY_PT = 16;

/**
 * Top of the title block on the two full-bleed dark stencils (`cover` and,
 * since the divider was re-sourced, `section`). Clears the source page's
 * dimagi wordmark, which spans y 1_372_350..1_652_625.
 */
export const COVER_TITLE_Y = 1_800_000;

/**
 * The `stats` row: an amber cap rule, the number under it, the label under
 * that. Placed so the block's ink is centred in the body canvas rather than
 * hanging from a fixed y — see `buildStatsTextBoxes`.
 */
export const STATS_ROW = {
  ruleY: 2_100_000,
  ruleW: 480_000,
  ruleH: 45_720,
  numberY: 2_180_000,
  labelY: 2_930_000,
} as const;

// ---------------------------------------------------------------------------
// Slide chrome — one treatment for every body stencil
// ---------------------------------------------------------------------------
//
// ## Why this is drawn rather than inherited
//
// Each stencil clones a DIFFERENT page of the Dimagi canonical deck, and the
// designer's pages do not agree with each other about the deck's own chrome.
// Measured on the source deck (2026-09-07) the three families are:
//
//   * white content pages (agenda, content, timeline, two_column, stats,
//     checklist, exercise) — amber left bar, indigo right rule, and a small
//     CIRCULAR dimagi "O" bug at 338_075 EMU square;
//   * mockup pages (walkthrough, mobile_flow, web_screen, mobile_zoom) —
//     the same two bars in PERIWINKLE, and a different, larger TOPO-CIRCLE
//     mark at 405_450 EMU square;
//   * `closing` — an amber bar parked at y=3_324_150 (it bracketed the
//     designer's "Thank You", which sits near the bottom; ACE's closing title
//     is at the top, so the bar floated unattached to anything) and no mark.
//
// On top of that, `stats` and `checklist` are masked with a full-slide white
// rectangle to hide layout-level panels, and the mask painted over whatever
// chrome those pages had — so two slides in every deck carried NO bar, NO
// rule and NO mark and read as belonging to a different deck entirely.
//
// A reader cannot see any of that as a source-page difference; they see one
// deck that changes its mind about its own furniture. So the chrome is
// STRIPPED from every body stencil (`classifyChrome` finds it) and redrawn
// from these constants, after any mask, identically everywhere.
//
// The geometry is the white-content family's, read off the source deck rather
// than eyeballed: the bar's RECTANGLE reports x=67_208 w=-68_400 (a negative
// scaleX flip) — i.e. a 68_400-wide bar flush to the left edge.

export const CHROME = {
  /** Left-edge accent bar, level with the title band. */
  accentBar: { x: 0, y: 175_775, w: 68_400, h: 708_000 },
  /** Full-height rule down the right edge. */
  rightRule: { x: SLIDE_W - 74_400, y: 0, w: 74_400, h: SLIDE_H },
  /** Top-right corner mark. */
  logo: { x: 8_636_748, y: 62_325, w: 338_075, h: 338_075 },
} as const;

/** The bar + rule. The corner mark is separate — it needs a harvested URL. */
export function chromeRequests(pageId: string): Record<string, unknown>[] {
  return [
    ...filledRectRequests({
      id: `${pageId}_chrome_bar`, pageId, color: COLOR_AMBER, ...CHROME.accentBar,
    }),
    ...filledRectRequests({
      id: `${pageId}_chrome_rule`, pageId, color: COLOR_INDIGO, ...CHROME.rightRule,
    }),
  ];
}

/**
 * The corner mark. `url` is the `contentUrl` harvested from the canonical
 * source page's own logo image — observing the mark the deck already uses
 * rather than guessing at a hosted Dimagi asset URL. Verified 2026-09-07:
 * the Slides API accepts a `lh7-rt.googleusercontent.com/slidesz/...`
 * contentUrl in `createImage` and copies the bytes into the presentation.
 */
export function chromeLogoRequest(pageId: string, url: string): Record<string, unknown> {
  return {
    createImage: {
      objectId: `${pageId}_chrome_logo`,
      elementProperties: {
        pageObjectId: pageId,
        size: {
          height: { magnitude: CHROME.logo.h, unit: 'EMU' },
          width: { magnitude: CHROME.logo.w, unit: 'EMU' },
        },
        transform: {
          scaleX: 1, scaleY: 1,
          translateX: CHROME.logo.x, translateY: CHROME.logo.y, unit: 'EMU',
        },
      },
      url,
    },
  };
}

/** A full-slide white rectangle, used to mask layout-level panels. */
export function layoutMaskRequests(pageId: string): Record<string, unknown>[] {
  return filledRectRequests({
    id: `${pageId}_layout_mask`, pageId,
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, color: COLOR_WHITE,
  });
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
  // The source page carries the dimagi wordmark as an image spanning
  // y 1_372_350..1_652_625. The title used to start at y=1_500_000, i.e.
  // INSIDE it, so the wordmark and the opp name collided at the top of every
  // deck. It now starts below the wordmark, which reads as a kicker above the
  // title, and the subtitle/date step down from there without the 200_000-EMU
  // overlap the old 1_400_000-tall title box had with the subtitle.
  const w = SLIDE_W - MARGIN * 2 - 200_000;
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: COVER_TITLE_Y, w, h: 1_050_000,
      fontSize: 32, bold: true, color: COLOR_WHITE,
    }),
    ...textBoxRequests({
      id: `${pageId}_subtitle`, pageId, text: '{{SUBTITLE}}',
      x: MARGIN, y: 2_980_000, w, h: 560_000,
      fontSize: 18, color: COLOR_WHITE,
    }),
    ...textBoxRequests({
      id: `${pageId}_date`, pageId, text: '{{DATE}}',
      x: MARGIN, y: 3_640_000, w, h: 460_000,
      fontSize: 14, color: COLOR_WHITE,
    }),
  ];
}

/**
 * Section dividers now clone the COVER source page (see `STENCIL_SOURCES`),
 * so the background is the dark indigo the white title was always written
 * for. It used to clone the light-periwinkle "Basic Layouts" divider, where
 * white 38pt title on rgb(0.53,0.60,0.96) measures ~2.3:1 — below WCAG AA for
 * ANY text size, and the first thing to wash out on a projector. That page
 * also carried a white LIGHT1 rectangle at x 0..102_000 / y 3_324_150 that
 * the eye read as a printing artefact at the left edge of all four dividers.
 *
 * `lib/slide-contrast.ts` declares the divider's backdrop as `dark` and its
 * test walks this builder, so a title colour that stops clearing the
 * background fails CI rather than shipping.
 */
export function buildSectionTextBoxes(pageId: string): Record<string, unknown>[] {
  // Dark indigo background → white title, sitting under the source page's
  // dimagi wordmark exactly as the cover's does.
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: COVER_TITLE_Y, w: SLIDE_W - MARGIN * 2 - 200_000, h: 1_400_000,
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
      x: MARGIN, y: BODY_TOP, w: SLIDE_W - MARGIN * 2, h: BODY_H,
      fontSize: BODY_PT, color: COLOR_GRAY, contentAlignment: 'MIDDLE',
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
      x: MARGIN, y: BODY_TOP, w: SLIDE_W - MARGIN * 2, h: BODY_H,
      fontSize: BODY_PT, color: COLOR_GRAY, contentAlignment: 'MIDDLE',
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
      x: MARGIN, y: 1_500_000, w: leftW, h: BODY_BOTTOM - 1_500_000,
      fontSize: 13, color: COLOR_GRAY, contentAlignment: 'MIDDLE',
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
      x: MARGIN, y: BODY_TOP, w: Math.round(SLIDE_W * 0.4), h: BODY_H,
      fontSize: 14, color: COLOR_GRAY, contentAlignment: 'MIDDLE',
    }),
  ];
}

/**
 * The source template slide behind this stencil draws TWO panels: a light-grey
 * rectangle on the left (`fill rgb(0.95,0.95,0.95)`) and a `themeColor: DARK2`
 * NAVY rectangle on the right — both starting at y=1_522_275.
 *
 * Until ace#1305 both columns got the light-panel colours, so every
 * `two_column` slide in every deck shipped with a navy-on-navy heading and
 * grey-on-navy body on the right, and both headings sat ABOVE the panel top
 * edge and were sliced. The render pipeline was not at fault — the spec
 * authored plain text and had no way to express the panel behind it.
 *
 * `PANEL_TOP_Y` and the per-column tones are declared in `lib/slide-contrast.ts`
 * (`STENCIL_PANELS`), and a test walks every panel-backed stencil asserting
 * legibility and that nothing straddles the edge.
 */
const PANEL_TOP_Y = 1_522_275;

export function buildTwoColumnTextBoxes(pageId: string): Record<string, unknown>[] {
  const colW = Math.round((SLIDE_W - MARGIN * 3) / 2);
  const rightX = MARGIN * 2 + colW;
  const headY = PANEL_TOP_Y + 120_000;   // inside the panel, not across its edge
  const bodyY = headY + 560_000;
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: MARGIN, w: SLIDE_W - MARGIN * 2, h: 700_000,
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_lhead`, pageId, text: '{{LEFT_HEADING}}',
      x: MARGIN, y: headY, w: colW, h: 500_000,
      fontSize: 16, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_lbody`, pageId, text: '{{LEFT_BODY}}',
      x: MARGIN, y: bodyY, w: colW, h: 2_800_000,
      fontSize: 13, color: COLOR_GRAY,
    }),
    // RIGHT column sits on the DARK2 navy panel — light text, not the
    // light-panel palette.
    ...textBoxRequests({
      id: `${pageId}_rhead`, pageId, text: '{{RIGHT_HEADING}}',
      x: rightX, y: headY, w: colW, h: 500_000,
      fontSize: 16, bold: true, color: COLOR_WHITE,
    }),
    ...textBoxRequests({
      id: `${pageId}_rbody`, pageId, text: '{{RIGHT_BODY}}',
      x: rightX, y: bodyY, w: colW, h: 2_800_000,
      fontSize: 13, color: COLOR_LIGHT_GRAY,
    }),
  ];
}

/**
 * Three stat columns.
 *
 * Two things were wrong with the shipped version and they were the same
 * thing: the row had no structure of its own, so it inherited whatever
 * structure the CONTENT happened to have.
 *
 * 1. The numbers started at y=2_400_000 with the title band ending at
 *    1_157_200, leaving a 1.2M-EMU hole between the title and the row that
 *    read as a missing element rather than as space.
 * 2. Column weight tracked glyph count. "USD 3" beside a bare "0" — same
 *    font, same size, same colour — reads as two different emphases, because
 *    one column is five glyphs of ink and its neighbour is one. Nothing in
 *    the stencil said "these three are peers".
 *
 * Both are fixed structurally: an amber rule of identical width caps every
 * column, so each one has the same visual anchor whatever its number says,
 * and the whole block (rule → number → label) is placed to sit centred in
 * the canvas below the title rather than parked in its lower half.
 *
 * The rule is deliberately NOT sized to the number — a rule as wide as its
 * own text would re-introduce exactly the weight difference it is there to
 * remove.
 */
export function buildStatsTextBoxes(pageId: string): Record<string, unknown>[] {
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
    reqs.push(...filledRectRequests({
      id: `${pageId}_stat${i}_rule`, pageId,
      x, y: STATS_ROW.ruleY, w: STATS_ROW.ruleW, h: STATS_ROW.ruleH,
      color: COLOR_AMBER,
    }));
    reqs.push(...textBoxRequests({
      id: `${pageId}_stat${i}`, pageId, text: `{{STAT${i}}}`,
      x, y: STATS_ROW.numberY, w: colW - 100_000, h: 700_000,
      // 24pt fits "USD 1.50-3.00" (13 chars) on one line at ~3in column.
      fontSize: 24, bold: true, color: COLOR_INDIGO,
    }));
    reqs.push(...textBoxRequests({
      id: `${pageId}_stat${i}_label`, pageId, text: `{{STAT${i}_LABEL}}`,
      x, y: STATS_ROW.labelY, w: colW - 100_000, h: 1_100_000,
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
      x: MARGIN, y: BODY_TOP, w: SLIDE_W - MARGIN * 2, h: BODY_H,
      fontSize: BODY_PT, color: COLOR_GRAY, contentAlignment: 'MIDDLE',
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
      x: MARGIN, y: BODY_TOP, w: SLIDE_W - MARGIN * 2, h: BODY_H,
      fontSize: BODY_PT, color: COLOR_GRAY, contentAlignment: 'MIDDLE',
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
      x: MARGIN, y: 1_500_000, w: SLIDE_W - MARGIN * 2, h: BODY_BOTTOM - 1_500_000,
      fontSize: BODY_PT, color: COLOR_GRAY, contentAlignment: 'MIDDLE',
    }),
  ];
}

export function buildClosingTextBoxes(pageId: string): Record<string, unknown>[] {
  // Closing source has topographic illustration on the right ~30%, so
  // text lives in the left ~65%.
  // Title pulled up to sit directly under the uniform accent bar (which ends
  // at y=883_775) instead of floating 300_000 EMU below it.
  const leftW = Math.round(SLIDE_W * 0.65) - MARGIN;
  return [
    ...textBoxRequests({
      id: `${pageId}_title`, pageId, text: '{{TITLE}}',
      x: MARGIN, y: 1_000_000, w: leftW, h: 950_000,
      fontSize: 32, bold: true, color: COLOR_INDIGO,
    }),
    ...textBoxRequests({
      id: `${pageId}_body`, pageId, text: '{{BODY}}',
      x: MARGIN, y: 2_100_000, w: leftW, h: BODY_BOTTOM - 2_100_000,
      fontSize: BODY_PT, color: COLOR_GRAY, contentAlignment: 'MIDDLE',
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

/** Minimal Slides pageElement shape the predicates inspect. */
export interface PageElementLike {
  objectId?: string | null;
  size?: {
    width?: { magnitude?: number | null } | null;
    height?: { magnitude?: number | null } | null;
  } | null;
  transform?: {
    scaleX?: number | null;
    scaleY?: number | null;
    translateX?: number | null;
    translateY?: number | null;
  } | null;
  shape?: { shapeType?: string | null; text?: unknown } | null;
  image?: { contentUrl?: string | null } | unknown;
  line?: unknown;
}

/**
 * Rendered bounds of a page element, normalised for a flipped transform.
 *
 * Slides reports width as `size.width x transform.scaleX`, and the canonical
 * deck's own accent bars carry a NEGATIVE scaleX — the left bar reads
 * `x=67_208 w=-68_400`. Read naively that is a zero-area element off the left
 * of the slide; read correctly it is a 68_400-wide bar flush to the edge. Any
 * positional predicate has to normalise or it silently matches nothing.
 */
export function elementBounds(el: PageElementLike): {
  left: number; right: number; top: number; bottom: number; w: number; h: number;
} {
  const w = (el.size?.width?.magnitude ?? 0) * (el.transform?.scaleX ?? 1);
  const h = (el.size?.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1);
  const x = el.transform?.translateX ?? 0;
  const y = el.transform?.translateY ?? 0;
  return {
    left: Math.min(x, x + w), right: Math.max(x, x + w),
    top: Math.min(y, y + h), bottom: Math.max(y, y + h),
    w: Math.abs(w), h: Math.abs(h),
  };
}

/** The three chrome roles a cloned source page can contribute. */
export type ChromeRole = 'accent_bar' | 'right_rule' | 'corner_logo';

/**
 * Which piece of deck furniture — if any — a cloned page element is.
 *
 * Positional, not id-based: the same role appears at the same place on every
 * Dimagi source page, but in three different colours and two different marks
 * (see the CHROME block above). Matching on position is what lets one rule
 * find all of them so they can be replaced by one treatment.
 *
 * Deliberately narrow. The two_column panels (4_059_600 wide), the checklist
 * grey panel (3_092_400 wide), the exercise header bars (8_315_400 wide) and
 * the stats half-panel are all far too wide for the bar/rule tests, and the
 * mockup screenshots are far too large and too far from the corner for the
 * logo test — none of them are chrome and none of them match.
 */
export function classifyChrome(el: PageElementLike): ChromeRole | null {
  const b = elementBounds(el);
  if (b.w <= 0 || b.h <= 0) return null;

  const isImage = Boolean((el as { image?: unknown }).image);
  if (isImage) {
    const inCorner = b.right >= SLIDE_W * 0.9 && b.top <= SLIDE_H * 0.12;
    const markSized = b.w <= SLIDE_W * 0.08 && b.h <= SLIDE_H * 0.15;
    return inCorner && markSized ? 'corner_logo' : null;
  }

  if (el.shape?.shapeType !== 'RECTANGLE') return null;
  const thin = b.w <= SLIDE_W * 0.03;
  if (!thin) return null;
  if (b.left <= SLIDE_W * 0.02 && b.h <= SLIDE_H * 0.3) return 'accent_bar';
  if (b.left >= SLIDE_W * 0.95 && b.h >= SLIDE_H * 0.9) return 'right_rule';
  return null;
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
 *
 * **Connector guard.** A small ellipse is NOT a leftover when its slide
 * also contains a LINE element: that's a functional diagram node (the
 * `timeline` stencil draws its 4 node dots on connector lines + segment
 * bars — 7×7pt ellipses that a size-only rule would wrongly strip). Pass
 * `slideElements` (the ellipse's sibling page elements) so the predicate
 * can spare connector-anchored dots. Omitting it falls back to size-only
 * — safe only when the caller already knows the slide has no diagram.
 */
export function isDecorativeLeftover(
  el: PageElementLike,
  slideElements?: PageElementLike[],
): boolean {
  if (!el.shape || el.shape.shapeType !== 'ELLIPSE') return false;
  const w = (el.size?.width?.magnitude ?? 0) * (el.transform?.scaleX ?? 1);
  const h = (el.size?.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1);
  if (w <= 0 || h <= 0) return false; // size unknown — can't confirm; leave it
  if (w > DECORATIVE_LEFTOVER_MAX_EMU || h > DECORATIVE_LEFTOVER_MAX_EMU) return false;
  // Connector-anchored dots (timeline nodes) are functional, not leftovers.
  if (slideElements?.some((s) => s !== el && s.line)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Template source map — which Dimagi page each stencil clones, and what gets
// stripped from it. Lives here, beside the geometry it has to agree with,
// because the two are one decision: `section` reading white-on-periwinkle and
// `timeline` carrying decoration for a list it does not draw are both
// source-page choices, not text-box choices.
// ---------------------------------------------------------------------------

export interface StencilSource {
  /** The Dimagi page duplicated for its visual background + decoration. */
  sourcePageId: string;
  /** True when the source is a dark full-bleed page (white text). */
  onDarkBackground?: boolean;
  /** True when another stencil clones the SAME source page. */
  sourceIsShared?: boolean;
}

/**
 * Surveyed 2026-05-25; `section` re-pointed 2026-09-07.
 *
 *   cover        <- page 3   "Sample Heading / Subheading"  (dark indigo)
 *   section      <- page 3   (clone of cover — was page 6's light-periwinkle
 *                            "Basic Layouts" divider, which put white 38pt
 *                            text at ~2.3:1 and carried a stray white
 *                            rectangle at the left edge)
 *   agenda       <- page 5   "Table of contents"
 *   content      <- page 10  "Bulleted Plaintext with Image"
 *   walkthrough  <- page 46  "Solo Mobile UI mockup"
 *   mobile_flow  <- page 47  "Three mobile mockups"
 *   web_screen   <- page 48  "Solo Web Mockup"
 *   mobile_zoom  <- page 46  (clone of walkthrough)
 *   two_column   <- page 11  "Comparison"
 *   stats        <- page 34  "Stat+Description Combo"
 *   timeline     <- page 36  "Horizontal Timeline Basic"
 *   checklist    <- page 29  "5 numbered callouts"
 *   exercise     <- page 25  "Boxed Headers"
 *   closing      <- page 71  "Thank You"
 */
export const STENCIL_SOURCES: Record<StencilKey, StencilSource> = {
  cover: { sourcePageId: 'g15b43284eab_0_101', onDarkBackground: true },
  section: { sourcePageId: 'g15b43284eab_0_101', onDarkBackground: true, sourceIsShared: true },
  agenda: { sourcePageId: 'g16117138c42_0_41' },
  content: { sourcePageId: 'g16117138c42_0_31' },
  walkthrough: { sourcePageId: 'g157d905314c_0_17' },
  mobile_flow: { sourcePageId: 'g157c2e0650a_0_10' },
  web_screen: { sourcePageId: 'g157d905314c_0_41' },
  mobile_zoom: { sourcePageId: 'g157d905314c_0_17', sourceIsShared: true },
  two_column: { sourcePageId: 'g1b29c53f2a5_6_0' },
  stats: { sourcePageId: 'g1582f059303_0_125' },
  timeline: { sourcePageId: 'g19718957c31_0_0' },
  checklist: { sourcePageId: 'g1582f059303_0_110' },
  exercise: { sourcePageId: 'g19d7c017c36_0_773' },
  closing: { sourcePageId: 'g157d905314c_0_85' },
};

/**
 * Stencils that get ACE's own uniform chrome: inherited bar / rule / mark are
 * stripped and redrawn from `CHROME`. Everything except the two full-bleed
 * dark stencils, which share one source page and therefore already agree.
 */
export const UNIFORM_CHROME_ON: ReadonlySet<StencilKey> = new Set<StencilKey>([
  'agenda', 'content', 'walkthrough', 'mobile_flow', 'web_screen', 'mobile_zoom',
  'two_column', 'stats', 'timeline', 'checklist', 'exercise', 'closing',
]);

/**
 * Stencils masked with a full-slide white rectangle. `stats` and `checklist`
 * carry LAYOUT-level panels that a page-level strip cannot reach and that a
 * `pageBackgroundFill` override paints behind (v5.7 tried exactly that and it
 * was invisible). The mask is why those two slides used to ship with no
 * chrome at all — it painted over it. Chrome is now drawn AFTER the mask.
 */
export const MASK_LAYOUT_ON: ReadonlySet<StencilKey> = new Set<StencilKey>([
  'checklist', 'stats',
]);

/**
 * Stencils where every non-TEXT_BOX shape is decoration for a layout ACE does
 * not use: checklist's 5 amber bullet dots + grey panel, stats' half-panel,
 * and timeline's node/segment furniture (see `buildTimelineTextBoxes`).
 */
export const STRIP_DEC_SHAPES_ON: ReadonlySet<StencilKey> = new Set<StencilKey>([
  'checklist', 'stats', 'timeline',
]);

/** Stencils whose designer mockup images are replaced per-opp at render. */
export const STRIP_IMAGES_ON: ReadonlySet<StencilKey> = new Set<StencilKey>([
  'walkthrough', 'mobile_flow', 'web_screen', 'mobile_zoom', 'content', 'closing',
]);

/**
 * Stencils whose LINE elements are stripped: the mockup stencils (thin
 * callout connectors for mockups we removed) plus timeline (four connectors
 * to nodes that are also going).
 */
export const STRIP_LINES_ON: ReadonlySet<StencilKey> = new Set<StencilKey>([
  ...STRIP_IMAGES_ON, 'timeline',
]);

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
