import { describe, expect, it } from 'vitest';
import {
  describeRegisterDiff,
  diffOptionRegister,
  diffRegisterRows,
  parseFixtureRegister,
  parseRegisterDeclaration,
  renderRegisterCsv,
  type BuiltOptionSource,
  type RegisterRow,
} from '../../lib/option-register';

const DECL =
  'meeting_activity from malawi_activities [source: FCAP Structure, Phases, and Activities.pdf] [filtered by step]';

/** The register as Spark's own data has it. */
const REGISTER: RegisterRow[] = [
  { value: 'a01', label: 'Review previous action points', filterKey: '3' },
  { value: 'a02', label: 'Community savings collection', filterKey: '3' },
  { value: 'a03', label: 'Elect committee members', filterKey: '7' },
];

/** The 11 placeholders that actually shipped (ace#1621), abbreviated. */
const PLACEHOLDERS = [
  'attendance_register',
  'review_previous_actions',
  'facilitated_discussion',
  'small_group_work',
  'decision_and_voting',
  'other',
];

describe('parseRegisterDeclaration', () => {
  it('parses field, tag, source and filter', () => {
    const d = parseRegisterDeclaration(DECL);
    expect(d.declared).toBe(true);
    expect(d.field).toBe('meeting_activity');
    expect(d.tag).toBe('malawi_activities');
    expect(d.source).toBe('FCAP Structure, Phases, and Activities.pdf');
    expect(d.filterBy).toBe('step');
    expect(d.problems).toEqual([]);
  });

  it('treats absence, placeholders and n/a as UNDECLARED (the halt signal)', () => {
    for (const raw of [null, undefined, '', '   ', 'n/a', 'TBD', '—', '[activity register]']) {
      expect(parseRegisterDeclaration(raw).declared, JSON.stringify(raw)).toBe(false);
    }
  });

  it('does not mistake a source filename containing " from " for the separator', () => {
    const d = parseRegisterDeclaration(
      'activity from malawi_activities [source: Activities from Spark 2026.pdf]',
    );
    expect(d.field).toBe('activity');
    expect(d.tag).toBe('malawi_activities');
    expect(d.source).toBe('Activities from Spark 2026.pdf');
  });

  it('accepts a flat register with no source or filter', () => {
    const d = parseRegisterDeclaration('activity from malawi_activities');
    expect(d.declared).toBe(true);
    expect(d.filterBy).toBeNull();
    expect(d.source).toBeNull();
    expect(d.problems).toEqual([]);
  });

  it('rejects tags Nova\'s lookup_tables CHECK constraint would reject', () => {
    expect(parseRegisterDeclaration('a from 9bad').problems.join()).toMatch(/not a legal lookup tag/);
    expect(parseRegisterDeclaration('a from has-dash').problems.join()).toMatch(/not a legal lookup tag/);
    expect(parseRegisterDeclaration('a from xmlThing').problems.join()).toMatch(/may not start with "xml"/);
    expect(parseRegisterDeclaration(`a from ${'x'.repeat(33)}`).problems.join()).toMatch(/32-character/);
  });

  it('flags an unparseable declaration rather than silently reading it as absent', () => {
    const d = parseRegisterDeclaration('just some prose about activities');
    expect(d.declared).toBe(true);
    expect(d.problems.join()).toMatch(/unparseable register declaration/);
  });
});

describe('diffOptionRegister', () => {
  const lookupBuild: BuiltOptionSource = {
    kind: 'lookup',
    tag: 'malawi_activities',
    filteredBy: 'step',
  };

  it('passes a correctly bound, correctly filtered register', () => {
    const diff = diffOptionRegister({
      declaration: parseRegisterDeclaration(DECL),
      built: lookupBuild,
      registerRows: REGISTER,
    });
    expect(diff.ok).toBe(true);
    expect(diff.findings).toEqual([]);
  });

  // The negative control: exactly what spark-facilitator/20260820-0817 shipped.
  it('BLOCKS an inline invented option list where a register was declared', () => {
    const diff = diffOptionRegister({
      declaration: parseRegisterDeclaration(DECL),
      built: { kind: 'inline', values: PLACEHOLDERS },
      registerRows: REGISTER,
    });
    expect(diff.ok).toBe(false);
    expect(diff.findings.map((f) => f.code)).toContain('unbound-register');
    const text = describeRegisterDiff(diff).join('\n');
    expect(text).toMatch(/INLINE options/);
    expect(text).toMatch(/malawi_activities/);
    expect(text).toMatch(/not the partner's data/);
  });

  it('does not bury the inline finding under one line per register row', () => {
    const many = Array.from({ length: 78 }, (_, i) => ({
      value: `a${i}`,
      label: `Activity ${i}`,
      filterKey: '1',
    }));
    const diff = diffOptionRegister({
      declaration: parseRegisterDeclaration(DECL),
      built: { kind: 'inline', values: PLACEHOLDERS },
      registerRows: many,
    });
    expect(diff.findings.length).toBeLessThan(5);
  });

  it('HALTS when the PDD declares no register at all (Phase-1 gap, not a licence)', () => {
    const diff = diffOptionRegister({
      declaration: parseRegisterDeclaration(null),
      built: { kind: 'inline', values: PLACEHOLDERS },
      registerRows: REGISTER,
    });
    expect(diff.ok).toBe(false);
    expect(diff.findings[0].code).toBe('undeclared-register');
    expect(diff.findings[0].message).toMatch(/HALT/);
  });

  it('flags a declared-filtered register bound without a filter — the all-24-steps symptom', () => {
    const diff = diffOptionRegister({
      declaration: parseRegisterDeclaration(DECL),
      built: { kind: 'lookup', tag: 'malawi_activities', filteredBy: null },
      registerRows: REGISTER,
    });
    expect(diff.findings.map((f) => f.code)).toContain('unfiltered-register');
    expect(describeRegisterDiff(diff).join()).toMatch(/every partition would show every option/);
  });

  it('flags a binding to the wrong table', () => {
    const diff = diffOptionRegister({
      declaration: parseRegisterDeclaration(DECL),
      built: { kind: 'lookup', tag: 'some_other_table', filteredBy: 'step' },
      registerRows: REGISTER,
    });
    expect(diff.findings.map((f) => f.code)).toContain('wrong-table');
  });

  it('treats an unreadable source as BLOCKING, never as a pass', () => {
    const diff = diffOptionRegister({
      declaration: parseRegisterDeclaration(DECL),
      built: lookupBuild,
      registerRows: null,
    });
    expect(diff.ok).toBe(false);
    expect(diff.findings.map((f) => f.code)).toContain('source-unavailable');
    expect(describeRegisterDiff(diff).join()).toMatch(/unverifiable is not the same as correct/);
  });

  it('flags duplicate value codes in the partner register', () => {
    const diff = diffOptionRegister({
      declaration: parseRegisterDeclaration(DECL),
      built: lookupBuild,
      registerRows: [...REGISTER, { value: 'a01', label: 'Dup', filterKey: '4' }],
    });
    expect(diff.findings.map((f) => f.code)).toContain('malformed-declaration');
  });
});

describe('diffRegisterRows', () => {
  it('passes identical rows', () => {
    expect(diffRegisterRows({ registerRows: REGISTER, builtRows: REGISTER }).ok).toBe(true);
  });

  it('catches invented, missing and relabelled options', () => {
    const built: RegisterRow[] = [
      { value: 'a01', label: 'Review previous action points', filterKey: '3' },
      { value: 'a02', label: 'Savings collection', filterKey: '3' }, // relabelled
      { value: 'zz9', label: 'Made up', filterKey: '3' }, // invented
      // a03 missing
    ];
    const diff = diffRegisterRows({ registerRows: REGISTER, builtRows: built });
    const codes = diff.findings.map((f) => f.code);
    expect(codes).toContain('invented-option');
    expect(codes).toContain('missing-option');
    expect(codes).toContain('relabelled-option');
  });

  it('ignores label case and trailing punctuation, not the partner\'s words', () => {
    const built = [{ value: 'a01', label: 'review previous action points.', filterKey: '3' }];
    const diff = diffRegisterRows({ registerRows: [REGISTER[0]], builtRows: built });
    expect(diff.ok).toBe(true);
  });

  it('catches a re-partitioned option (right label, wrong step)', () => {
    const built = [{ value: 'a01', label: 'Review previous action points', filterKey: '9' }];
    const diff = diffRegisterRows({ registerRows: [REGISTER[0]], builtRows: built });
    expect(diff.ok).toBe(false);
    expect(describeRegisterDiff(diff).join()).toMatch(/re-partitioned/);
  });
});

describe('parseFixtureRegister', () => {
  const XML = `
    <fixture id="item-list:malawi_activities">
      <activity_list>
        <activity><code>a01</code><name>Review previous action points</name><step>3</step></activity>
        <activity><code>a02</code><name>Savings &amp; loans</name><step>3</step></activity>
        <activity><code>a03</code><name><![CDATA[Elect committee]]></name><step>7</step></activity>
      </activity_list>
    </fixture>`;

  it('extracts the partner\'s REAL value codes from fixture XML', () => {
    const rows = parseFixtureRegister(XML, { value: 'code', label: 'name', filterKey: 'step' });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ value: 'a01', label: 'Review previous action points', filterKey: '3' });
  });

  it('decodes entities and CDATA', () => {
    const rows = parseFixtureRegister(XML, { value: 'code', label: 'name', filterKey: 'step' });
    expect(rows[1].label).toBe('Savings & loans');
    expect(rows[2].label).toBe('Elect committee');
  });

  it('skips rows missing a named column rather than inventing a blank code', () => {
    const rows = parseFixtureRegister(
      '<r><code>a01</code></r><r><name>No code</name></r>',
      { value: 'code', label: 'name' },
    );
    expect(rows).toHaveLength(0);
  });
});

describe('renderRegisterCsv', () => {
  it('emits a header plus one row per entry', () => {
    const csv = renderRegisterCsv(REGISTER, {
      value: 'activity_code',
      label: 'activity_name',
      filterKey: 'step',
    });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('activity_code,activity_name,step');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('a01,Review previous action points,3');
  });

  it('quotes cells containing commas or quotes', () => {
    const csv = renderRegisterCsv(
      [{ value: 'a1', label: 'Plan, review and "agree"', filterKey: '1' }],
      { value: 'activity_code', label: 'activity_name', filterKey: 'step' },
    );
    expect(csv).toContain('"Plan, review and ""agree"""');
  });

  it('omits the filter column for a flat register', () => {
    const csv = renderRegisterCsv([{ value: 'a1', label: 'X', filterKey: null }], {
      value: 'activity_code',
      label: 'activity_name',
    });
    expect(csv.trim().split('\n')[0]).toBe('activity_code,activity_name');
  });
});
