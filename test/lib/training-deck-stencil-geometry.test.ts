import { describe, it, expect } from 'vitest';
import {
  isDecorativeLeftover,
  DECORATIVE_LEFTOVER_MAX_EMU,
  type PageElementLike,
} from '../../lib/training-deck-stencil-geometry.js';

const PT = 12_700; // 1pt in EMU

function shapeEl(
  shapeType: string,
  wPt: number,
  hPt: number,
  scale: { x: number; y: number } = { x: 1, y: 1 },
): PageElementLike {
  return {
    objectId: 'el_1',
    shape: { shapeType },
    size: { width: { magnitude: wPt * PT }, height: { magnitude: hPt * PT } },
    transform: { scaleX: scale.x, scaleY: scale.y },
  };
}

describe('isDecorativeLeftover', () => {
  it('matches the 6×6pt ellipse (the Dimagi walkthrough clone-leftover)', () => {
    expect(isDecorativeLeftover(shapeEl('ELLIPSE', 6, 6))).toBe(true);
  });

  it('matches a small ellipse whose rendered size comes from transform scale', () => {
    // declared 60×60pt but scaled to 6×6pt rendered
    expect(isDecorativeLeftover(shapeEl('ELLIPSE', 60, 60, { x: 0.1, y: 0.1 }))).toBe(true);
  });

  it('does NOT match a 6pt-wide × 405pt-tall RECTANGLE accent bar', () => {
    expect(isDecorativeLeftover(shapeEl('RECTANGLE', 6, 405))).toBe(false);
  });

  it('does NOT match a small RECTANGLE either (ellipse-only predicate)', () => {
    expect(isDecorativeLeftover(shapeEl('RECTANGLE', 6, 6))).toBe(false);
  });

  it('does NOT match a 32pt image (logo) — images have no shape', () => {
    const img: PageElementLike = {
      objectId: 'img_1',
      image: { contentUrl: 'https://example.com/logo.png' },
      size: { width: { magnitude: 32 * PT }, height: { magnitude: 32 * PT } },
      transform: { scaleX: 1, scaleY: 1 },
    };
    expect(isDecorativeLeftover(img)).toBe(false);
  });

  it('does NOT match a small image even at 6×6pt', () => {
    const img: PageElementLike = {
      objectId: 'img_2',
      image: {},
      size: { width: { magnitude: 6 * PT }, height: { magnitude: 6 * PT } },
    };
    expect(isDecorativeLeftover(img)).toBe(false);
  });

  it('does NOT match a TEXT_BOX', () => {
    const tb = shapeEl('TEXT_BOX', 6, 6);
    (tb.shape as { text?: unknown }).text = { textElements: [] };
    expect(isDecorativeLeftover(tb)).toBe(false);
  });

  it('does NOT match a 6×6pt-declared ellipse whose transform scales it to 20pt', () => {
    const scale = 20 / 6;
    expect(isDecorativeLeftover(shapeEl('ELLIPSE', 6, 6, { x: scale, y: scale }))).toBe(false);
  });

  it('matches only when BOTH rendered dimensions are ≤ 12pt', () => {
    expect(isDecorativeLeftover(shapeEl('ELLIPSE', 12, 12))).toBe(true); // boundary
    expect(isDecorativeLeftover(shapeEl('ELLIPSE', 6, 20))).toBe(false);
    expect(isDecorativeLeftover(shapeEl('ELLIPSE', 20, 6))).toBe(false);
  });

  it('does NOT match when size is missing (cannot confirm it is small)', () => {
    const el: PageElementLike = { objectId: 'el_2', shape: { shapeType: 'ELLIPSE' } };
    expect(isDecorativeLeftover(el)).toBe(false);
  });

  it('exports the 12pt threshold in EMU', () => {
    expect(DECORATIVE_LEFTOVER_MAX_EMU).toBe(12 * PT);
  });
});
