/**
 * dimagi-internal/ace#2590 — a PDD metric's denominator is READ by the paid
 * Deliver form but never SUBMITTED, so the indicator is not computable in
 * Connect.
 *
 * Live on spark-facilitator/20261001-2208 (Nova 5b0aa4c3…, HQ v9), form
 * "Community Meeting Record". PDD §8.2 S1 = "Households represented ÷ enrolled
 * number_of_households". `get_form` read-back:
 *
 *   who_came/hh_represented_at_the_meeting.validate.expr:
 *     ". >= 0 and . <= #community/number_of_households"
 *
 * and no field — visible or hidden — whose calculate is
 * `#community/number_of_households`. The nine hidden case-write mirrors were
 * Total_Attendance, Total_Participation, date_of_meeting,
 * last_community_meeting_date, last_male_attendance, last_female_attendance,
 * pilot_fcap_step, step_meeting_index, pilot_complete.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkMetricTermsSubmitted,
  formatMetricTermsReport,
  type MetricTerm,
  type PaidFormField,
} from '../../lib/metric-terms-submitted.js';
import { assertChecked, assertUnable } from '../../lib/check-outcome.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const hidden = (id: string, calculate: string): PaidFormField => ({ id, kind: 'hidden', calculate });

/** The S1-shaped paid form as shipped: denominator read in a validate, never submitted. */
const SHIPPED: PaidFormField[] = [
  {
    id: 'who_came',
    kind: 'group',
    children: [
      { id: 'male_attendance', kind: 'int' },
      { id: 'female_attendance', kind: 'int' },
      {
        id: 'hh_represented_at_the_meeting',
        kind: 'int',
        validate: { expr: '. >= 0 and . <= #community/number_of_households' },
      },
    ],
  },
  hidden('Total_Attendance', '#form/who_came/male_attendance + #form/who_came/female_attendance'),
  hidden('Total_Participation', '#form/Total_Attendance'),
  hidden('date_of_meeting', 'today()'),
  hidden('last_community_meeting_date', '#form/date_of_meeting'),
  hidden('last_male_attendance', '#form/who_came/male_attendance'),
  hidden('last_female_attendance', '#form/who_came/female_attendance'),
  hidden('pilot_fcap_step', '#community/pilot_fcap_step'),
  hidden('step_meeting_index', "if(#community/step_meeting_index = '', 0, #community/step_meeting_index) + 1"),
  hidden('pilot_complete', "if(#community/pilot_fcap_step = 24, 'yes', 'no')"),
];

const S1: MetricTerm[] = [
  {
    metric: 'S1',
    role: 'numerator',
    term: 'Households represented',
    source: { kind: 'field', fieldId: 'hh_represented_at_the_meeting' },
  },
  {
    metric: 'S1',
    role: 'denominator',
    term: 'enrolled number_of_households',
    source: { kind: 'case', property: 'number_of_households', caseType: 'community' },
  },
];

describe('checkMetricTermsSubmitted (ace#2590)', () => {
  it('flags the shipped S1 denominator: read in a validate, never submitted', () => {
    const r = checkMetricTermsSubmitted(S1, SHIPPED);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    expect(f.metric).toBe('S1');
    expect(f.role).toBe('denominator');
    expect(f.reason).toBe('case-not-mirrored');
    expect(f.ref).toBe('#community/number_of_households');
    expect(f.readsAt).toEqual(['hh_represented_at_the_meeting.validate.expr']);
    // The numerator IS submitted — only the denominator is the defect.
    expect(r.submitted.map((s) => s.fieldId)).toEqual(['hh_represented_at_the_meeting']);
    const text = formatMetricTermsReport(r);
    expect(text).toContain('never submits it');
    expect(text).toContain('#community/number_of_households');
  });

  it('negative control: passes once the denominator is mirrored as a hidden calculate', () => {
    const fixed = [...SHIPPED, hidden('enrolled_households', '#community/number_of_households')];
    const r = checkMetricTermsSubmitted(S1, fixed);
    assertChecked(r);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.submitted.map((s) => s.fieldId)).toEqual([
      'hh_represented_at_the_meeting',
      'enrolled_households',
    ]);
  });

  it('accepts a blank-guarded mirror and a #case/ spelling', () => {
    const guarded = [
      ...SHIPPED,
      hidden('enrolled_households', "if(#case/number_of_households = '', 0, #case/number_of_households)"),
    ];
    const r = checkMetricTermsSubmitted(S1, guarded);
    assertChecked(r);
    expect(r.ok).toBe(true);
  });

  it('does NOT accept a calculate that combines the property with other data as a mirror', () => {
    // A ratio computed in-form is a different quantity from the denominator;
    // the reading is reported, the term stays unsubmitted.
    const withRatio = [...SHIPPED, hidden('ratio', '#community/number_of_households div #form/Total_Attendance')];
    const r = checkMetricTermsSubmitted(S1, withRatio);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings[0].readsAt).toEqual([
      'hh_represented_at_the_meeting.validate.expr',
      'ratio.calculate',
    ]);
  });

  it('flags a field-sourced term that is absent, or is a container', () => {
    const terms: MetricTerm[] = [
      { metric: 'P1', role: 'numerator', term: 'meetings held', source: { kind: 'field', fieldId: 'meeting_held' } },
      { metric: 'P1', role: 'denominator', term: 'attendance', source: { kind: 'field', fieldId: 'who_came' } },
    ];
    const r = checkMetricTermsSubmitted(terms, SHIPPED);
    assertChecked(r);
    expect(r.findings.map((f) => f.reason)).toEqual(['field-absent', 'field-not-a-value']);
  });

  it('carries external terms through as not computable, and requires a reason', () => {
    const terms: MetricTerm[] = [
      ...S1.slice(0, 1),
      { metric: 'P2', role: 'value', term: 'payments disbursed', source: { kind: 'external', reason: 'payment ledger, not visit data' } },
    ];
    const r = checkMetricTermsSubmitted(terms, SHIPPED);
    assertChecked(r);
    expect(r.ok).toBe(true);
    expect(r.notComputable).toEqual([
      { metric: 'P2', role: 'value', term: 'payments disbursed', reason: 'payment ledger, not visit data' },
    ]);
    expect(formatMetricTermsReport(r)).toContain('NOT COMPUTABLE: P2');
    expect(() =>
      checkMetricTermsSubmitted(
        [{ metric: 'P2', role: 'value', term: 'x', source: { kind: 'external', reason: ' ' } }],
        SHIPPED,
      ),
    ).toThrow(/no reason/);
  });

  it('reports UNABLE — never a pass — with no terms or no form', () => {
    const noTerms = checkMetricTermsSubmitted([], SHIPPED);
    assertUnable(noTerms);
    expect(formatMetricTermsReport(noTerms)).toContain('NOT a pass');
    assertUnable(checkMetricTermsSubmitted(S1, []));
  });
});

/**
 * Grounded on the captured artifact: the verbatim `get_form` read-back of the
 * released paid form from spark-facilitator/20261001-2208.
 */
describe('checkMetricTermsSubmitted on the captured spark-facilitator/20261001-2208 paid form', () => {
  const captured = JSON.parse(
    readFileSync(join(FIXTURES, 'nova/paid-form-spark-20261001-2208.json'), 'utf8'),
  ) as { get_form: { form: { fields: PaidFormField[] } } };
  const fields = captured.get_form.form.fields;

  it('flags the S1 denominator as read-but-never-submitted, naming both reads', () => {
    const r = checkMetricTermsSubmitted(S1, fields);
    assertChecked(r);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.metric, f.role, f.reason])).toEqual([
      ['S1', 'denominator', 'case-not-mirrored'],
    ]);
    expect(r.findings[0].readsAt).toEqual([
      'hh_represented_at_the_meeting.validate.expr',
      'hh_saving.validate.expr',
    ]);
    expect(r.submitted.map((s) => s.fieldId)).toEqual(['hh_represented_at_the_meeting']);
  });

  it('negative control: the same form with enrolled_households mirrored passes', () => {
    const fixed = [...fields, hidden('enrolled_households', '#community/number_of_households')];
    const r = checkMetricTermsSubmitted(S1, fixed);
    assertChecked(r);
    expect(r.ok).toBe(true);
  });
});
