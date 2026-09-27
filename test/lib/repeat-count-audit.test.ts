/**
 * Tests for `lib/repeat-count-audit.ts` (dimagi-internal/ace#2517).
 *
 * Positive cases are REAL compiled XML from the released Deliver CCZ of
 * `spark-facilitator/20260926-1413` (HQ app 3b7ec74d9883452a8747796e2f777262,
 * build a556b0725f4d465cbe3377fa51d6e382, connect-ace-prod):
 *   - the Participant Feedback form (modules-3/forms-0.xml), stored whole as a
 *     fixture;
 *   - the four lines quoted in ace#2517 from the Community Meeting Record
 *     (modules-1/forms-0.xml), verbatim, wrapped in a minimal form.
 * Negative controls: the same excerpt with a `calculate` on the count helper,
 * with an `xforms-value-changed` writer, with a casedb snapshot, and two real
 * released forms whose repeats are user_controlled.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  auditRepeatCounts,
  formatRepeatCountAudit,
  workerAnsweredNodes,
} from '../../lib/repeat-count-audit.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'ccz');
const FEEDBACK = readFileSync(
  join(FIXTURES, 'spark-facilitator-participant-feedback-20260926.xml'),
  'utf8',
);
const HH_VISIT = readFileSync(join(FIXTURES, 'hh-poverty-targeting-visit.xml'), 'utf8');
const PGT_SURVEY = readFileSync(join(FIXTURES, 'poverty-graduation-targeting-survey.xml'), 'utf8');

// Verbatim from ace#2517 (modules-1/forms-0.xml of the released CCZ).
const REPEAT_LINE =
  '<repeat nodeset="/data/community_meeting_activities" jr:count="/data/__nova_count_community_meeting_activities" jr:noAddRemove="true()">';
const BIND_LINE =
  '<bind nodeset="/data/__nova_count_community_meeting_activities" type="xsd:string"/>';
const SETVALUE_LINE =
  '<setvalue event="xforms-ready" ref="/data/__nova_count_community_meeting_activities" value="string(/data/activities/activity_number)"/>';
const INPUT_LINE = '<input ref="/data/activities/activity_number">';

function form(opts: { bind?: string; setvalues?: string[]; input?: string } = {}): string {
  const bind = opts.bind ?? BIND_LINE;
  const setvalues = opts.setvalues ?? [SETVALUE_LINE];
  const input = opts.input ?? INPUT_LINE;
  return `<h:html xmlns:jr="http://openrosa.org/javarosa"><h:head><model>
<instance><data><activities><activity_number/></activities>
<__nova_count_community_meeting_activities/>
<community_meeting_activities jr:template=""><activity_type/></community_meeting_activities>
</data></instance>
<bind nodeset="/data/activities/activity_number" type="xsd:int" required="true()"/>
${bind}
${setvalues.join('\n')}
</model></h:head><h:body>
<group ref="/data/activities">${input}<label>How many activities?</label></input></group>
<group ref="/data/community_meeting_activities">${REPEAT_LINE}
<select1 ref="/data/community_meeting_activities/activity_type"><label>Which activity?</label></select1>
</repeat></group>
</h:body></h:html>`;
}

describe('the shipped Community Meeting Record excerpt — the defect', () => {
  const result = auditRepeatCounts(form());

  it('flags the count-bound repeat whose count snapshots an unanswered input', () => {
    expect(result.countBound).toBe(1);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v.repeat).toBe('/data/community_meeting_activities');
    expect(v.countRef).toBe('/data/__nova_count_community_meeting_activities');
    expect(v.workerSources).toEqual(['/data/activities/activity_number']);
    expect(v.writers).toEqual([
      { event: 'xforms-ready', value: 'string(/data/activities/activity_number)' },
    ]);
  });

  it('is independent of setvalue attribute order', () => {
    const refFirst =
      '<setvalue ref="/data/__nova_count_community_meeting_activities" value="string(/data/activities/activity_number)" event="xforms-ready"/>';
    expect(auditRepeatCounts(form({ setvalues: [refFirst] })).violations).toHaveLength(1);
  });

  it('follows a calculated intermediate back to the worker answer', () => {
    const xml = form({
      setvalues: [
        '<setvalue event="xforms-ready" ref="/data/__nova_count_community_meeting_activities" value="/data/n_calc"/>',
      ],
    }).replace(
      BIND_LINE,
      `${BIND_LINE}\n<bind nodeset="/data/n_calc" calculate="/data/activities/activity_number + 0"/>`,
    );
    expect(workerAnsweredNodes(xml).has('/data/n_calc')).toBe(true);
    expect(auditRepeatCounts(xml).violations[0]?.workerSources).toEqual(['/data/n_calc']);
  });

  it('formats a BLOCKER naming the repeat and its source', () => {
    const text = formatRepeatCountAudit(result, 'modules-1/forms-0.xml');
    expect(text).toMatch(/^\[BLOCKER\] modules-1\/forms-0\.xml: 1 of 1/);
    expect(text).toContain('/data/community_meeting_activities');
    expect(text).toContain('<- /data/activities/activity_number');
  });
});

describe('the shipped Participant Feedback form (whole, real)', () => {
  it('flags `participants`, counted from the people_to_ask input', () => {
    const result = auditRepeatCounts(FEEDBACK);
    expect(result.countBound).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].repeat).toBe('/data/participants');
    expect(result.violations[0].workerSources).toEqual(['/data/people_to_ask']);
  });
});

describe('negative controls — live counts pass', () => {
  it('a calculate on the count helper tracks the answer', () => {
    const bind =
      '<bind nodeset="/data/__nova_count_community_meeting_activities" type="xsd:string" calculate="string(/data/activities/activity_number)"/>';
    const result = auditRepeatCounts(form({ bind }));
    expect(result.countBound).toBe(1);
    expect(result.violations).toEqual([]);
    expect(formatRepeatCountAudit(result, 'f.xml')).toMatch(/^\[PASS\]/);
  });

  it('an xforms-value-changed writer re-writes the count', () => {
    const changed =
      '<setvalue event="xforms-value-changed" ref="/data/__nova_count_community_meeting_activities" value="string(/data/activities/activity_number)"/>';
    expect(auditRepeatCounts(form({ setvalues: [SETVALUE_LINE, changed] })).violations).toEqual([]);
  });

  it('a snapshot of a case property is the legitimate count_bound use', () => {
    const casedb =
      '<setvalue event="xforms-ready" ref="/data/__nova_count_community_meeting_activities" value="instance(\'casedb\')/casedb/case[@case_id = instance(\'commcaresession\')/session/data/case_id]/n_members"/>';
    expect(auditRepeatCounts(form({ setvalues: [casedb] })).violations).toEqual([]);
  });

  it('a jr-insert snapshot (nested repeat) is not judged', () => {
    const insert = SETVALUE_LINE.replace('xforms-ready', 'jr-insert');
    expect(auditRepeatCounts(form({ setvalues: [insert] })).violations).toEqual([]);
  });

  it('a jr:count pointing straight at the question (Vellum shape) passes', () => {
    const xml = form().replace(
      'jr:count="/data/__nova_count_community_meeting_activities"',
      'jr:count="/data/activities/activity_number"',
    );
    expect(auditRepeatCounts(xml).violations).toEqual([]);
  });

  it('released forms with user_controlled repeats have nothing to flag', () => {
    for (const xml of [HH_VISIT, PGT_SURVEY]) {
      const r = auditRepeatCounts(xml);
      expect(r.repeatsChecked).toBe(1);
      expect(r.countBound).toBe(0);
      expect(r.violations).toEqual([]);
    }
  });
});
