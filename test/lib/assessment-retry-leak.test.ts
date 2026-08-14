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
    expect(report.leaks).toHaveLength(1);
    expect(report.leaks[0].label).toBe('/data/fail_msg');
    expect(report.leaks[0].leaked).toContain('earn payments for verified service deliveries');
  });

  it('passes a retry message that points back at the module content instead', () => {
    const report = checkAssessmentRetryLeak(
      quizXml({
        failText:
          'That was not correct. Re-read the "How Connect pays you" section of this module, then answer again.',
      }),
    );
    expect(report.leaks).toEqual([]);
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
    expect(report.leaks).toEqual([]);
  });

  it('is case- and whitespace-insensitive, so a reworded restatement still trips it', () => {
    const report = checkAssessmentRetryLeak(
      quizXml({
        failText:
          'Not quite. Remember: connect allows you to EARN PAYMENTS   for verified service deliveries. Try again.',
      }),
    );
    expect(report.leaks).toHaveLength(1);
  });

  it('is inert on a form with no score-conditional labels (nothing to leak into)', () => {
    const plain = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
  <h:head><model>
    <instance><data><name/></data></instance>
    <bind nodeset="/data/name" type="string"/>
  </model></h:head>
  <h:body><input ref="/data/name"><label>Your name</label></input></h:body>
</h:html>`;
    const report = checkAssessmentRetryLeak(plain);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(false);
  });

  it('reports which option leaked so the fix is obvious', () => {
    const report = checkAssessmentRetryLeak(
      quizXml({ failText: 'Wrong. Connect pays a monthly salary is not it; the answer is Connect allows you to earn payments for verified service deliveries.' }),
    );
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
    expect(r.checked).toBe(true);
  });

  it('passes the real bednet-check-2-visit form: retry points at the module, names no answer', () => {
    const r = checkAssessmentRetryLeak(
      compiled(
        'Not passed this time. Go back to the training and read it again from the start. ' +
          'There is no limit on attempts.',
      ),
    );
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.leaks).toEqual([]);
    expect(r.blind).toEqual([]);
  });

  it('catches a leak stated in the OPTION PROSE, which is what a worker actually reads', () => {
    const r = checkAssessmentRetryLeak(
      compiled('Not quite — the net goes over the sleeping area. Try again.'),
    );
    expect(r.ok).toBe(false);
    expect(r.leaks).toHaveLength(1);
    expect(r.leaks[0].label).toBe('/data/result_retry');
    expect(r.leaks[0].leaked).toBe('Over the sleeping area');
  });

  it('does NOT fire on the bare option value — "c" appears in almost any prose', () => {
    const r = checkAssessmentRetryLeak(compiled('Check the course content once more.'));
    expect(r.ok).toBe(true);
    expect(r.leaks).toEqual([]);
  });

  it('reports BLIND rather than clean when a fail-branch label cannot be resolved', () => {
    const orphan = compiled('x').replace(
      `<text id="result_retry-label"><value>x</value></text>`,
      '',
    );
    const r = checkAssessmentRetryLeak(orphan);
    expect(r.checked).toBe(true);
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
    expect(r.ok).toBe(false);
    expect(r.leaks[0].leaked).toBe('Au-dessus du couchage');
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
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.leaks[0].leaked).toBe('over the sleeping area');
  });
});
