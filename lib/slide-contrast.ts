/**
 * Is a stencil's text legible on the panel it is drawn over?
 *
 * Why this exists (dimagi-internal/ace#1305): every `two_column` deck slide
 * shipped with an illegible right-hand column — navy heading and grey body
 * over the template's DARK2 navy panel, with both headings additionally
 * sliced by the panel's top edge. Live on
 * spark-facilitator/20260813-2126 slide 30.
 *
 * The render was otherwise clean — 48/48 slides, 337/337 batchUpdate replies,
 * 21/21 images bound, zero token leaks, `visual_coverage.ratio 1.0` — and the
 * spec authored plain text for both columns. Neither the spec author nor
 * `training-deck-generate` could have avoided it, because the collision is
 * between two facts that live in different places:
 *
 *  1. the SOURCE TEMPLATE slide draws a light-grey panel on the left and a
 *     `themeColor: DARK2` navy panel on the right, both at `y=1_522_275`;
 *  2. `buildTwoColumnTextBoxes` gave BOTH columns the light-panel colours.
 *
 * The issue asked for the generalization rather than the instance — "no
 * stencil emits text whose colour fails contrast against the panel it sits
 * on" — so the panel backdrop is DECLARED here per stencil and a single test
 * walks it. Adding a panel-backed stencil means adding a row.
 *
 * ## Tone, not an invented RGB
 *
 * What the template observation established is that the right panel is DARK2
 * navy — not its exact channel values. Light text clears any dark panel and
 * dark text clears any light one, so `isLegibleOn` takes a TONE. Guessing
 * DARK2's RGB in order to compute a precise ratio would be inventing a number
 * another system owns; `contrastRatio` is exported for the case where a panel
 * colour has actually been measured.
 */

/** A Slides API `rgbColor` — channels in 0..1, missing channel means 0. */
export interface RgbColor {
  red?: number;
  green?: number;
  blue?: number;
}

/** How dark the backdrop a text box sits on is. */
export type PanelTone = 'light' | 'dark';

function channel(c: number | undefined): number {
  const v = Math.min(1, Math.max(0, c ?? 0));
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(c: RgbColor): number {
  return 0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue);
}

/** WCAG contrast ratio between two colours, 1..21. Order-independent. */
export function contrastRatio(a: RgbColor, b: RgbColor): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Thresholds picked so the two colours that caused #1305 fail and the fix
 * passes, with room either side: COLOR_GRAY (#5F6A7D) has luminance ~0.15 and
 * COLOR_INDIGO (#130168) ~0.02, both far below `LIGHT_TEXT_MIN`.
 */
export const LIGHT_TEXT_MIN = 0.6;
export const DARK_TEXT_MAX = 0.4;

/** Would this text colour read on a panel of this tone? */
export function isLegibleOn(color: RgbColor | undefined, tone: PanelTone): boolean {
  if (!color) return false;
  const l = relativeLuminance(color);
  return tone === 'dark' ? l >= LIGHT_TEXT_MIN : l <= DARK_TEXT_MAX;
}

export interface StencilPanelSpec {
  /** The stencil's request builder, so the test drives the real code path. */
  build: (pageId: string) => Record<string, unknown>[];
  /**
   * Top edge of the panels in the source template slide, in EMU. Any text box
   * placed above this straddles the panel edge and gets sliced.
   */
  panelTopY: number;
  /** Text-box id suffix → the tone of the panel behind it. */
  boxes: Record<string, PanelTone>;
}

// Imported lazily at module scope: the geometry module has no dependency on
// this one, so there is no cycle.
import { buildTwoColumnTextBoxes } from './training-deck-stencil-geometry.js';

/**
 * Panel-backed stencils. Observed from the source Dimagi template slides —
 * the `two_column` row records a light-grey left panel and a DARK2 navy right
 * panel, both starting at y=1_522_275.
 *
 * Stencils that draw text straight onto the slide background are deliberately
 * absent: there is no panel to contrast against, and listing them with a
 * guessed tone would be the invented-number failure this module avoids.
 */
export const STENCIL_PANELS: Record<string, StencilPanelSpec> = {
  two_column: {
    build: buildTwoColumnTextBoxes,
    panelTopY: 1_522_275,
    boxes: {
      lhead: 'light',
      lbody: 'light',
      rhead: 'dark',
      rbody: 'dark',
    },
  },
};
