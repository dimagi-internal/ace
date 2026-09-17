import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  describeRegisterDiff,
  diffOptionRegister,
  diffRegisterRows,
  parseFixtureRegister,
  parseRegisterDeclaration,
  auditLookupBinds,
  describeLookupBindAudit,
  findDuplicateLookupValues,
  verifyLookupBind,
  type BuiltOptionSource,
  type RegisterRow,
} from '../../lib/option-register';

const HERE = dirname(fileURLToPath(import.meta.url));

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

describe('verifyLookupBind', () => {
  const requested = { tableId: 't-1', valueColumnId: 'c-val', labelColumnId: 'c-lab' };
  const boundReadBack = {
    kind: 'lookup',
    tableId: 't-1',
    valueColumnId: 'c-val',
    labelColumnId: 'c-lab',
  };

  /**
   * `get_lookup_table_rows` in the shape observed live 2026-09-17 — cells keyed
   * by `columnId`, plus the atom's own `complete` flag.
   */
  const rowsOf = (...values: string[]) => ({
    complete: true,
    rows: values.map((v) => ({
      cells: [
        { columnId: 'c-val', value: v },
        { columnId: 'c-lab', value: v.toUpperCase() },
      ],
    })),
  });

  /**
   * ace#1886. The positive control. Observed live 2026-09-06: `get_field`
   * returns exactly this shape for a select bound to a lookup table.
   */
  it('verifies a bind whose read-back matches what was requested', () => {
    const v = verifyLookupBind({
      requested,
      readBack: { kind: 'lookup', tableId: 't-1', valueColumnId: 'c-val', labelColumnId: 'c-lab' },
      rows: rowsOf('a', 'b'),
    });
    expect(v.verified).toBe(true);
    expect(v.bindLanded).toBe(true);
    expect(v.code).toBe('ok');
  });

  /**
   * The negative control that matters most. Until 2026-09-06 a bind was scored
   * as "the write returned no error", and `add_fields` answers a correctly
   * bound field with `options: []` and no source at all — so the write can
   * neither confirm nor deny. A field that was never bound reads back with no
   * options source, and that must NOT pass.
   */
  it('refuses a field that reads back with no options source at all', () => {
    const v = verifyLookupBind({ requested, readBack: null, rows: rowsOf('a', 'b') });
    expect(v.verified).toBe(false);
    expect(v.bindLanded).toBe(false);
    expect(v.code).toBe('no-read-back');
  });

  it('refuses a field that reads back as an INLINE source — the invented-options defect', () => {
    const v = verifyLookupBind({ requested, readBack: { kind: 'inline' }, rows: rowsOf('a', 'b') });
    expect(v.verified).toBe(false);
    expect(v.bindLanded).toBe(false);
    expect(v.code).toBe('not-a-lookup-source');
  });

  it('refuses a bind to a different table', () => {
    const v = verifyLookupBind({
      requested,
      readBack: { kind: 'lookup', tableId: 't-OTHER', valueColumnId: 'c-val', labelColumnId: 'c-lab' },
      rows: rowsOf('a', 'b'),
    });
    expect(v.verified).toBe(false);
    expect(v.bindLanded).toBe(false);
    expect(v.code).toBe('wrong-table');
  });

  it('refuses the right table through the wrong columns — workers would see the wrong codes', () => {
    for (const readBack of [
      { kind: 'lookup', tableId: 't-1', valueColumnId: 'c-lab', labelColumnId: 'c-lab' },
      { kind: 'lookup', tableId: 't-1', valueColumnId: 'c-val', labelColumnId: 'c-val' },
    ]) {
      const v = verifyLookupBind({ requested, readBack, rows: rowsOf('a', 'b') });
      expect(v.verified, JSON.stringify(readBack)).toBe(false);
      expect(v.code).toBe('wrong-columns');
    }
  });

  it('never passes on a partial read-back', () => {
    for (const readBack of [
      {},
      { kind: 'lookup' },
      { kind: 'lookup', tableId: 't-1' },
      { kind: 'lookup', tableId: 't-1', valueColumnId: 'c-val' },
    ]) {
      expect(
        verifyLookupBind({ requested, readBack, rows: rowsOf('a', 'b') }).verified,
        JSON.stringify(readBack),
      ).toBe(false);
    }
  });

  /* ------------------------------------------------------------------ *
   * ace#2143 — the bound TABLE, not just the field's options source.
   * ------------------------------------------------------------------ */

  /**
   * The reproducer, from `spark-facilitator/20260906-2233`. `malawi_activities`
   * carried `other` on seven rows, one per FCAP step. That is unique WITHIN
   * each filter partition (`step_id = step`, so a worker never sees two at
   * once) and not unique across the table — and Nova's `upload_app_to_hq`
   * preflight requires the latter:
   *
   *   "A lookup-powered choice list uses activity_id for its saved values, but
   *    malawi_activities repeats the same value in several rows."
   *
   * Before this test `verifyLookupBind` returned `verified: true` here, the
   * build memo recorded the register as read-back-verified, and `app-deploy`
   * was the first thing in the run that noticed.
   */
  it('refuses a bind onto a table whose value column repeats a code (the ace#2143 repro)', () => {
    const steps = ['step_1', 'step_2', 'step_3', 'step_4', 'step_5', 'step_6', 'step_7'];
    const rows = {
      complete: true,
      rows: [
        ...steps.map((step) => ({
          cells: [
            { columnId: 'c-step', value: step },
            { columnId: 'c-val', value: `${step}_a1` },
            { columnId: 'c-lab', value: `Activity 1 of ${step}` },
          ],
        })),
        // One "Other activity (specify)" row per step — same value code on all 7.
        ...steps.map((step) => ({
          cells: [
            { columnId: 'c-step', value: step },
            { columnId: 'c-val', value: 'other' },
            { columnId: 'c-lab', value: 'Other activity (specify)' },
          ],
        })),
      ],
    };

    const v = verifyLookupBind({ requested, readBack: boundReadBack, rows });
    expect(v.verified).toBe(false);
    expect(v.code).toBe('duplicate-values');
    // The bind itself DID land — only the table is wrong. The probe's
    // regression verdict keys on this and must not read as "the bind broke".
    expect(v.bindLanded).toBe(true);
    expect(v.message).toContain('"other" ×7');
  });

  it('counts duplicates per value and names each one', () => {
    expect(findDuplicateLookupValues(rowsOf('a', 'b', 'a', 'c', 'b', 'a').rows, 'c-val')).toEqual([
      { value: 'a', count: 3 },
      { value: 'b', count: 2 },
    ]);
    expect(findDuplicateLookupValues(rowsOf('a', 'b', 'c').rows, 'c-val')).toEqual([]);
  });

  /**
   * Two rows with no cell for the value column are two options that save the
   * same nothing — and a whole read-back whose cells do not carry `columnId`
   * (a Nova shape drift) collapses to one loud blank duplicate rather than a
   * silent pass.
   */
  it('treats a missing or blank value cell as the empty value, so blanks collide', () => {
    const rows = {
      complete: true,
      rows: [
        { cells: [{ columnId: 'c-lab', value: 'No value cell at all' }] },
        { cells: [{ columnId: 'c-val', value: '' }, { columnId: 'c-lab', value: 'Blank' }] },
      ],
    };
    const v = verifyLookupBind({ requested, readBack: boundReadBack, rows });
    expect(v.verified).toBe(false);
    expect(v.code).toBe('duplicate-values');
    expect(v.message).toContain('(blank) ×2');
  });

  /**
   * "I could not check" and "it is correct" are different answers — the rule
   * this module already applies to an unreadable register source and an absent
   * options read-back. An OPTIONAL rows argument would be a check a caller can
   * skip by forgetting, which is the exact shape of the defect being fixed.
   */
  it('refuses a bind whose table rows were never read back', () => {
    for (const rows of [null, undefined, {}, { complete: true }]) {
      const v = verifyLookupBind({ requested, readBack: boundReadBack, rows });
      expect(v.verified, JSON.stringify(rows)).toBe(false);
      expect(v.code).toBe('no-rows-read-back');
      expect(v.bindLanded).toBe(true);
    }
  });

  /**
   * `get_lookup_table_rows` pages at 100 rows. A duplicate on an unread page is
   * invisible, so an incomplete read cannot prove uniqueness.
   */
  it('refuses an INCOMPLETE paged rows read — a duplicate could be on an unread page', () => {
    for (const complete of [false, undefined, null]) {
      const v = verifyLookupBind({
        requested,
        readBack: boundReadBack,
        rows: { ...rowsOf('a', 'b'), complete },
      });
      expect(v.verified, String(complete)).toBe(false);
      expect(v.code).toBe('partial-rows-read-back');
    }
  });

  /** A select bound to an empty table renders empty on the device while every
   *  structural gate passes — the same invisibility class as an unbound one. */
  it('refuses a bind onto a table with no rows', () => {
    const v = verifyLookupBind({
      requested,
      readBack: boundReadBack,
      rows: { complete: true, rows: [] },
    });
    expect(v.verified).toBe(false);
    expect(v.code).toBe('empty-table');
  });

  /* ------------------------------------------------------------------ *
   * The whole-app sweep — the half `verifyLookupBind` alone cannot cover.
   * ------------------------------------------------------------------ */

  describe('auditLookupBinds', () => {
    const ok = (field: string) => ({
      field,
      requested,
      readBack: boundReadBack,
      rows: rowsOf('a', 'b'),
    });

    /**
     * The scope ace#2143 actually needs. Step 4f only reaches
     * `verifyLookupBind` for a field IT bound — a field the architect already
     * shipped as a correctly-shaped `single_select` never enters 4f's
     * `degraded[]` list, so before this sweep nothing on ACE's side looked at
     * the table behind it. `malawi_activities` was exactly that field.
     */
    it('fails the whole audit on ONE architect-built site the run never bound', () => {
      const audit = auditLookupBinds([
        ok('visit.district'),
        {
          // Authored and bound by the architect from the PDD — 4f never
          // touched it, because its kind was right all along.
          field: 'meeting.activity',
          requested,
          readBack: boundReadBack,
          rows: rowsOf('s1_a1', 'other', 's2_a1', 'other'),
        },
        ok('visit.cadre'),
      ]);

      expect(audit.ok).toBe(false);
      expect(audit.sites).toHaveLength(3);
      expect(audit.failures.map((f) => f.field)).toEqual(['meeting.activity']);
      expect(audit.failures[0].code).toBe('duplicate-values');
      expect(describeLookupBindAudit(audit)).toEqual([
        expect.stringContaining('[duplicate-values] meeting.activity:'),
      ]);
    });

    it('passes when every lookup-backed select in the app verifies', () => {
      const audit = auditLookupBinds([ok('visit.district'), ok('visit.cadre')]);
      expect(audit.ok).toBe(true);
      expect(audit.failures).toEqual([]);
      expect(describeLookupBindAudit(audit)).toEqual([]);
    });

    it('an app with no lookup-backed select has nothing to audit', () => {
      expect(auditLookupBinds([]).ok).toBe(true);
    });

    /* ---------------------------------------------------------------- *
     * Grounded controls. Both read the SAME captured artifact: the live
     * `get_lookup_table_rows` response for `malawi_activities` on the
     * Deliver app from ace#2143, pulled 2026-09-17.
     *
     * The table has since been repaired — one shared `other` row under
     * step_id `all` instead of seven — so its `activity_id` column is the
     * positive control. The negative control needs no invention either:
     * `step_id` genuinely repeats (step_1 four times), and binding through
     * it is Nova's own suggested remedy read backwards ("…or choose
     * another value column"), i.e. the mistake that remedy invites.
     * ---------------------------------------------------------------- */
    const captured = JSON.parse(
      readFileSync(
        join(HERE, '../fixtures/nova/lookup-table-rows-malawi-activities-2026-09-17.json'),
        'utf8',
      ),
    );
    const columnId = (wireName: string) =>
      captured.table.columns.find((c: any) => c.wireName === wireName).id;
    const capturedSite = (valueColumn: string) => {
      const requestedFromCapture = {
        tableId: captured.table.id,
        valueColumnId: columnId(valueColumn),
        labelColumnId: columnId('activity'),
      };
      return {
        field: `meeting_activity_repeat.activity (${valueColumn})`,
        requested: requestedFromCapture,
        readBack: { kind: 'lookup', ...requestedFromCapture },
        rows: { rows: captured.rows, complete: captured.complete },
      };
    };

    it('passes the REAL malawi_activities table on its repaired value column', () => {
      const audit = auditLookupBinds([capturedSite('activity_id')]);
      expect(audit.failures).toEqual([]);
      expect(audit.ok).toBe(true);
      expect(audit.sites[0].message).toContain('28 rows');
    });

    it('fails the REAL malawi_activities table bound through a repeating column', () => {
      const audit = auditLookupBinds([capturedSite('step_id')]);
      expect(audit.ok).toBe(false);
      expect(audit.failures[0].code).toBe('duplicate-values');
      expect(audit.failures[0].bindLanded).toBe(true);
      expect(audit.failures[0].message).toContain('"step_1" ×4');
    });

    /** A site the caller could not finish reading is a failure, never a drop. */
    it('fails a site whose rows were never read back', () => {
      const audit = auditLookupBinds([
        ok('visit.district'),
        { field: 'visit.cadre', requested, readBack: boundReadBack, rows: null },
      ]);
      expect(audit.ok).toBe(false);
      expect(audit.failures[0].code).toBe('no-rows-read-back');
    });
  });
});
