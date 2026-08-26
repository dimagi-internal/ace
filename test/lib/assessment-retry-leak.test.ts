/**
 * dimagi-internal/ace#1041 — the retry guidance hands the worker the answer.
 *
 * `_app-component-library.md § assessment-gate` clause (e) said only "give a
 * failing FLW retry guidance", and nothing forbade that guidance from STATING
 * the correct answer. So the natural authoring of "retry guidance" re-teaches
 * by restating the right answer and then invites another attempt — and with no
 * attempt limit, a worker who fails once is shown the answer and passes on
 * attempt 2. The `user_score >= 80` wiring is intact and completely inert.
 *
 * Live (bednet-spot-check/20260729-0002, Nova app 8c758d89): the built
 * `fail_msg` read
 *
 *   "That was not correct. Connect allows you to earn payments for verified
 *    service deliveries. Go back to the question and answer it again…"
 *
 * while the correct option was "Connect allows you to earn payments for
 * verified service deliveries". `pdd-to-learn-app-eval` called it the finding
 * that mattered most. NOT a one-off: the golden run it forked from
 * (20260706-0649) carries the identical leak, so the class shipped through at
 * least two runs — including one promoted to golden.
 *
 * Distinct vector from ace#1014 (items answerable COLD): this one bites even
 * when the bank discriminates perfectly, because the retry path leaks the key.
 */
import { describe, it, expect } from 'vitest';

import { checkAssessmentRetryLeak, formatRetryLeakReport } from '../../lib/assessment-retry-leak.js';

import { assertChecked, assertUnable } from '../../lib/check-outcome.js';
/**
 * A one-item score-gated quiz in the shape ACE builds: `value == label` on the
 * options (so the scoring calculate can compare against the literal answer
 * text), a `user_score` calculate, and score-conditional result labels.
 */
function quizXml(opts: { failText: string; passText?: string }): string {
  return `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head>
    <model>
      <instance><data>
        <q1/><q1_score/><user_score/><pass_msg/><fail_msg/>
      </data></instance>
      <bind nodeset="/data/q1" type="select1" required="true()"/>
      <bind nodeset="/data/q1_score" calculate="if(/data/q1 = 'Connect allows you to earn payments for verified service deliveries', 100, 0)"/>
      <bind nodeset="/data/user_score" calculate="/data/q1_score"/>
      <bind nodeset="/data/pass_msg" relevant="/data/user_score &gt;= 80"/>
      <bind nodeset="/data/fail_msg" relevant="/data/user_score &lt; 80"/>
    </model>
  </h:head>
  <h:body>
    <select1 ref="/data/q1">
      <label>What does Connect pay you for?</label>
      <item><label>Connect allows you to earn payments for verified service deliveries</label>
            <value>Connect allows you to earn payments for verified service deliveries</value></item>
      <item><label>Connect pays a monthly salary</label><value>Connect pays a monthly salary</value></item>
    </select1>
    <trigger ref="/data/pass_msg"><label>${opts.passText ?? 'Well done — you passed.'}</label></trigger>
    <trigger ref="/data/fail_msg"><label>${opts.failText}</label></trigger>
  </h:body>
</h:html>`;
}

describe('checkAssessmentRetryLeak (#1041)', () => {
  it('flags the live bednet fail_msg, which restates the correct answer verbatim', () => {
    const report = checkAssessmentRetryLeak(
      quizXml({
        failText:
          'That was not correct. Connect allows you to earn payments for verified service deliveries. Go back to the question and answer it again to pass Connect Basics and unlock bednet spot-check visits.',
      }),
    );
    assertChecked(report);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].label).toBe('/data/fail_msg');
    expect(report.findings[0].leaked).toContain('earn payments for verified service deliveries');
  });

  it('passes a retry message that points back at the module content instead', () => {
    const report = checkAssessmentRetryLeak(
      quizXml({
        failText:
          'That was not correct. Re-read the "How Connect pays you" section of this module, then answer again.',
      }),
    );
    assertChecked(report);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does NOT flag the PASS label for containing the answer', () => {
    // A pass message may legitimately restate what the worker got right; only
    // the retry path can be used to guess the next attempt.
    const report = checkAssessmentRetryLeak(
      quizXml({
        failText: 'Not quite — review the module and try again.',
        passText:
          'Correct: Connect allows you to earn payments for verified service deliveries.',
      }),
    );
    assertChecked(report);
    expect(report.findings).toEqual([]);
  });

  it('is case- and whitespace-insensitive, so a reworded restatement still trips it', () => {
    const report = checkAssessmentRetryLeak(
      quizXml({
        failText:
          'Not quite. Remember: connect allows you to EARN PAYMENTS   for verified service deliveries. Try again.',
      }),
    );
    assertChecked(report);
    expect(report.findings).toHaveLength(1);
  });

  it('is UNABLE, not clean, on a form with no score-conditional labels', () => {
    const plain = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head><model>
    <instance><data><name/></data></instance>
    <bind nodeset="/data/name" type="string"/>
  </model></h:head>
  <h:body><input ref="/data/name"><label>Your name</label></input></h:body>
</h:html>`;
    const report = checkAssessmentRetryLeak(plain);
    // There is no `ok` on this branch to misread — that is the point of
    // `CheckOutcome` (ace#1634). It must also SAY why, and the rendered
    // report must not read as a pass.
    expect(report.status).toBe('unable');
    assertUnable(report);
    expect(report.reason).toMatch(/score-gated result label/i);
    const text = formatRetryLeakReport(report);
    expect(text).toMatch(/UNABLE TO CHECK/);
    expect(text).toMatch(/NOT a pass/);
    // No green-looking word anywhere: "clean" is what the checked-and-fine
    // branch says, and "not applicable" is the benign phrasing three prior
    // instances of this class were signed off under.
    expect(text).not.toMatch(/\bclean\b/i);
    expect(text).not.toMatch(/not applicable/i);
  });

  it('reports which option leaked so the fix is obvious', () => {
    const report = checkAssessmentRetryLeak(
      quizXml({ failText: 'Wrong. Connect pays a monthly salary is not it; the answer is Connect allows you to earn payments for verified service deliveries.' }),
    );
    assertChecked(report);
    const text = formatRetryLeakReport(report);
    expect(text).toMatch(/fail_msg/);
    expect(text).toMatch(/earn payments/);
  });
});

/**
 * dimagi-internal/ace#1332 — the check was structurally blind on every
 * RELEASED CCZ, which is the only artifact `app-release-qa` ever has.
 *
 * Observed on bednet-check-2-visit/20260814-0856 (Learn app
 * c0d7027316bc46f8b4fdf4b47fd8d90b, build 8e684b6a24bb447998f2fe3a4cd08926,
 * form modules-1/forms-1.xml — a genuine 100%-pass score gate): the report
 * came back `checked=false, leaks=0`, i.e. "not applicable", on a form that
 * carries a score-gated fail branch. Three independent defects, any one
 * sufficient:
 *
 *  1. `failBranchNodesets` only matched `<` / `<=`. The released bind is
 *     `relevant="not(/data/user_score >= 100)"` — semantically less-than,
 *     syntactically a negated GTE. `not(...)` around `>`/`>=` is an entirely
 *     ordinary way to author the retry branch.
 *  2. `labelTextFor` read inline `<label>` text. CommCare's XForm compiler
 *     moves ALL label text into `<itext>`, leaving
 *     `<label ref="jr:itext('result_retry-label')"/>` whose textContent is ''.
 *     The loop then `continue`d — silently, so blind was indistinguishable
 *     from clean.
 *  3. The answer key in a compiled select1 is the option VALUE (`'c'`), not
 *     its prose. `includes('c')` is true of almost any sentence, so naively
 *     fixing 1 and 2 would have turned a false negative into a guaranteed
 *     false positive.
 *
 * The fixture below is the released shape: itext-ref labels, a negated-GTE
 * fail branch, and single-letter option values.
 */
describe('compiled-CCZ forms (#1332)', () => {
  const compiled = (retryValue: string) => `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <model>
      <instance><data>
        <q1/><user_score/><result_pass/><result_retry/>
      </data></instance>
      <itext>
        <translation lang="en" default="">
          <text id="q1-label"><value>Where should the net be hung?</value></text>
          <text id="q1-a-label"><value>Over the doorway</value></text>
          <text id="q1-c-label"><value>Over the sleeping area</value></text>
          <text id="result_pass-label"><value>Passed. Well done.</value></text>
          <text id="result_retry-label"><value>${retryValue}</value></text>
        </translation>
      </itext>
      <bind nodeset="/data/user_score" calculate="if(/data/q1 = 'c', 100, 0)"/>
      <bind nodeset="/data/result_pass" relevant="/data/user_score &gt;= 100"/>
      <bind nodeset="/data/result_retry" relevant="not(/data/user_score &gt;= 100)"/>
    </model>
  </h:head>
  <h:body>
    <select1 ref="/data/q1">
      <label ref="jr:itext('q1-label')"/>
      <item><label ref="jr:itext('q1-a-label')"/><value>a</value></item>
      <item><label ref="jr:itext('q1-c-label')"/><value>c</value></item>
    </select1>
    <trigger ref="/data/result_pass" appearance="minimal"><label ref="jr:itext('result_pass-label')"/></trigger>
    <trigger ref="/data/result_retry" appearance="minimal"><label ref="jr:itext('result_retry-label')"/></trigger>
  </h:body>
</h:html>`;

  it('recognises a negated-GTE fail branch, so the check actually applies', () => {
    const r = checkAssessmentRetryLeak(compiled('Go back and read the module again.'));
    assertChecked(r);
  });

  it('passes the real bednet-check-2-visit form: retry points at the module, names no answer', () => {
    const r = checkAssessmentRetryLeak(
      compiled(
        'Not passed this time. Go back to the training and read it again from the start. ' +
          'There is no limit on attempts.',
      ),
    );
    assertChecked(r);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.blind).toEqual([]);
  });

  it('catches a leak stated in the OPTION PROSE, which is what a worker actually reads', () => {
    const r = checkAssessmentRetryLeak(
      compiled('Not quite — the net goes over the sleeping area. Try again.'),
    );
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].label).toBe('/data/result_retry');
    expect(r.findings[0].leaked).toBe('Over the sleeping area');
  });

  it('does NOT fire on the bare option value — "c" appears in almost any prose', () => {
    const r = checkAssessmentRetryLeak(compiled('Check the course content once more.'));
    assertChecked(r);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('reports BLIND rather than clean when a fail-branch label cannot be resolved', () => {
    const orphan = compiled('x').replace(
      `<text id="result_retry-label"><value>x</value></text>`,
      '',
    );
    const r = checkAssessmentRetryLeak(orphan);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.blind.join(' ')).toMatch(/result_retry/);
    expect(formatRetryLeakReport(r)).toMatch(/BLIND/);
  });

  it('matches a leak in any locale, not just the default one', () => {
    const trilingual = compiled('Retournez au module.').replace(
      '</itext>',
      `<translation lang="fr">
         <text id="q1-c-label"><value>Au-dessus du couchage</value></text>
         <text id="result_retry-label"><value>Le filet va au-dessus du couchage. Réessayez.</value></text>
       </translation></itext>`,
    );
    const r = checkAssessmentRetryLeak(trilingual);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings[0].leaked).toBe('Au-dessus du couchage');
  });

  it('still reads an inline <label> — the authoring-time blueprint shape keeps working', () => {
    const r = checkAssessmentRetryLeak(`<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head><model>
    <bind nodeset="/data/user_score" calculate="if(/data/q1 = 'over the sleeping area', 100, 0)"/>
    <bind nodeset="/data/fail_msg" relevant="/data/user_score &lt; 80"/>
  </model></h:head>
  <h:body>
    <trigger ref="/data/fail_msg"><label>Remember: over the sleeping area. Try again.</label></trigger>
  </h:body>
</h:html>`);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings[0].leaked).toBe('over the sleeping area');
  });
});

/**
 * dimagi-internal/ace#1576 — third instance of the #1332/#1538 class: the
 * checker reports a benign "not applicable" on the exact artifact it exists
 * to gate.
 *
 * `failBranchNodesets` recognised `< N`, `<= N` and `not(... >= N)` — but not
 * `!= N`. That is not an exotic spelling: it is the NATURAL one whenever the
 * passing score is 100. With a 0–100 score and a 100% gate there is no
 * headroom, so the pass/retry pair compiles to `>= 100` / `!= 100` rather than
 * `>= 80` / `< 80`, and every 100%-gated assessment ACE ships went unchecked.
 *
 * Observed live on bednet-check-2-visit/20260820-0832 (Learn app
 * 923c2f1eb6784015b441ab31d67486e2, released build v5, `modules-1/forms-3.xml`):
 *
 *   <bind nodeset="/data/result_pass"  relevant="/data/user_score &gt;= 100"/>
 *   <bind nodeset="/data/result_retry" relevant="/data/user_score != 100"/>
 *
 * The shipped checker returned `checked: false`. Rewriting ONLY the operator
 * (`!= 100` → `< 100`, identical at a 100 maximum) returned
 * `checked: true, ok: true, blind: []` — it could resolve the form completely.
 * It simply never looked. That app happened to be clean; `app-release-qa`
 * could not have told the difference, because a LEAKING label on a `!= 100`
 * gate reported the same `checked: false` (second case below).
 */
describe('inequality fail branches (#1576)', () => {
  /** The released shape, with the fail branch's `relevant` parameterised. */
  const gated = (failRelevant: string, retryValue: string) => `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa">
  <h:head>
    <model>
      <instance><data><q1/><user_score/><result_pass/><result_retry/></data></instance>
      <itext>
        <translation lang="en" default="">
          <text id="q1-label"><value>Where should the net be hung?</value></text>
          <text id="q1-a-label"><value>Over the doorway</value></text>
          <text id="q1-c-label"><value>Over the sleeping area</value></text>
          <text id="result_pass-label"><value>Passed. Well done.</value></text>
          <text id="result_retry-label"><value>${retryValue}</value></text>
        </translation>
      </itext>
      <bind nodeset="/data/user_score" calculate="if(/data/q1 = 'c', 100, 0)"/>
      <bind nodeset="/data/result_pass" relevant="/data/user_score &gt;= 100"/>
      <bind nodeset="/data/result_retry" relevant="${failRelevant}"/>
    </model>
  </h:head>
  <h:body>
    <select1 ref="/data/q1">
      <label ref="jr:itext('q1-label')"/>
      <item><label ref="jr:itext('q1-a-label')"/><value>a</value></item>
      <item><label ref="jr:itext('q1-c-label')"/><value>c</value></item>
    </select1>
    <trigger ref="/data/result_pass" appearance="minimal"><label ref="jr:itext('result_pass-label')"/></trigger>
    <trigger ref="/data/result_retry" appearance="minimal"><label ref="jr:itext('result_retry-label')"/></trigger>
  </h:body>
</h:html>`;

  const CLEAN_RETRY =
    'Not passed this time. Go back to the training and read it again from the start.';
  const LEAKING_RETRY = 'Not quite — the net goes over the sleeping area. Try again.';

  it('recognises a `!= N` fail branch, so the check actually applies', () => {
    const r = checkAssessmentRetryLeak(gated('/data/user_score != 100', CLEAN_RETRY));
    assertChecked(r);
    expect(r.ok).toBe(true);
    expect(r.blind).toEqual([]);
  });

  it('CATCHES a leak on a `!= N` gate — the whole point, and previously inert', () => {
    const r = checkAssessmentRetryLeak(gated('/data/user_score != 100', LEAKING_RETRY));
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].label).toBe('/data/result_retry');
    expect(r.findings[0].leaked).toBe('Over the sleeping area');
  });

  it('recognises the symmetric `not(... = N)` spelling', () => {
    const r = checkAssessmentRetryLeak(gated('not(/data/user_score = 100)', LEAKING_RETRY));
    assertChecked(r);
    expect(r.findings).toHaveLength(1);
  });

  it('tolerates whitespace and a decimal threshold around the operator', () => {
    const r = checkAssessmentRetryLeak(
      gated('/data/user_score  !=  100.0', LEAKING_RETRY).replace(
        'relevant="/data/user_score &gt;= 100"',
        'relevant="/data/user_score &gt;= 100.0"',
      ),
    );
    assertChecked(r);
    expect(r.findings).toHaveLength(1);
  });

  it('treats `!= N` as the fail branch ONLY when N is the passing threshold', () => {
    // `user_score != 0` is "scored something", not "did not pass" — the gate
    // here is 100. Matching every `!=` on a score node regardless of value
    // would invent a fail branch that does not exist.
    const r = checkAssessmentRetryLeak(gated('/data/user_score != 0', LEAKING_RETRY));
    expect(r.status).toBe('unable');
  });

  it('still recognises the operators #1332 covered', () => {
    expect(checkAssessmentRetryLeak(gated('/data/user_score &lt; 100', CLEAN_RETRY)).status).toBe(
      'checked',
    );
    expect(
      checkAssessmentRetryLeak(gated('not(/data/user_score &gt;= 100)', CLEAN_RETRY)).status,
    ).toBe('checked');
  });
});
