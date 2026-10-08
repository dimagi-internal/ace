import { describe, expect, it } from 'vitest';
import { classifyCaseChoiceProbe, remedyFor } from '../../scripts/probe-nova-case-choices.js';
import {
  attendanceRootFields,
  attendanceRosterFields,
  attendanceUpdateOperation,
  CHILDREN_OF_SELECTED_CASE_FILTER,
} from '../../lib/case-choice-attendance.js';

/**
 * voidcraft-labs/commcare-nova#728 (shipped in Nova PR #730, adopted 2026-10-08).
 * The probe's network half needs NOVA_API_KEY; its verdict and the recipe it
 * builds do not. These pin the two things that make the attendance checklist
 * safe: choices scoped to the selected group, and a roster that survives
 * deselection.
 */
const EXPECTED = ['m1', 'm2', 'm3'];
const base = { bound: true, offered: EXPECTED, expected: EXPECTED, deselected: 'm2' };

describe('classifyCaseChoiceProbe', () => {
  it('the observed 2026-10-08 state → works', () => {
    expect(classifyCaseChoiceProbe({ ...base, rosterAttended: { m1: 'yes', m2: 'no', m3: 'yes' } })).toBe('works');
  });

  it('a source that does not read back → not-bound', () => {
    expect(classifyCaseChoiceProbe({ ...base, bound: false, offered: [], rosterAttended: {} })).toBe('not-bound');
  });

  it('offering another group or a closed member → wrong-behaviour', () => {
    expect(
      classifyCaseChoiceProbe({
        ...base,
        offered: [...EXPECTED, 'm4'],
        rosterAttended: { m1: 'yes', m2: 'no', m3: 'yes' },
      }),
    ).toBe('wrong-behaviour');
  });

  it('a roster that dropped the deselected member (a selection-driven repeat) → wrong-behaviour', () => {
    // The shape commcare-nova#728 itself proposed: rows driven by the checklist.
    expect(classifyCaseChoiceProbe({ ...base, rosterAttended: { m1: 'yes', m3: 'yes' } })).toBe('wrong-behaviour');
  });

  it('a deselected member still marked attended → wrong-behaviour', () => {
    expect(classifyCaseChoiceProbe({ ...base, rosterAttended: { m1: 'yes', m2: 'yes', m3: 'yes' } })).toBe(
      'wrong-behaviour',
    );
  });

  it('every non-working verdict names the fallback and the upstream issue', () => {
    for (const v of ['wrong-behaviour', 'not-bound'] as const) {
      expect(remedyFor(v)).toMatch(/yes\/no question/);
      expect(remedyFor(v)).toMatch(/commcare-nova#728/);
    }
  });
});

describe('lib/case-choice-attendance recipe', () => {
  const spec = { memberCaseType: 'member', writes: { last_attended: '#form/session_date' } };

  it('sources the checklist from cases, open members of the selected case only', () => {
    const [checklist] = attendanceRootFields(spec) as any[];
    expect(checklist.kind).toBe('multi_select');
    expect(checklist.optionsSource).toMatchObject({ kind: 'cases', caseType: 'member', labelProperty: 'case_name' });
    // Omitting the status clause offers closed records still on the device.
    expect(CHILDREN_OF_SELECTED_CASE_FILTER).toMatch(/#row\/status = 'open'/);
    expect(CHILDREN_OF_SELECTED_CASE_FILTER).toMatch(/#case\/case_id/);
  });

  it('drives the roster from a casedb query, never from the checklist answer', () => {
    const roster = (attendanceRootFields(spec) as any[])[1];
    expect(roster.repeat.mode).toBe('query_bound');
    expect(roster.repeat.ids_query).not.toMatch(/count-selected|selected-at|#form\//);
    expect(roster.label).toBeUndefined();
  });

  it('conditions the update on a hidden answer, because selected() is refused in record expressions', () => {
    const op = (attendanceUpdateOperation(spec, 'roster-uuid') as any).operation;
    expect(op.condition).not.toMatch(/selected\(/);
    expect(op.condition).toBe("#form/roster/attended = 'yes'");
    expect(op.forEach).toEqual({ repeat: 'roster-uuid' });
    expect(op.writes).toEqual([{ property: 'last_attended', value: '#form/session_date' }]);
    const attended = (attendanceRosterFields(spec) as any[]).find((f) => f.id === 'attended');
    expect(attended.calculate).toMatch(/selected\(#form\/present, #form\/roster\/member_id\)/);
  });
});
