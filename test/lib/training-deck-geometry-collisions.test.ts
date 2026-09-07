/**
 * Geometry regression: nothing a rendered slide draws may fall off the slide,
 * and an image may not be drawn on top of the text it illustrates.
 *
 * Every defect this file pins shipped in a real deck
 * (`poverty-graduation/20260905-1345`, 24 slides) and every one of them was
 * invisible to the existing suite, because the existing tests check that the
 * right TOKENS are filled — never where the resulting boxes physically land.
 *
 *   - `mobile_zoom` drew the phone at x 2_286_000 / y 685_800: inside the
 *     title band (457_200–1_157_200) and across half the callouts column
 *     (which ends at 4_114_800). The title and every callout line rendered
 *     UNDER the screenshot (ace#2190).
 *   - `mobile_flow` started captions at SLIDE_H - 700_000 in a 500_000-tall
 *     box — about 2.5 lines for captions that routinely run to four, so the
 *     surplus ran off the bottom edge and was cut mid-word on all five
 *     four-up slides.
 *
 * The assertions are deliberately about RECTANGLES, not about the specific
 * numbers, so a future re-layout is free to move things and still be checked.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSlidesRequestsV2,
  stripLeadingOrdinal,
  type TrainingDeckSpec,
} from '../../lib/training-deck-spec.js';
import {
  SLIDE_W,
  SLIDE_H,
  MOBILE_ZOOM_CALLOUTS_RIGHT,
  TITLE_BAND_BOTTOM,
} from '../../lib/training-deck-stencil-geometry.js';

interface Rect { id: string; page: string; kind: 'image' | 'shape'; x: number; y: number; w: number; h: number }

const STENCILS = {
  cover: 's_cover', section: 's_section', agenda: 's_agenda', content: 's_content',
  walkthrough: 's_walkthrough', mobile_flow: 's_mobile_flow', web_screen: 's_web_screen',
  mobile_zoom: 's_mobile_zoom', two_column: 's_two_column', stats: 's_stats',
  timeline: 's_timeline', checklist: 's_checklist', exercise: 's_exercise', closing: 's_closing',
} as Record<string, string>;

const manifest = { resolveImageRef: (ref: string) => `https://example.test/${ref}.png` };

/** Pull every positioned element out of a batchUpdate request list. */
function rects(requests: Array<Record<string, unknown>>): Rect[] {
  const out: Rect[] = [];
  for (const req of requests) {
    const ci = (req as any).createImage;
    const cs = (req as any).createShape;
    const node = ci ?? cs;
    if (!node) continue;
    const ep = node.elementProperties;
    if (!ep?.size || !ep?.transform) continue;
    out.push({
      id: node.objectId,
      page: ep.pageObjectId,
      kind: ci ? 'image' : 'shape',
      x: ep.transform.translateX,
      y: ep.transform.translateY,
      w: ep.size.width.magnitude,
      h: ep.size.height.magnitude,
    });
  }
  return out;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function specWith(slide: Record<string, unknown>): TrainingDeckSpec {
  return {
    slug: 'geo', name: 'Geometry', program: 'Geometry', archetype: 'atomic-visit',
    template_id: 't', generated_at: '2026-09-07T00:00:00Z',
    source: { pdd_doc_id: 'd', run_id: 'r' },
    manifest: { screens: {} },
    modules: [{ id: 'm', title: 'M', slides: [slide] }],
  } as unknown as TrainingDeckSpec;
}

const build = (slide: Record<string, unknown>) =>
  rects(buildSlidesRequestsV2(specWith(slide), { stencils: STENCILS, manifest } as any));

describe('rendered slide geometry stays on the slide', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['mobile_zoom', {
      id: 's1', layout: 'mobile_zoom', title: 'The certification quiz', image: '@shot',
      callouts: ['The result screen reads Passed', 'No score is shown', 'You can retake it'],
    }],
    ['mobile_flow (4 steps)', {
      id: 's2', layout: 'mobile_flow', title: 'Finding the job',
      steps: [0, 1, 2, 3].map((i) => ({ image: `@s${i}`, caption: `Caption ${i}` })),
    }],
    ['mobile_flow (2 steps)', {
      id: 's3', layout: 'mobile_flow', title: 'Two up',
      steps: [0, 1].map((i) => ({ image: `@s${i}`, caption: `Caption ${i}` })),
    }],
    ['walkthrough', { id: 's4', layout: 'walkthrough', title: 'W', image: '@shot', body: 'Body' }],
    ['web_screen', { id: 's5', layout: 'web_screen', title: 'W', image: '@shot', caption: 'Cap' }],
  ];

  for (const [name, slide] of cases) {
    it(`${name}: every element is fully inside the slide`, () => {
      for (const r of build(slide)) {
        expect(r.x, `${r.id} starts left of the slide`).toBeGreaterThanOrEqual(0);
        expect(r.y, `${r.id} starts above the slide`).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w, `${r.id} runs off the right edge`).toBeLessThanOrEqual(SLIDE_W);
        expect(
          r.y + r.h,
          `${r.id} runs off the BOTTOM edge — its text is cut mid-word for the reader`,
        ).toBeLessThanOrEqual(SLIDE_H);
      }
    });
  }

  it('mobile_flow: adjacent captions never overlap each other', () => {
    const caps = build(cases[1][1]).filter((r) => r.id.includes('_cap_'));
    expect(caps.length).toBe(4);
    for (let i = 1; i < caps.length; i++) {
      expect(
        caps[i - 1].x + caps[i - 1].w,
        `caption ${i - 1} runs into caption ${i}`,
      ).toBeLessThanOrEqual(caps[i].x);
    }
  });

  it('mobile_flow: no phone is drawn over its own caption', () => {
    const all = build(cases[1][1]);
    const phones = all.filter((r) => r.kind === 'image');
    const caps = all.filter((r) => r.id.includes('_cap_'));
    for (const p of phones) {
      for (const c of caps) {
        expect(overlaps(p, c), `${p.id} overlaps ${c.id}`).toBe(false);
      }
    }
  });

  it('mobile_zoom: the phone clears the title band and the callouts column', () => {
    const img = build(cases[0][1]).find((r) => r.kind === 'image');
    expect(img, 'no image emitted').toBeDefined();
    expect(
      img!.y,
      'the phone starts inside the title band, rendering the title underneath it',
    ).toBeGreaterThanOrEqual(TITLE_BAND_BOTTOM);
    expect(
      img!.x,
      'the phone starts inside the callouts column, rendering the callouts underneath it',
    ).toBeGreaterThanOrEqual(MOBILE_ZOOM_CALLOUTS_RIGHT);
  });

  /**
   * A bounds check is NOT sufficient for the four-up captions, and that is
   * worth stating: with the shipped geometry the caption BOX (y 4_443_500,
   * h 500_000) sat inside the slide perfectly well. What ran off the bottom
   * edge was the TEXT, because the box held ~2.5 lines and the captions were
   * four. Slides does not shrink text to fit, so the surplus simply drew past
   * the box and off the slide.
   *
   * So the box must be checked against the text it is given. The line
   * estimate below is deliberately coarse — average glyph advance for a
   * humanist sans at ~0.5em — and only has to be good enough to separate
   * "two lines of room for four lines of text" from a box that fits.
   */
  it('mobile_flow: the caption box is tall enough for a real caption', () => {
    const CAPTION_PT = 11;
    const EMU_PER_PT = 12_700;
    const LINE_HEIGHT = 1.2;
    // Verbatim from the shipped deck — the caption that was cut at
    // "— scroll past the ones in".
    const realCaption =
      'The job list. A job you have not started sits under New Opportunities ' +
      '— scroll past the ones in progress.';

    const slide = {
      id: 's6', layout: 'mobile_flow', title: 'Finding the job',
      steps: [0, 1, 2, 3].map((i) => ({ image: `@s${i}`, caption: realCaption })),
    };
    const caps = build(slide).filter((r) => r.id.includes('_cap_'));
    expect(caps.length).toBe(4);

    for (const c of caps) {
      const widthPt = c.w / EMU_PER_PT;
      const charsPerLine = Math.floor(widthPt / (CAPTION_PT * 0.5));
      const lines = Math.ceil(realCaption.length / charsPerLine);
      const neededH = Math.ceil(lines * CAPTION_PT * LINE_HEIGHT * EMU_PER_PT);

      expect(
        c.h,
        `${c.id} holds ~${Math.floor(c.h / (CAPTION_PT * LINE_HEIGHT * EMU_PER_PT))} lines ` +
          `but the caption needs ${lines}; the surplus draws past the box`,
      ).toBeGreaterThanOrEqual(neededH);

      expect(
        c.y + neededH,
        `${c.id}'s text reaches ${c.y + neededH} EMU, past the slide bottom (${SLIDE_H}) ` +
          '— the reader sees it cut mid-word',
      ).toBeLessThanOrEqual(SLIDE_H);
    }
  });

  it('mobile_zoom: the phone keeps a portrait aspect rather than being stretched', () => {
    const img = build(cases[0][1]).find((r) => r.kind === 'image')!;
    const aspect = img.w / img.h;
    // A phone capture is ~1080x2400 (0.45). Allow slack, but reject the old
    // 0.686 box, which stretched every screenshot sideways.
    expect(aspect).toBeLessThan(0.6);
    expect(aspect).toBeGreaterThan(0.3);
  });
});

describe('list markers are not doubled', () => {
  it('strips a leading ordinal the spec supplied, and keeps a genuine figure', () => {
    expect(stripLeadingOrdinal('1. Targeting survey (C2)')).toBe('Targeting survey (C2)');
    expect(stripLeadingOrdinal('2) Enrollment (C4)')).toBe('Enrollment (C4)');
    expect(stripLeadingOrdinal('10 - Asset delivery')).toBe('Asset delivery');
    expect(stripLeadingOrdinal('Targeting survey')).toBe('Targeting survey');
    // A label that genuinely opens with a number keeps it.
    expect(stripLeadingOrdinal('2026 targets')).toBe('2026 targets');
  });

  it('a pre-numbered timeline spec renders exactly one ordinal per step', () => {
    const reqs = buildSlidesRequestsV2(
      specWith({
        id: 't1', layout: 'timeline', title: 'Order',
        steps: [
          { label: '1. Targeting survey (C2)', detail: 'Creates the record' },
          { label: '2. Enrollment (C4)', detail: 'Consent and details' },
        ],
      }),
      { stencils: STENCILS, manifest } as any,
    );
    const body = reqs
      .map((r: any) => r.replaceAllText)
      .find((r: any) => r?.containsText?.text === '{{BODY}}')?.replaceText as string;
    expect(body).toBeDefined();
    expect(body).toContain('1.  Targeting survey (C2)');
    expect(body).not.toContain('1.  1.');
  });
});
