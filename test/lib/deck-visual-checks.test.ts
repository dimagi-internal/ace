import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRenderedDeck, slidesToJudge, type PresentationJson } from '../../lib/deck-visual-checks';

const W = 9_144_000;
const H = 5_143_500;
const textBox = (content: string, pt?: number, x = 457_200, y = 457_200, w = 4_000_000, h = 1_000_000) => ({
  objectId: 'tb',
  size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } },
  transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' },
  shape: { text: { textElements: [{ textRun: { content, style: pt ? { fontSize: { magnitude: pt, unit: 'PT' } } : {} } }] } },
});
const image = (x = 457_200) => ({
  objectId: 'img',
  size: { width: { magnitude: 3_000_000, unit: 'EMU' }, height: { magnitude: 2_000_000, unit: 'EMU' } },
  transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: 457_200, unit: 'EMU' },
  image: {},
});

const deck = (slides: PresentationJson['slides']): PresentationJson => ({ pageSize: { width: { magnitude: W, unit: 'EMU' }, height: { magnitude: H, unit: 'EMU' } }, slides });

describe('rendered deck pre-checks', () => {
  it('passes an ordinary slide', () => {
    const [r] = checkRenderedDeck(deck([{ objectId: 's1', pageElements: [textBox('How to record a meeting', 24), image()] }]));
    expect(r.findings).toEqual([]);
    expect(r.images).toBe(1);
  });

  it('flags an empty slide, a placeholder and an element off the page', () => {
    const reports = checkRenderedDeck(
      deck([
        { objectId: 's1', pageElements: [] },
        { objectId: 's2', pageElements: [textBox('Welcome {{opp_name}}', 24)] },
        { objectId: 's3', pageElements: [textBox('Step 1', 24), image(8_000_000)] },
      ]),
    );
    expect(reports.map((r) => r.findings.map((f) => f.kind))).toEqual([['empty-slide'], ['placeholder-text'], ['off-page-element']]);
  });

  it('suspects overflow only for an explicit font size and a clear excess', () => {
    const long = 'word '.repeat(200);
    const [tooMuch, unknownSize] = checkRenderedDeck(
      deck([
        { objectId: 's1', pageElements: [textBox(long, 18, 457_200, 457_200, 3_000_000, 600_000)] },
        { objectId: 's2', pageElements: [textBox(long, undefined, 457_200, 457_200, 3_000_000, 600_000)] },
      ]),
    );
    expect(tooMuch.findings.map((f) => f.kind)).toEqual(['suspected-text-overflow']);
    expect(unknownSize.findings).toEqual([]);
  });

  it('judges every slide of a small deck, and every flagged slide plus a spread sample of a large one', () => {
    const small = checkRenderedDeck(deck(Array.from({ length: 10 }, (_, i) => ({ objectId: `s${i}`, pageElements: [textBox('x '.repeat(30), 18)] }))));
    expect(slidesToJudge(small)).toHaveLength(10);
    const big = checkRenderedDeck(
      deck(Array.from({ length: 50 }, (_, i) => ({ objectId: `s${i}`, pageElements: i === 40 ? [] : [textBox('content here', 18)] }))),
    );
    const judged = slidesToJudge(big);
    expect(judged).toContain(41);
    expect(judged.length).toBeLessThanOrEqual(17);
    expect(judged[judged.length - 1]).toBeGreaterThan(40);
  });
});

// The first 4 slides of spark-facilitator/20260926-1800's real rendered deck (slides.presentations.get, 2026-10-01).
const REAL = join(__dirname, '../fixtures/qa-gaps/spark-20260926-1800-deck-4-slides.json');

describe('rendered deck pre-checks — on the real Spark deck', () => {
  it('finds nothing wrong with the real slides, and flags them once emptied or given a placeholder', () => {
    const real = JSON.parse(readFileSync(REAL, 'utf8')) as PresentationJson;
    expect(checkRenderedDeck(real).flatMap((r) => r.findings)).toEqual([]);
    const broken = JSON.parse(readFileSync(REAL, 'utf8')) as PresentationJson;
    broken.slides![1].pageElements = [];
    const reports = checkRenderedDeck(broken);
    expect(reports[1].findings.map((f) => f.kind)).toEqual(['empty-slide']);
  });
});
