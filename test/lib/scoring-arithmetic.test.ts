/**
 * dimagi-internal/ace#1035 — the Nova architect generates the Learn app's
 * scoring arithmetic, and nothing checks it.
 *
 * Connect reads `user_score` off Learn assessment submissions
 * (`dimagi/commcare-connect@5f69bb3d`
 * `commcare_connect/form_receiver/processor.py:230`), and CommCare has no
 * "mark this option correct" primitive — Vellum's Assessment Score mug takes a
 * hand-written XPath expression (`dimagi/Vellum@8a1ef02`
 * `src/commcareConnect.js:180-198`). So the score is arithmetic an author
 * writes by hand, and Nova's maintainer confirmed that is the PLATFORM's
 * shape, not a Nova gap (nova#372, recommended for closure).
 *
 * The Household Poverty Targeting Learn app (2026-07-28) spends 36+ hidden
 * fields on scoring alone — 20 post-test, 10 pre-test, plus per-area rollups.
 * A single wrong `q<N>_score` condition, or a rollup that omits one term,
 * produces a plausible score that is quietly wrong. Nothing catches it:
 *
 *  - no `-eval` grades the arithmetic (they grade the app against the PDD, and
 *    the PDD carries no per-item score expressions);
 *  - `app-release-qa` is structural — form counts and Connect markers, not
 *    calculate semantics.
 *
 * And a worker's pass/fail against the opportunity's passing score depends on
 * it, so a wrong score gates the wrong people out of PAID WORK.
 *
 * Everything below is readable from the released form XML — no emulator, no
 * device. The natural home is beside `checkAssessmentRetryLeak` in
 * `app-release-qa`, which already parses the same artifact.
 */
import { describe, it, expect } from 'vitest';
import { checkScoringArithmetic, formatScoringReport } from '../../lib/scoring-arithmetic.js';

/** A well-formed 3-item percentage-scored quiz. */
const GOOD = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head><model>
    <bind nodeset="/data/q1_score" calculate="if(/data/q1 = 'a', 1, 0)"/>
    <bind nodeset="/data/q2_score" calculate="if(/data/q2 = 'c', 1, 0)"/>
    <bind nodeset="/data/q3_score" calculate="if(/data/q3 = 'b', 1, 0)"/>
    <bind nodeset="/data/user_score" calculate="(/data/q1_score + /data/q2_score + /data/q3_score) * 100 div 3"/>
  </model></h:head>
</h:html>`;

const withUserScore = (calc: string) =>
  GOOD.replace(/calculate="\(\/data\/q1_score[^"]*"/, `calculate="${calc}"`);

describe('checkScoringArithmetic (#1035)', () => {
  it('passes a correct 3-item percentage quiz', () => {
    const r = checkScoringArithmetic(GOOD);
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.itemScores).toEqual(['/data/q1_score', '/data/q2_score', '/data/q3_score']);
  });

  it('catches a rollup that OMITS a term — the quietly-wrong-score case', () => {
    const r = checkScoringArithmetic(
      withUserScore('(/data/q1_score + /data/q2_score) * 100 div 3'),
    );
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('missing-term');
    expect(r.findings.find((f) => f.kind === 'missing-term')!.detail).toMatch(/q3_score/);
  });

  it('catches a denominator that does not match the item count', () => {
    const r = checkScoringArithmetic(
      withUserScore('(/data/q1_score + /data/q2_score + /data/q3_score) * 100 div 4'),
    );
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('denominator-mismatch');
    expect(r.findings.find((f) => f.kind === 'denominator-mismatch')!.detail).toMatch(/3 scored item/);
  });

  it('catches a rollup term with no matching item bind', () => {
    const r = checkScoringArithmetic(
      withUserScore('(/data/q1_score + /data/q2_score + /data/q3_score + /data/q9_score) * 100 div 3'),
    );
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('extra-term');
  });

  it('catches an item whose calculate does not reference its own question', () => {
    const r = checkScoringArithmetic(
      GOOD.replace(`if(/data/q2 = 'c', 1, 0)`, `if(/data/q1 = 'c', 1, 0)`),
    );
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('self-reference-missing');
  });

  it('catches an item that cannot award 1 — the max becomes unreachable', () => {
    const r = checkScoringArithmetic(
      GOOD.replace(`if(/data/q2 = 'c', 1, 0)`, `if(/data/q2 = 'c', 0, 0)`),
    );
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('unreachable-max');
  });

  it('is NOT APPLICABLE on a form with no scoring, rather than passing it', () => {
    const r = checkScoringArithmetic('<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head/></h:html>');
    expect(r.checked).toBe(false);
    expect(r.ok).toBe(true);
    expect(formatScoringReport(r)).toMatch(/not applicable/i);
  });

  it('reports BLIND rather than clean when items exist but user_score does not', () => {
    const r = checkScoringArithmetic(
      GOOD.replace(/<bind nodeset="\/data\/user_score"[^>]*\/>/, ''),
    );
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('no-rollup');
  });

  it('accepts a raw-sum rollup (no percentage) without inventing a denominator complaint', () => {
    const r = checkScoringArithmetic(
      withUserScore('/data/q1_score + /data/q2_score + /data/q3_score'),
    );
    expect(r.findings.map((f) => f.kind)).not.toContain('denominator-mismatch');
  });

  it('names every finding in the formatted report', () => {
    const r = checkScoringArithmetic(withUserScore('(/data/q1_score) * 100 div 3'));
    const out = formatScoringReport(r);
    expect(out).toMatch(/q2_score/);
    expect(out).toMatch(/q3_score/);
    expect(out).toMatch(/1035/);
  });
});
