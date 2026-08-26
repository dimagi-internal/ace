import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for ace#1673: the producer skill and its paired `-eval`
// rubric stated DIFFERENT word bands, so an email written exactly to the
// producer's spec was penalised by the eval for complying.
//
// `training-onboarding-email` authorised 200-400 words. Its eval scored
// `length_discipline` (weight 0.05) 10 only inside 80-350, AND re-scored the
// same quantity inside `clarity` (weight 0.30) with `10 = <= 200 words` /
// `6 = >= 350 words`. Two independent defects fell out of that:
//
//   1. CROSS-FILE DIVERGENCE. Anything in the upper half of the producer's own
//      band (350-400) lost 0.35 of total weight by construction. Measured on
//      hh-poverty-targeting/20260824-1404: a 390-word email took clarity 6.5
//      and length_discipline 6.0 for being in-spec.
//   2. INTRA-RUBRIC DOUBLE-COUNT. `clarity`'s 10-anchor (<= 200) sat exactly at
//      the producer's 200-word FLOOR, so NO compliant email could score 10 on
//      the heaviest dimension in the rubric.
//
// Prose cannot hold this: the numbers live in four places across two files and
// drift silently, because nothing fails when they disagree — the run just
// scores lower and the delta reads as artifact quality. Same class as ace#1654
// (a producer graded on an axis it cannot see), and resolved the same way: the
// EVAL is authoritative and the producer moves to sit inside it.
//
// Three invariants:
//   A. The producer states ONE band, and every restatement of it agrees.
//   B. That band sits inside the eval's `length_discipline` 10-band.
//   C. Length is anchored in exactly ONE eval dimension. No other row may
//      carry a word-count threshold.

const SKILLS = join(__dirname, '..', '..', 'skills');
const PRODUCER = join(SKILLS, 'training-onboarding-email', 'SKILL.md');
const EVAL = join(SKILLS, 'training-onboarding-email-eval', 'SKILL.md');

/**
 * `Word count: 200-350` / `**Word budget:** 200-350 words` → [200, 350].
 *
 * Scans the SPEC only. The `## Change Log` is history — it deliberately quotes
 * superseded bands ("200-400 → 200-350") and must not read as a live claim.
 */
function producerBands(md: string): Array<{ line: number; band: [number, number] }> {
  const out: Array<{ line: number; band: [number, number] }> = [];
  const spec = md.split(/^## Change Log$/m)[0];
  spec.split('\n').forEach((text, i) => {
    if (!/word\s+(count|budget|band)/i.test(text)) return;
    const m = text.match(/(\d{2,4})\s*[-–]\s*(\d{2,4})/);
    if (m) out.push({ line: i + 1, band: [Number(m[1]), Number(m[2])] });
  });
  return out;
}

/** A `| **Dimension** | 0.30 | ...anchors... |` row of the rubric table. */
function rubricRows(md: string): Array<{ name: string; anchors: string; line: number }> {
  const out: Array<{ name: string; anchors: string; line: number }> = [];
  md.split('\n').forEach((text, i) => {
    const m = text.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*([0-9.]+)\s*\|(.*)\|\s*$/);
    if (m) out.push({ name: m[1].trim(), anchors: m[3], line: i + 1 });
  });
  return out;
}

/** Any `N words` threshold, e.g. `<= 200 words`, `between 80 and 350 words`. */
const WORD_THRESHOLD = /\b\d{2,4}\s*words?\b/i;

describe('training-onboarding-email producer/eval word band (ace#1673)', () => {
  const producer = readFileSync(PRODUCER, 'utf8');
  const evalRubric = readFileSync(EVAL, 'utf8');

  it('A. the producer states its word band consistently everywhere', () => {
    const bands = producerBands(producer);
    expect(
      bands.length,
      'expected the producer to state a word band (e.g. "Word count: 200-350")',
    ).toBeGreaterThanOrEqual(3);

    const distinct = [...new Set(bands.map((b) => b.band.join('-')))];
    expect(
      distinct,
      `producer restates its word band at lines ${bands.map((b) => b.line).join(', ')} ` +
        `and they disagree: ${distinct.join(' vs ')}. State it once, agree everywhere.`,
    ).toHaveLength(1);
  });

  it('B. the producer band sits inside the eval\'s length_discipline 10-band', () => {
    const rows = rubricRows(evalRubric);
    const lengthRow = rows.find((r) => /length/i.test(r.name));
    expect(lengthRow, 'eval rubric has no length dimension').toBeDefined();

    const m = lengthRow!.anchors.match(/between\s+(\d{2,4})\s+and\s+(\d{2,4})\s+words/i);
    expect(
      m,
      `could not read the 10-band from ${lengthRow!.name}: ${lengthRow!.anchors.trim()}`,
    ).not.toBeNull();
    const [evalLo, evalHi] = [Number(m![1]), Number(m![2])];

    const [prodLo, prodHi] = producerBands(producer)[0].band;
    expect(
      prodLo >= evalLo && prodHi <= evalHi,
      `producer authorises ${prodLo}-${prodHi} words but the eval scores ` +
        `${lengthRow!.name} 10 only inside ${evalLo}-${evalHi}. An email written ` +
        `to spec would be penalised for complying (ace#1673). The eval is ` +
        `authoritative — move the producer.`,
    ).toBe(true);
  });

  it('C. length is anchored in exactly one eval dimension', () => {
    const rows = rubricRows(evalRubric);
    expect(rows.length, 'no rubric rows parsed from the eval').toBeGreaterThanOrEqual(4);

    const offenders = rows
      .filter((r) => !/length/i.test(r.name))
      .filter((r) => WORD_THRESHOLD.test(r.anchors))
      .map((r) => `${r.name} (line ${r.line}): ${r.anchors.match(WORD_THRESHOLD)![0]}`);

    expect(
      offenders,
      `these dimensions re-score word count, which length_discipline already owns ` +
        `— double-counting length at a heavier weight (ace#1673):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
