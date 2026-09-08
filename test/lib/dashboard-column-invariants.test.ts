import { describe, it, expect } from 'vitest';
import {
  checkColumnInvariants,
  type AggregateRow,
  type ColumnInvariant,
  type InvariantFinding,
} from '../../lib/dashboard-column-invariants';

/**
 * The fixture is the real payload from `spark-facilitator/20260907-1120`,
 * pipeline 5484, read live from `pipeline_preview` on 2026-09-08 — not values
 * invented to make the check fire. Six of these twelve rows carry
 * `steps_completed > steps_covered`, and four exceed the seven-step ceiling the
 * ledger's own column header declares. ace#2250.
 */
const SPARK_ROWS: AggregateRow[] = [
  { username: 'annie_kalua', records: 16, payable: 15, steps_covered: 7, steps_completed: 8 },
  { username: 'chimwemwe_gondwe', records: 19, payable: 18, steps_covered: 7, steps_completed: 5 },
  { username: 'dalitso_mbewe', records: 11, payable: 6, steps_covered: 4, steps_completed: 1 },
  { username: 'esnart_banda', records: 14, payable: 14, steps_covered: 5, steps_completed: 8 },
  { username: 'felix_kumwenda', records: 14, payable: 14, steps_covered: 6, steps_completed: 4 },
  { username: 'gift_mwale', records: 22, payable: 21, steps_covered: 6, steps_completed: 7 },
  { username: 'lameck_nyirenda', records: 15, payable: 15, steps_covered: 6, steps_completed: 9 },
  { username: 'mercy_chirwa', records: 18, payable: 15, steps_covered: 6, steps_completed: 6 },
  { username: 'patuma_kachale', records: 15, payable: 15, steps_covered: 6, steps_completed: 7 },
  { username: 'steven_msiska', records: 9, payable: 9, steps_covered: 2, steps_completed: 2 },
  { username: 'tamara_phiri', records: 19, payable: 19, steps_covered: 6, steps_completed: 10 },
  { username: 'wongani_zulu', records: 10, payable: 5, steps_covered: 7, steps_completed: 5 },
];

/** What the ledger's own column headers claim, written down. */
const SPARK_INVARIANTS: ColumnInvariant[] = [
  {
    left: 'steps_completed',
    op: '<=',
    right: 'steps_covered',
    because: 'A step cannot be closed out without being covered.',
  },
  {
    left: 'steps_covered',
    op: '<=',
    right: 7,
    because: 'The column header states "of the 7 Goal Setting steps".',
  },
  {
    left: 'payable',
    op: '<=',
    right: 'records',
    because: 'Only a filed record can earn a payment.',
  },
];

const kinds = (fs: InvariantFinding[]) => fs.map((f) => f.kind);
const blocking = (fs: InvariantFinding[]) => fs.filter((f) => f.blocking);

describe('checkColumnInvariants — the relations a form cannot express', () => {
  it('catches the six impossible rows check 9 measured zero violations over', () => {
    const r = checkColumnInvariants(SPARK_INVARIANTS, SPARK_ROWS);

    expect(r.pass).toBe(false);
    const violated = r.findings.filter((f) => f.kind === 'invariant-violated');
    expect(violated.map((f) => f.row)).toEqual([
      'annie_kalua',
      'esnart_banda',
      'gift_mwale',
      'lameck_nyirenda',
      'patuma_kachale',
      'tamara_phiri',
    ]);
    expect(violated.every((f) => f.blocking)).toBe(true);
    // Both sides are named back, so the fix is unambiguous.
    expect(violated[5].detail).toContain('steps_completed = 10');
    expect(violated[5].detail).toContain('steps_covered = 6');
    // It points at the canonical cause rather than at the data.
    expect(violated[0].detail).toContain('count_distinct');
  });

  it('judges every pair, so a clean report is measured and not assumed', () => {
    const r = checkColumnInvariants(SPARK_INVARIANTS, SPARK_ROWS);
    expect(r.judged).toBe(36); // 3 invariants x 12 rows
  });

  it('CONTROL — the same rows pass once steps_completed counts distinct steps', () => {
    // What the pipeline should have produced: count_distinct over the step path
    // filtered to step_completed = yes, which cannot exceed steps_covered.
    const fixed = SPARK_ROWS.map((r) => ({
      ...r,
      steps_completed: Math.min(r.steps_completed as number, r.steps_covered as number),
    }));
    const r = checkColumnInvariants(SPARK_INVARIANTS, fixed);

    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.judged).toBe(36);
  });

  it('reports a literal ceiling breach on its own, not only a column pair', () => {
    const r = checkColumnInvariants(
      [{ left: 'steps_covered', op: '<=', right: 7, because: 'seven steps.' }],
      [{ username: 'over', steps_covered: 9 }],
    );
    expect(kinds(r.findings)).toEqual(['invariant-violated']);
    expect(r.findings[0].detail).toContain('steps_covered = 9');
  });

  // ace#2253's lesson, applied here before it can cost anything: a check that
  // declines to evaluate must never report a pass.
  it('BLOCKS an invariant naming a column the payload does not carry', () => {
    const r = checkColumnInvariants(
      [{ left: 'steps_closed', op: '<=', right: 'steps_covered', because: 'typo.' }],
      SPARK_ROWS,
    );

    expect(r.pass).toBe(false);
    expect(kinds(r.findings)).toEqual(['unknown-field']);
    expect(r.findings[0].blocking).toBe(true);
    expect(r.findings[0].detail).toContain('steps_closed');
    // It lists what IS available, so the typo is fixable without another round-trip.
    expect(r.findings[0].detail).toContain('steps_covered');
    expect(r.judged).toBe(0);
  });

  it('BLOCKS a declared invariant with no rows to judge it against', () => {
    const r = checkColumnInvariants(SPARK_INVARIANTS, []);
    expect(r.pass).toBe(false);
    expect(new Set(kinds(r.findings))).toEqual(new Set(['unknown-field']));
    expect(r.judged).toBe(0);
  });

  it('BLOCKS a null column rather than reading it as zero', () => {
    const r = checkColumnInvariants(
      [{ left: 'payable', op: '<=', right: 'records', because: 'x.' }],
      [{ username: 'nulled', payable: null, records: 5 }],
    );
    expect(kinds(r.findings)).toEqual(['non-numeric-field']);
    expect(blocking(r.findings)).toHaveLength(1);
  });

  it('reports an omitted declaration over comparable numeric columns', () => {
    const r = checkColumnInvariants([], SPARK_ROWS);

    expect(r.pass).toBe(true); // reported, not blocking — the sibling posture
    expect(kinds(r.findings)).toEqual(['no-invariants-declared']);
    expect(r.findings[0].blocking).toBe(false);
    expect(r.findings[0].detail).toContain('steps_covered');
    expect(r.judged).toBe(0);
  });

  it('stays quiet when there is nothing a viewer could compare', () => {
    // One numeric column, plus structural scaffolding and an average. Declaring
    // a relation here would be ceremony, and a check that fires on every clean
    // payload stops being read (ace#1744, ace#1762).
    const r = checkColumnInvariants(
      [],
      [{ username: 'a', opportunity_id: 10057, records: 3, avg_male_attendance: 28.8 }],
    );
    expect(r.findings).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('does not treat ids and dates as comparable numbers', () => {
    const r = checkColumnInvariants(
      [],
      [{ username: 'a', id: 1, entity_id: 2, opportunity_id: 3, first_visit_date: '2026-06-01', records: 4 }],
    );
    expect(r.findings).toEqual([]);
  });

  it('supports every operator it declares', () => {
    const row = [{ username: 'r', a: 5, b: 5 }];
    const ok = (op: ColumnInvariant['op']) =>
      checkColumnInvariants([{ left: 'a', op, right: 'b', because: 'x.' }], row).pass;

    expect(ok('<=')).toBe(true);
    expect(ok('==')).toBe(true);
    expect(ok('>=')).toBe(true);
    expect(ok('<')).toBe(false);
    expect(ok('>')).toBe(false);
  });

  it('generates at least one finding of every kind it can emit', () => {
    const all = [
      ...checkColumnInvariants(SPARK_INVARIANTS, SPARK_ROWS).findings,
      ...checkColumnInvariants(
        [{ left: 'nope', op: '<=', right: 1, because: 'x.' }],
        SPARK_ROWS,
      ).findings,
      ...checkColumnInvariants(
        [{ left: 'payable', op: '<=', right: 'records', because: 'x.' }],
        [{ username: 'n', payable: null, records: 1 }],
      ).findings,
      ...checkColumnInvariants([], SPARK_ROWS).findings,
    ];
    expect(new Set(kinds(all))).toEqual(
      new Set([
        'invariant-violated',
        'unknown-field',
        'non-numeric-field',
        'no-invariants-declared',
      ]),
    );
  });

  it('every blocking finding reaches auto_fix_hint', () => {
    const r = checkColumnInvariants(SPARK_INVARIANTS, SPARK_ROWS);
    expect(r.auto_fix_hint).toBeDefined();
    for (const f of blocking(r.findings)) {
      expect(r.auto_fix_hint).toContain(f.row ?? '');
    }
  });
});
