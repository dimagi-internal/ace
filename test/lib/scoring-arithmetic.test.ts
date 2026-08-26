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

import { assertChecked, assertUnable } from '../../lib/check-outcome.js';
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
    assertChecked(r);
    expect(r.ok).toBe(true);
    expect(r.itemScores).toEqual(['/data/q1_score', '/data/q2_score', '/data/q3_score']);
  });

  it('catches a rollup that OMITS a term — the quietly-wrong-score case', () => {
    const r = checkScoringArithmetic(
      withUserScore('(/data/q1_score + /data/q2_score) * 100 div 3'),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('missing-term');
    expect(r.findings.find((f) => f.kind === 'missing-term')!.detail).toMatch(/q3_score/);
  });

  it('catches a denominator that does not match the item count', () => {
    const r = checkScoringArithmetic(
      withUserScore('(/data/q1_score + /data/q2_score + /data/q3_score) * 100 div 4'),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('denominator-mismatch');
    expect(r.findings.find((f) => f.kind === 'denominator-mismatch')!.detail).toMatch(/3 scored item/);
  });

  it('catches a rollup term with no matching item bind', () => {
    const r = checkScoringArithmetic(
      withUserScore('(/data/q1_score + /data/q2_score + /data/q3_score + /data/q9_score) * 100 div 3'),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('extra-term');
  });

  it('catches an item whose calculate does not reference its own question', () => {
    const r = checkScoringArithmetic(
      GOOD.replace(`if(/data/q2 = 'c', 1, 0)`, `if(/data/q1 = 'c', 1, 0)`),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('self-reference-missing');
  });

  it('catches an item that cannot award 1 — the max becomes unreachable', () => {
    const r = checkScoringArithmetic(
      GOOD.replace(`if(/data/q2 = 'c', 1, 0)`, `if(/data/q2 = 'c', 0, 0)`),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('unreachable-max');
  });

  it('is UNABLE, not a pass, on a form with no scoring — with a reason and a loud report', () => {
    const r = checkScoringArithmetic('<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head/></h:html>');
    // The pre-#1677 shape returned `{ checked: false, ok: true }` here, and a
    // caller reading `.ok` got `true` from a check that never looked. On
    // `bednet-check-2-visit/20260825-1310` a depth-anchored ITEM_SCORE regex
    // sent BOTH real Learn scoring forms — the gating assessment included —
    // down this exact path (ace#1634). There is now no `ok` here to misread.
    expect(r.status).toBe('unable');
    assertUnable(r);
    expect(r.reason).toMatch(/item-score node/i);
    // A reason that does not point at the matcher is how three prior
    // instances of this class were signed off as "not applicable".
    expect(r.reason).toMatch(/ITEM_SCORE is the bug/);
    const text = formatScoringReport(r);
    expect(text).toMatch(/UNABLE TO CHECK/);
    expect(text).toMatch(/NOT a pass/);
    // No green-looking word anywhere: "clean" is what the checked-and-fine
    // branch says, and "not applicable" is the benign phrasing three prior
    // instances of this class were signed off under.
    expect(text).not.toMatch(/\bclean\b/i);
    expect(text).not.toMatch(/not applicable/i);
  });

  it('reports BLIND rather than clean when items exist but user_score does not', () => {
    const r = checkScoringArithmetic(
      GOOD.replace(/<bind nodeset="\/data\/user_score"[^>]*\/>/, ''),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('no-rollup');
  });

  it('accepts a raw-sum rollup (no percentage) without inventing a denominator complaint', () => {
    const r = checkScoringArithmetic(
      withUserScore('/data/q1_score + /data/q2_score + /data/q3_score'),
    );
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).not.toContain('denominator-mismatch');
  });

  /**
   * dimagi-internal/ace#1538 — ITEM_SCORE hard-coded a `q` prefix, so a
   * pre-test scoring `p1_score`..`p10_score` matched ZERO items and the
   * function returned `checked: false`, which `app-release-qa` defines as
   * "not applicable, NOT a pass". The gate silently covered nothing on a form
   * that did carry item scores.
   *
   * Live instance: hh-poverty-targeting/20260819-1435, Learn build
   * 35384a8007114f29b5e04b9ac78274a2, `modules-0/forms-0.xml` ("Before you
   * start"), 10 items + a `* 100 div 10` rollup — never checked, while the
   * sibling `modules-5/forms-0.xml` (q-prefixed) was.
   *
   * Both instruments live in ONE Learn app by construction, so the prefix
   * cannot be assumed.
   */
  const PRETEST = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head><model>
    <bind nodeset="/data/p1_score" calculate="if(/data/p1 = 'c', 1, 0)"/>
    <bind nodeset="/data/p2_score" calculate="if(/data/p2 = 'a', 1, 0)"/>
    <bind nodeset="/data/p10_score" calculate="if(/data/p10 = 'b', 1, 0)"/>
    <bind nodeset="/data/user_score" calculate="(/data/p1_score + /data/p2_score + /data/p10_score) * 100 div 3"/>
  </model></h:head>
</h:html>`;

  it('CHECKS a non-q-prefixed pre-test instead of reporting not-applicable (#1538)', () => {
    const r = checkScoringArithmetic(PRETEST);
    assertChecked(r);
    expect(r.ok).toBe(true);
    expect(r.itemScores).toEqual([
      '/data/p1_score',
      '/data/p2_score',
      '/data/p10_score',
    ]);
  });

  it('still CATCHES a defect in a non-q-prefixed pre-test (#1538)', () => {
    // p2_score scores p1 — the copy-paste class, now reachable on a pre-test.
    const r = checkScoringArithmetic(
      PRETEST.replace(
        '<bind nodeset="/data/p2_score" calculate="if(/data/p2 = \'a\', 1, 0)"/>',
        '<bind nodeset="/data/p2_score" calculate="if(/data/p1 = \'a\', 1, 0)"/>',
      ),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('self-reference-missing');
  });

  it('does not mistake /data/user_score itself for an item score (#1538)', () => {
    const r = checkScoringArithmetic(PRETEST);
    assertChecked(r);
    expect(r.itemScores).not.toContain('/data/user_score');
  });

  // --- ace#1634: score nodes nested inside a section ---------------------
  // The shape Nova emits whenever the architect used `set_form_sections`, which
  // is ACE's standard output. Verbatim from the released Learn CCZ of
  // bednet-check-2-visit/20260825-1310 (build 59e714e4d46b444690c3b7ea00be68ef,
  // modules-1/forms-1.xml — the app's one gating `connect.assessment`).
  const SECTIONED = [
    '<data>',
    ...[1, 2, 3, 4, 5, 6].map(
      (n) =>
        `<bind nodeset="/data/check_result/q${n}_score" type="xsd:string" ` +
        `calculate="if(/data/check_q${n}/q${n} = 'ans${n}', 1, 0)"/>`,
    ),
    '<bind nodeset="/data/check_result/user_score" type="xsd:string" calculate="(' +
      [1, 2, 3, 4, 5, 6].map((n) => `/data/check_result/q${n}_score`).join(' + ') +
      ') * 100 div 6"/>',
    '</data>',
  ].join('');

  it('SEES item scores nested inside a section (#1634)', () => {
    const r = checkScoringArithmetic(SECTIONED);
    // The whole defect: this reported `checked: false` — which app-release-qa
    // defines as "not applicable, NOT a pass" — so the gate covered nothing.
    assertChecked(r);
    expect(r.itemScores).toHaveLength(6);
    expect(r.itemScores).toContain('/data/check_result/q1_score');
  });

  it('does not false-fire self-reference-missing on a sectioned form (#1634)', () => {
    // The score node and its question are NOT siblings here, so a full-path
    // derivation flags all six correct items. Coupled to the depth fix.
    const r = checkScoringArithmetic(SECTIONED);
    assertChecked(r);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still CATCHES a cross-scored item on a sectioned form (#1634)', () => {
    const r = checkScoringArithmetic(
      SECTIONED.replace(
        `calculate="if(/data/check_q2/q2 = 'ans2', 1, 0)"`,
        `calculate="if(/data/check_q1/q1 = 'ans2', 1, 0)"`,
      ),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('self-reference-missing');
  });

  it('still CATCHES a denominator mismatch on a sectioned form (#1634)', () => {
    const r = checkScoringArithmetic(SECTIONED.replace('* 100 div 6', '* 100 div 5'));
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toContain('denominator-mismatch');
  });

  it('names every finding in the formatted report', () => {
    const r = checkScoringArithmetic(withUserScore('(/data/q1_score) * 100 div 3'));
    assertChecked(r);
    const out = formatScoringReport(r);
    expect(out).toMatch(/q2_score/);
    expect(out).toMatch(/q3_score/);
    expect(out).toMatch(/1035/);
  });
});
