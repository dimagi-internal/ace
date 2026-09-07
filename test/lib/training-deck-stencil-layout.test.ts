/**
 * Stencil LAYOUT regressions — the defects a reader sees in the rendered PDF
 * and no existing test could see.
 *
 * The suite that shipped before this one checks that the right TOKENS are
 * filled. That is why a deck could score 8.5 on its eval while, on the same
 * 24 slides:
 *
 *   - every text slide filled the top ~60% of the canvas and left the bottom
 *     ~40% blank, because a full-height body box hangs its text from the top;
 *   - the `timeline` stencil drew four unlabelled dots and an amber bar
 *     running off the right edge under a text list they had no relationship
 *     to — ACE renders a timeline as a LIST (ace#1503), so the decoration
 *     illustrated nothing and read as a rendering error;
 *   - the four section dividers were white text on light periwinkle (~2.3:1,
 *     below WCAG AA at any size) with a stray white rectangle at the left
 *     edge;
 *   - two different logo marks appeared across one deck, the left accent bar
 *     was amber on some slides and periwinkle on others, and `stats` and
 *     `checklist` had no bar, no rule and no mark at all;
 *   - the three `stats` columns had no structure of their own, so "USD 3"
 *     beside a bare "0" read as two different emphases.
 *
 * Every fixture below carrying real EMU numbers is VERBATIM from a
 * `presentations.get` against the Dimagi canonical deck
 * (1NAkbjPjDZSx_Qw8legfuRUk8eTBqO4dn1H2XOqAM1Hc) on 2026-09-07, including the
 * negative scaleX the accent bars actually carry — the trap that makes a
 * naive positional predicate match nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  SLIDE_W,
  SLIDE_H,
  MARGIN,
  BODY_TOP,
  BODY_BOTTOM,
  BODY_PT,
  COVER_TITLE_Y,
  STATS_ROW,
  CHROME,
  COLOR_AMBER,
  COLOR_INDIGO,
  COLOR_WHITE,
  TITLE_BAND_BOTTOM,
  classifyChrome,
  elementBounds,
  chromeRequests,
  chromeLogoRequest,
  layoutMaskRequests,
  buildCoverTextBoxes,
  buildSectionTextBoxes,
  buildStatsTextBoxes,
  buildTimelineTextBoxes,
  STENCIL_TEXT_BUILDERS,
  STENCIL_SOURCES,
  UNIFORM_CHROME_ON,
  MASK_LAYOUT_ON,
  STRIP_DEC_SHAPES_ON,
  STRIP_LINES_ON,
  type PageElementLike,
} from '../../lib/training-deck-stencil-geometry.js';
import { isLegibleOn } from '../../lib/slide-contrast.js';

// ---------------------------------------------------------------------------
// Request-stream readers
// ---------------------------------------------------------------------------

interface Box {
  id: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  shapeType?: string;
  fontSize?: number;
  color?: Record<string, number>;
  fill?: Record<string, number>;
  contentAlignment?: string;
  text?: string;
}

function readBoxes(requests: Array<Record<string, unknown>>): Record<string, Box> {
  const out: Record<string, Box> = {};
  const at = (id: string) => (out[id] ??= { id });
  for (const req of requests) {
    const cs = (req as any).createShape;
    if (cs?.objectId) {
      const b = at(cs.objectId);
      b.shapeType = cs.shapeType;
      b.x = cs.elementProperties?.transform?.translateX;
      b.y = cs.elementProperties?.transform?.translateY;
      b.w = cs.elementProperties?.size?.width?.magnitude;
      b.h = cs.elementProperties?.size?.height?.magnitude;
    }
    const ins = (req as any).insertText;
    if (ins?.objectId) at(ins.objectId).text = ins.text;
    const ts = (req as any).updateTextStyle;
    if (ts?.objectId) {
      const b = at(ts.objectId);
      b.fontSize = ts.style?.fontSize?.magnitude;
      b.color = ts.style?.foregroundColor?.opaqueColor?.rgbColor;
    }
    const sp = (req as any).updateShapeProperties;
    if (sp?.objectId) {
      const b = at(sp.objectId);
      if (sp.shapeProperties?.contentAlignment) {
        b.contentAlignment = sp.shapeProperties.contentAlignment;
      }
      const fill = sp.shapeProperties?.shapeBackgroundFill?.solidFill?.color?.rgbColor;
      if (fill) b.fill = fill;
    }
    const ci = (req as any).createImage;
    if (ci?.objectId) {
      const b = at(ci.objectId);
      b.x = ci.elementProperties?.transform?.translateX;
      b.y = ci.elementProperties?.transform?.translateY;
      b.w = ci.elementProperties?.size?.width?.magnitude;
      b.h = ci.elementProperties?.size?.height?.magnitude;
    }
  }
  return out;
}

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// classifyChrome — against the real elements, not invented ones
// ---------------------------------------------------------------------------

/**
 * Build a page element the way the Slides API reports one. `w`/`h` here are
 * the RENDERED extents the API returns (size x scale); a negative value
 * reproduces the flipped transform the Dimagi accent bars carry.
 */
function el(
  kind: 'RECTANGLE' | 'ELLIPSE' | 'IMAGE' | 'LINE',
  x: number,
  y: number,
  w: number,
  h: number,
): PageElementLike {
  const base = {
    objectId: `el_${x}_${y}`,
    size: { width: { magnitude: Math.abs(w) }, height: { magnitude: Math.abs(h) } },
    transform: {
      scaleX: w < 0 ? -1 : 1,
      scaleY: h < 0 ? -1 : 1,
      translateX: x,
      translateY: y,
    },
  };
  if (kind === 'IMAGE') return { ...base, image: { contentUrl: 'https://example.test/x.png' } };
  if (kind === 'LINE') return { ...base, line: {} };
  return { ...base, shape: { shapeType: kind } };
}

describe('classifyChrome finds the deck furniture the source pages disagree about', () => {
  it('normalises the negative scaleX the real accent bars carry', () => {
    // Verbatim: the left bar reports x=67208 w=-68400. Read naively that is a
    // zero-area element off the left of the slide.
    const b = elementBounds(el('RECTANGLE', 67_208, 175_775, -68_400, 708_000));
    expect(b.left).toBe(-1_192);
    expect(b.right).toBe(67_208);
    expect(b.w).toBe(68_400);
  });

  const positives: Array<[string, PageElementLike, string]> = [
    // Same geometry, three different colours across the source deck — which
    // is exactly why the rule is positional rather than colour-based.
    ['amber left bar (content, agenda, timeline, …)', el('RECTANGLE', 67_208, 175_775, -68_400, 708_000), 'accent_bar'],
    ['periwinkle left bar (walkthrough, mobile_flow, web_screen)', el('RECTANGLE', 67_208, 175_775, -68_400, 708_000), 'accent_bar'],
    ['closing’s amber bar, parked mid-slide under the designer’s "Thank You"', el('RECTANGLE', 102_000, 3_324_150, -102_000, 1_173_600), 'accent_bar'],
    ['the stray white LIGHT1 rectangle on the old periwinkle divider', el('RECTANGLE', 102_000, 3_324_150, -102_000, 1_173_600), 'accent_bar'],
    ['indigo right rule', el('RECTANGLE', 9_145_199, 0, -74_400, 5_143_500), 'right_rule'],
    ['the circular dimagi "O" bug (338_075 square)', el('IMAGE', 8_636_748, 62_325, 338_075, 338_075), 'corner_logo'],
    ['the topo-circle mark (405_450 square) — the OTHER mark in the same deck', el('IMAGE', 8_569_364, 62_325, 405_450, 405_450), 'corner_logo'],
  ];

  for (const [name, element, role] of positives) {
    it(`classifies ${name} as ${role}`, () => {
      expect(classifyChrome(element)).toBe(role);
    });
  }

  const negatives: Array<[string, PageElementLike]> = [
    ['the two_column light-grey panel', el('RECTANGLE', 512_400, 1_522_275, 4_059_600, 2_514_000)],
    ['the two_column DARK2 navy panel', el('RECTANGLE', 4_572_000, 1_522_275, 4_059_600, 2_514_000)],
    ['the checklist grey half-panel', el('RECTANGLE', 0, 0, 3_092_400, 5_143_500)],
    ['the stats #fafafa half-panel', el('RECTANGLE', 4_541_475, 0, 4_592_400, 5_143_500)],
    ['an exercise boxed-header bar', el('RECTANGLE', 352_425, 1_133_475, 8_315_400, 219_000)],
    ['a checklist amber bullet dot', el('ELLIPSE', 3_699_400, 1_427_250, 357_300, 367_500)],
    ['a mobile_flow mockup screenshot', el('IMAGE', 478_350, 916_700, 2_271_200, 3_252_975)],
    ['the invisible 22_075-EMU artefact mid-slide', el('IMAGE', 6_860_625, 2_850, 22_075, 15_675)],
    ['a timeline connector line', el('LINE', 4_841_566, 2_809_393, 3_000_000, 359_400)],
  ];

  for (const [name, element] of negatives) {
    it(`leaves ${name} alone`, () => {
      expect(classifyChrome(element)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Chrome uniformity
// ---------------------------------------------------------------------------

describe('every slide wears the same furniture', () => {
  const ALL = Object.keys(STENCIL_TEXT_BUILDERS) as Array<keyof typeof STENCIL_TEXT_BUILDERS>;

  it('accounts for all 14 stencils: uniform chrome, or one of the two dark full-bleed pages', () => {
    // A stencil in neither set keeps whatever its source page happened to
    // carry — which is the defect, not an exemption from it.
    const unaccounted = ALL.filter(
      (k) => !UNIFORM_CHROME_ON.has(k) && k !== 'cover' && k !== 'section',
    );
    expect(unaccounted, `stencils with un-normalised chrome: ${unaccounted.join(', ')}`).toEqual([]);
  });

  it('gives cover and section ONE source page, so the two dark slides cannot drift apart', () => {
    expect(STENCIL_SOURCES.section.sourcePageId).toBe(STENCIL_SOURCES.cover.sourcePageId);
    expect(STENCIL_SOURCES.section.sourceIsShared).toBe(true);
  });

  it('emits identical bar + rule geometry and colour on every uniform stencil', () => {
    const seen = new Set<string>();
    for (const key of UNIFORM_CHROME_ON) {
      const b = readBoxes(chromeRequests(`p_${key}`));
      const bar = b[`p_${key}_chrome_bar`];
      const rule = b[`p_${key}_chrome_rule`];
      expect(bar, `${key}: no accent bar`).toBeDefined();
      expect(rule, `${key}: no right rule`).toBeDefined();
      expect(bar.fill).toEqual(COLOR_AMBER);
      expect(rule.fill).toEqual(COLOR_INDIGO);
      seen.add(JSON.stringify([bar.x, bar.y, bar.w, bar.h, rule.x, rule.y, rule.w, rule.h]));
    }
    expect(seen.size, 'chrome geometry differs between stencils').toBe(1);
  });

  it('puts the drawn chrome exactly where the source deck puts it', () => {
    // Not an invented corner: read off the canonical deck's own elements.
    const b = readBoxes(chromeRequests('p'));
    expect(b.p_chrome_bar.w).toBe(CHROME.accentBar.w);
    expect(b.p_chrome_bar.y).toBe(175_775);
    expect(b.p_chrome_rule.x! + b.p_chrome_rule.w!).toBe(SLIDE_W);
    expect(b.p_chrome_rule.h).toBe(SLIDE_H);
    const logo = readBoxes([chromeLogoRequest('p', 'https://example.test/logo.png')]).p_chrome_logo;
    expect(logo.x).toBe(8_636_748);
    expect(logo.w).toBe(logo.h); // the mark is square
    expect(logo.x! + logo.w!).toBeLessThanOrEqual(SLIDE_W);
  });

  it('never masks a stencil whose chrome is not redrawn afterwards', () => {
    // THE `stats` / `checklist` DEFECT. v5.8 painted a full-slide white
    // rectangle over layout panels — and over the inherited bar, rule and
    // mark with them — so two slides in every deck shipped bare. A mask is
    // only ever safe on a stencil that re-stamps its own chrome.
    for (const key of MASK_LAYOUT_ON) {
      expect(UNIFORM_CHROME_ON.has(key), `${key} is masked but draws no chrome`).toBe(true);
    }
  });

  it('masks the whole slide when it masks at all', () => {
    const m = readBoxes(layoutMaskRequests('p')).p_layout_mask;
    expect([m.x, m.y, m.w, m.h]).toEqual([0, 0, SLIDE_W, SLIDE_H]);
    expect(m.fill).toEqual(COLOR_WHITE);
  });
});

// ---------------------------------------------------------------------------
// Dead space
// ---------------------------------------------------------------------------

describe('body text uses the canvas instead of hanging from the top of it', () => {
  /** Stencils whose main text block is a free body over the slide canvas. */
  const BODY_STENCILS = [
    'agenda', 'content', 'timeline', 'checklist', 'exercise', 'walkthrough', 'closing',
  ] as const;

  for (const key of BODY_STENCILS) {
    it(`${key}: the body box is vertically centred and reaches the bottom margin`, () => {
      const b = readBoxes(STENCIL_TEXT_BUILDERS[key](`${key}_pg`))[`${key}_pg_body`];
      expect(b, `${key} emits no body box`).toBeDefined();
      expect(
        b.contentAlignment,
        `${key}: a top-aligned body leaves the lower canvas empty for any block ` +
          'shorter than the box — which is every slide in the shipped deck',
      ).toBe('MIDDLE');
      expect(
        b.y! + b.h!,
        `${key}: the body box stops short of the bottom margin, so centring ` +
          'centres it in the wrong region',
      ).toBe(BODY_BOTTOM);
    });
  }

  it('mobile_zoom centres its callouts column too', () => {
    const b = readBoxes(STENCIL_TEXT_BUILDERS.mobile_zoom('mz'))['mz_callouts'];
    expect(b.contentAlignment).toBe('MIDDLE');
    expect(b.y! + b.h!).toBe(BODY_BOTTOM);
  });

  it('raises the base body size without pushing any box off the slide', () => {
    expect(BODY_PT).toBeGreaterThan(14);
    for (const key of Object.keys(STENCIL_TEXT_BUILDERS) as Array<keyof typeof STENCIL_TEXT_BUILDERS>) {
      for (const b of Object.values(readBoxes(STENCIL_TEXT_BUILDERS[key](`${key}_pg`)))) {
        if (b.x === undefined) continue;
        expect(b.x!, `${b.id} starts left of the slide`).toBeGreaterThanOrEqual(0);
        expect(b.y!, `${b.id} starts above the slide`).toBeGreaterThanOrEqual(0);
        expect(b.x! + b.w!, `${b.id} runs off the right edge`).toBeLessThanOrEqual(SLIDE_W);
        expect(b.y! + b.h!, `${b.id} runs off the bottom edge`).toBeLessThanOrEqual(SLIDE_H);
      }
    }
  });

  it('starts the body canvas below the title band', () => {
    expect(BODY_TOP).toBeGreaterThanOrEqual(TITLE_BAND_BOTTOM);
    expect(BODY_BOTTOM).toBe(SLIDE_H - MARGIN);
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

describe('stats: three columns that read as peers', () => {
  const b = readBoxes(buildStatsTextBoxes('st'));
  const nums = [1, 2, 3].map((i) => b[`st_stat${i}`]);
  const labels = [1, 2, 3].map((i) => b[`st_stat${i}_label`]);
  const rules = [1, 2, 3].map((i) => b[`st_stat${i}_rule`]);

  it('caps every column with an identical amber rule', () => {
    // The weight fix. "USD 3" is five glyphs of ink and "0" is one; at the
    // same size, colour and weight the eye reads that as emphasis. A rule
    // that is the same width whatever the number says gives all three the
    // same anchor — so it must NOT be sized to its own text.
    for (const r of rules) {
      expect(r, 'a column has no cap rule').toBeDefined();
      expect(r.fill).toEqual(COLOR_AMBER);
      expect(r.w).toBe(STATS_ROW.ruleW);
      expect(r.h).toBe(STATS_ROW.ruleH);
      expect(r.y).toBe(STATS_ROW.ruleY);
    }
    expect(new Set(rules.map((r) => r.w)).size).toBe(1);
  });

  it('sets the three numbers on one baseline at one size', () => {
    expect(new Set(nums.map((n) => n.y)).size).toBe(1);
    expect(new Set(nums.map((n) => n.fontSize)).size).toBe(1);
    expect(new Set(nums.map((n) => n.w)).size).toBe(1);
    expect(new Set(labels.map((l) => l.y)).size).toBe(1);
  });

  it('spaces the columns evenly across the canvas', () => {
    const xs = nums.map((n) => n.x!).sort((p, q) => p - q);
    expect(xs[0]).toBe(MARGIN);
    expect(near(xs[1] - xs[0], xs[2] - xs[1], 2)).toBe(true);
  });

  it('seats the row in the canvas instead of parking it in the lower half', () => {
    // The shipped version put the numbers at y=2_400_000 with the title band
    // ending at 1_157_200 — a 1.24M-EMU hole that read as a missing element.
    const gap = STATS_ROW.ruleY - TITLE_BAND_BOTTOM;
    expect(gap, 'the title-to-row gap is back to reading as a hole').toBeLessThan(1_000_000);

    // A 13pt label runs to about three lines at this column width.
    const labelInk = Math.round(3 * 13 * 1.2 * 12_700);
    const blockTop = STATS_ROW.ruleY;
    const blockBottom = STATS_ROW.labelY + labelInk;
    const blockCentre = (blockTop + blockBottom) / 2;
    const canvasCentre = (TITLE_BAND_BOTTOM + BODY_BOTTOM) / 2;
    expect(Math.abs(blockCentre - canvasCentre)).toBeLessThan(400_000);
    expect(blockBottom).toBeLessThanOrEqual(BODY_BOTTOM);
  });
});

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

describe('timeline: a list, and only a list', () => {
  it('emits a title and a body and nothing else', () => {
    const ids = Object.keys(readBoxes(buildTimelineTextBoxes('tl'))).sort();
    expect(ids).toEqual(['tl_body', 'tl_title']);
  });

  it('strips the source page’s node dots, connectors and segment bars', () => {
    // ace#1503 settled that ACE renders a timeline as text. The decoration
    // that survived — four unlabelled dots and an amber bar running off the
    // right edge, floating under an unrelated list — is what a reader calls
    // a rendering error.
    expect(STRIP_DEC_SHAPES_ON.has('timeline')).toBe(true);
    expect(STRIP_LINES_ON.has('timeline')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cover + section
// ---------------------------------------------------------------------------

describe('the two dark full-bleed stencils', () => {
  /**
   * The dimagi wordmark on the source page, verbatim: an IMAGE at
   * x=515_300 y=1_372_350 w=876_298 h=280_275.
   */
  const WORDMARK_BOTTOM = 1_372_350 + 280_275;

  it('cover: the title clears the wordmark instead of colliding with it', () => {
    const b = readBoxes(buildCoverTextBoxes('cv'));
    expect(b.cv_title.y!).toBeGreaterThanOrEqual(WORDMARK_BOTTOM);
    expect(COVER_TITLE_Y).toBeGreaterThanOrEqual(WORDMARK_BOTTOM);
  });

  it('cover: title, subtitle and date do not overlap each other', () => {
    const b = readBoxes(buildCoverTextBoxes('cv'));
    expect(b.cv_title.y! + b.cv_title.h!).toBeLessThanOrEqual(b.cv_subtitle.y!);
    expect(b.cv_subtitle.y! + b.cv_subtitle.h!).toBeLessThanOrEqual(b.cv_date.y!);
  });

  it('section: the divider title is white and clears the wordmark', () => {
    const b = readBoxes(buildSectionTextBoxes('sc'));
    expect(b.sc_title.color).toEqual(COLOR_WHITE);
    expect(isLegibleOn(b.sc_title.color, 'dark')).toBe(true);
    expect(b.sc_title.y!).toBeGreaterThanOrEqual(WORDMARK_BOTTOM);
  });
});
