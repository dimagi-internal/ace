import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for ace#2311 (sibling of ace#1673, see
// onboarding-email-word-band.test.ts): `training-llo-guide` stated a
// 500-1200 word band for the WHOLE guide while also mandating a UAT
// checklist pasted verbatim from every journey's `pass_criteria`. That
// checklist scales with journey count (583 words on a 7-journey PDD,
// bednet-check-2-visit/20260908-1544), and the eval hard-gates
// `operational_realism` on troubleshooting depth the remaining budget could
// not fund. A producer obeying the band failed the eval; one passing the eval
// broke the band.
//
// Invariants:
//   A. Every band the producer states excludes the verbatim UAT checklist.
//   B. The producer says the eval is authoritative.
//   C. The producer still mandates the verbatim checklist (otherwise A is
//      moot and this test should be revisited, not silently passing).
//   D. If the eval ever grows a length dimension, the producer band must sit
//      inside it — the eval is authoritative.

const SKILLS = join(__dirname, '..', '..', 'skills');
const PRODUCER = join(SKILLS, 'training-llo-guide', 'SKILL.md');
const EVAL = join(SKILLS, 'training-llo-guide-eval', 'SKILL.md');

/** The spec only; the `## Change Log` quotes superseded bands as history. */
function spec(md: string): string {
  return md.split(/^## Change Log$/m)[0];
}

/** Each `Word count 500-1200 ...` statement plus the next few lines of context. */
function bandStatements(md: string): Array<{ line: number; band: [number, number]; text: string }> {
  const lines = spec(md).split('\n');
  const out: Array<{ line: number; band: [number, number]; text: string }> = [];
  lines.forEach((text, i) => {
    if (!/word\s+(count|budget|band)/i.test(text)) return;
    const m = text.match(/(\d{2,4})\s*[-–]\s*(\d{2,4})/);
    if (!m) return;
    out.push({
      line: i + 1,
      band: [Number(m[1]), Number(m[2])],
      text: lines.slice(i, i + 3).join(' '),
    });
  });
  return out;
}

describe('training-llo-guide word band vs verbatim UAT checklist (ace#2311)', () => {
  const producer = readFileSync(PRODUCER, 'utf8');
  const evalRubric = readFileSync(EVAL, 'utf8');

  it('A. every stated band excludes the verbatim UAT checklist', () => {
    const bands = bandStatements(producer);
    expect(bands.length, 'expected the producer to state a word band').toBeGreaterThanOrEqual(1);
    const offenders = bands.filter((b) => !/excluding the verbatim UAT checklist/i.test(b.text));
    expect(
      offenders.map((b) => `line ${b.line}: ${b.text.trim()}`),
      'a band that counts the verbatim UAT checklist is unreachable on a multi-journey PDD (ace#2311)',
    ).toEqual([]);
  });

  it('B. the producer names the eval as authoritative', () => {
    expect(spec(producer)).toMatch(/eval is authoritative/i);
  });

  it('C. the producer still mandates the verbatim checklist', () => {
    expect(spec(producer)).toMatch(/paste the criterion verbatim/i);
  });

  it('D. any eval length band contains the producer band', () => {
    const m = evalRubric.match(/between\s+(\d{2,4})\s+and\s+(\d{2,4})\s+words/i);
    if (!m) return; // the eval has no length dimension today
    const [lo, hi] = bandStatements(producer)[0].band;
    expect(lo >= Number(m[1]) && hi <= Number(m[2])).toBe(true);
  });
});
