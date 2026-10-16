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

  // --- ace#2958: an UNGRADED baseline form rolls up into its own node -----
  // Shape from noora-health/20261015-1129 Learn build
  // c74ae6da729f45c7bdbf4784065f1bcf, modules-0/forms-0.xml: six item scores
  // rolled into `baseline_score`, no `user_score`, and no Connect
  // `<assessment>` block. A `user_score` here would BE the defect — ace#1131's
  // cardinality rule exists because Connect sets `passed` on any submitted
  // block carrying one, so a baseline with it passes a worker who opened no
  // module. `no-rollup` used to demand exactly that.
  const LEARN_NS = 'http://commcareconnect.com/data/v1/learn';
  const baseline = (rollupCalc: string, assessment = false) =>
    [
      '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>',
      '<instance><data xmlns="http://openrosa.org/formdesigner/X">',
      `<module xmlns="${LEARN_NS}" id="m1_families"/>`,
      assessment ? `<assessment xmlns="${LEARN_NS}" id="a1"><user_score/></assessment>` : '',
      '</data></instance>',
      ...[1, 2, 3, 4, 5, 6].map(
        (n) =>
          `<bind nodeset="/data/s_baseline_result/bq${n}_score" type="xsd:string" ` +
          `calculate="if(/data/s_baseline/bq${n} = 'a${n}', 1, 0)"/>`,
      ),
      `<bind nodeset="/data/s_baseline_result/baseline_score" type="xsd:string" calculate="${rollupCalc}"/>`,
      '</model></h:head></h:html>',
    ].join('');
  const SIX = [1, 2, 3, 4, 5, 6].map((n) => `/data/s_baseline_result/bq${n}_score`).join(' + ');

  it('does NOT demand user_score on an ungraded baseline that rolls up elsewhere (#2958)', () => {
    const r = checkScoringArithmetic(baseline(`(${SIX}) * 100 div 6`));
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).not.toContain('no-rollup');
    expect(r.ok).toBe(true);
  });

  it('still checks the ungraded rollup it found — terms and denominator (#2958)', () => {
    const r = checkScoringArithmetic(
      baseline(`(${SIX.replace(' + /data/s_baseline_result/bq6_score', '')}) * 100 div 5`),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    const kinds = r.findings.map((f) => f.kind);
    expect(kinds).toContain('missing-term');
    expect(kinds).toContain('denominator-mismatch');
    expect(r.findings.find((f) => f.kind === 'missing-term')!.detail).toMatch(/baseline_score/);
  });

  it('still flags no-rollup on an ASSESSMENT form rolled up into anything but user_score (#2958)', () => {
    // Connect reads user_score off the assessment block; a differently named
    // rollup on the gating form is invisible to it.
    const r = checkScoringArithmetic(baseline(`(${SIX}) * 100 div 6`, true));
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toContain('no-rollup');
  });

  it('still flags no-rollup on an ungraded form whose items roll up into NOTHING (#2958)', () => {
    const r = checkScoringArithmetic(baseline("'n/a'"));
    assertChecked(r);
    const f = r.findings.find((x) => x.kind === 'no-rollup');
    expect(f).toBeDefined();
    // ...and does not tell the author to add the user_score #1131 forbids.
    expect(f!.detail).not.toMatch(/Connect reads user_score/);
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

/**
 * dimagi-internal/ace#2990 — a role-partitioned rollup. Two 10-item banks, a
 * worker answers only her own, and `user_score` picks the bank by role. The
 * whole-form check compared each `div 10` against all 20 items and raised a
 * false BLOCKER on kaduna-graduation/20261015-1411 (Learn build
 * b7a5e1dcc83f482aabdf99858cdc97c0, modules-15/forms-0.xml).
 */
describe('checkScoringArithmetic — if()-partitioned rollup (#2990)', () => {
  const ROLE =
    "instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/kgrad_role = 'FLW'";
  const sum = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `/data/q${from + i}_score`).join(' + ');
  const form = (rollup: string, items = 20) => `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head><model>
${Array.from({ length: items }, (_, i) => `    <bind nodeset="/data/q${i + 1}_score" calculate="if(/data/q${i + 1} = 'a', 1, 0)"/>`).join('\n')}
    <bind nodeset="/data/user_score" type="xsd:string" calculate="${rollup.replace(/'/g, '&apos;')}"/>
  </model></h:head>
</h:html>`;

  it('passes the kaduna bind — each branch sums 10 items and divides by 10', () => {
    const r = checkScoringArithmetic(
      form(`if(${ROLE}, (${sum(1, 10)}) * 100 div 10, (${sum(11, 20)}) * 100 div 10)`),
    );
    assertChecked(r);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still CATCHES a branch whose div disagrees with its own term count', () => {
    const r = checkScoringArithmetic(
      form(`if(${ROLE}, (${sum(1, 9)}) * 100 div 10, (${sum(10, 20)}) * 100 div 11)`, 20),
    );
    assertChecked(r);
    const f = r.findings.filter((x) => x.kind === 'denominator-mismatch');
    expect(f).toHaveLength(1);
    expect(f[0].detail).toMatch(/branch 1 .* divides by 10 but sums 9/);
  });

  it('still CATCHES an item no branch covers (union check)', () => {
    const r = checkScoringArithmetic(
      form(`if(${ROLE}, (${sum(1, 10)}) * 100 div 10, (${sum(11, 19)}) * 100 div 9)`),
    );
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toEqual(['missing-term']);
    expect(r.findings[0].detail).toMatch(/q20_score/);
  });

  it('flattens a nested if() — three banks', () => {
    const r = checkScoringArithmetic(
      form(
        `if(${ROLE}, (${sum(1, 5)}) * 100 div 5, if(/data/role = 'sup', (${sum(6, 10)}) * 100 div 5, (${sum(11, 15)}) * 100 div 4))`,
        15,
      ),
    );
    assertChecked(r);
    const f = r.findings.filter((x) => x.kind === 'denominator-mismatch');
    expect(f).toHaveLength(1);
    expect(f[0].detail).toMatch(/branch 3 .* divides by 4 but sums 5/);
  });

  it('still CATCHES a non-partitioned 20-item rollup that divides by 10', () => {
    const r = checkScoringArithmetic(form(`(${sum(1, 20)}) * 100 div 10`));
    assertChecked(r);
    expect(r.findings.map((f) => f.kind)).toContain('denominator-mismatch');
    expect(r.findings.find((f) => f.kind === 'denominator-mismatch')!.detail).toMatch(/20 scored item/);
  });

  it('does not treat if(...) + x as a partition', () => {
    const r = checkScoringArithmetic(
      form(`if(${ROLE}, 0, 0) + (${sum(1, 20)}) * 100 div 10`),
    );
    assertChecked(r);
    expect(r.findings.find((f) => f.kind === 'denominator-mismatch')!.detail).toMatch(/20 scored item/);
  });
});
