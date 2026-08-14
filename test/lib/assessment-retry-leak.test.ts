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
