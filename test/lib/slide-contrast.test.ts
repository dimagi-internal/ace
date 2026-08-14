/**
 * dimagi-internal/ace#1305 — every `two_column` deck slide shipped with an
 * illegible right-hand column: navy heading and grey body drawn on the
 * template's DARK2 navy panel, with both headings additionally sliced by the
 * panel's top edge.
 *
 * Live instance: spark-facilitator/20260813-2126, slide 30 ("Paid and Not
 * Paid"). The render itself was clean — 48/48 slides, 337/337 batchUpdate
 * replies, 21/21 images bound, zero token leaks, visual_coverage 1.0 — and the
 * spec authored plain text for both columns. There was no way for a spec
 * author or `training-deck-generate` to avoid it.
 *
 * Two facts collide, and neither is visible from the spec:
 *
 *  1. The source Dimagi template slide behind the stencil draws TWO panels: a
 *     light-grey rectangle on the left (fill rgb(0.95,0.95,0.95)) and a
 *     themeColor: DARK2 navy rectangle on the right, both at y=1_522_275.
 *  2. `buildTwoColumnTextBoxes` gave BOTH columns the light-panel colours —
 *     COLOR_INDIGO heading, COLOR_GRAY body.
 *
 * Secondary, both columns: the heading boxes sat at y=1_300_000 while the
 * panels start at y=1_522_275, so each heading straddled the panel edge.
 *
 * The issue asked for the generalization rather than the instance: "no stencil
 * emits text whose colour fails contrast against the panel it sits on". Hence
 * a declared panel map plus a walk over it, not two patched literals.
 *
 * Note the panel TONE is declared, not an invented RGB. What the template
 * observation established is that the right panel is DARK2 navy — light text
 * clears any dark panel, so the check does not need a colour nobody measured.
 */
import { describe, it, expect } from 'vitest';
import {
  relativeLuminance,
  contrastRatio,
  isLegibleOn,
  STENCIL_PANELS,
} from '../../lib/slide-contrast.js';
import {
  buildTwoColumnTextBoxes,
  COLOR_INDIGO,
  COLOR_WHITE,
  COLOR_GRAY,
} from '../../lib/training-deck-stencil-geometry.js';

/** Pull {id, y, color} out of the request stream a stencil builder emits. */
function boxes(requests: Record<string, unknown>[]) {
  const out: Record<string, { y?: number; color?: any }> = {};
  for (const r of requests) {
    const create = (r as any).createShape;
    if (create?.objectId) {
      out[create.objectId] ??= {};
      out[create.objectId].y = create.elementProperties?.transform?.translateY;
    }
    const style = (r as any).updateTextStyle;
    if (style?.objectId) {
      out[style.objectId] ??= {};
      out[style.objectId].color =
        style.style?.foregroundColor?.opaqueColor?.rgbColor ?? style.style?.foregroundColor;
    }
  }
  return out;
}

describe('contrast primitives', () => {
  it('orders luminance the way WCAG does', () => {
    expect(relativeLuminance(COLOR_WHITE)).toBeGreaterThan(relativeLuminance(COLOR_GRAY));
    expect(relativeLuminance(COLOR_GRAY)).toBeGreaterThan(relativeLuminance(COLOR_INDIGO));
  });

  it('scores white-on-navy far above navy-on-navy', () => {
    const navy = COLOR_INDIGO;
    expect(contrastRatio(COLOR_WHITE, navy)).toBeGreaterThan(4.5);
    expect(contrastRatio(COLOR_INDIGO, navy)).toBeLessThan(1.5);
  });

  it('isLegibleOn wants light text on a dark panel and dark text on a light one', () => {
    expect(isLegibleOn(COLOR_WHITE, 'dark')).toBe(true);
    expect(isLegibleOn(COLOR_INDIGO, 'dark')).toBe(false);
    expect(isLegibleOn(COLOR_GRAY, 'dark')).toBe(false);
    expect(isLegibleOn(COLOR_INDIGO, 'light')).toBe(true);
    expect(isLegibleOn(COLOR_WHITE, 'light')).toBe(false);
  });
});

describe('two_column stencil (#1305)', () => {
  const b = boxes(buildTwoColumnTextBoxes('p1'));

  it('draws the RIGHT column light — it sits on the DARK2 navy panel', () => {
    expect(isLegibleOn(b['p1_rhead'].color, 'dark'), 'right heading').toBe(true);
    expect(isLegibleOn(b['p1_rbody'].color, 'dark'), 'right body').toBe(true);
  });

  it('leaves the LEFT column dark — it sits on the light-grey panel', () => {
    expect(isLegibleOn(b['p1_lhead'].color, 'light'), 'left heading').toBe(true);
    expect(isLegibleOn(b['p1_lbody'].color, 'light'), 'left body').toBe(true);
  });

  it('keeps every heading INSIDE its panel instead of across the top edge', () => {
    const panelTop = STENCIL_PANELS.two_column.panelTopY;
    expect(b['p1_lhead'].y).toBeGreaterThanOrEqual(panelTop);
    expect(b['p1_rhead'].y).toBeGreaterThanOrEqual(panelTop);
  });

  it('keeps the body below its own heading', () => {
    expect(b['p1_lbody'].y!).toBeGreaterThan(b['p1_lhead'].y!);
    expect(b['p1_rbody'].y!).toBeGreaterThan(b['p1_rhead'].y!);
  });
});

describe('the class, not the instance (#1305)', () => {
  it('every declared panel-backed text box is legible on the panel it sits on', () => {
    const failures: string[] = [];
    for (const [stencil, spec] of Object.entries(STENCIL_PANELS)) {
      const b = boxes(spec.build(`${stencil}_pg`));
      for (const [suffix, tone] of Object.entries(spec.boxes)) {
        const id = `${stencil}_pg_${suffix}`;
        const box = b[id];
        if (!box?.color) { failures.push(`${id}: no colour emitted`); continue; }
        if (!isLegibleOn(box.color, tone)) failures.push(`${id}: illegible on a ${tone} panel`);
        if (box.y !== undefined && box.y < spec.panelTopY) {
          failures.push(`${id}: y=${box.y} is above panelTopY=${spec.panelTopY} — it will be sliced`);
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
