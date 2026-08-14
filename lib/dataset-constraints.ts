/**
 * Does a generated demo dataset obey the PDD's own data-quality constraints?
 *
 * Why this exists (dimagi-internal/ace#1346). Run
 * spark-facilitator/20260813-2126 wrote into `run_state.yaml`:
 *
 * > 253 records / 20 CBFs / 8 weeks, 176 payable = USD 528, 77 correctly
 * > unpaid … **0 constraint violations, all hand-checked**.
 *
 * Auditing the actual `user_visits.json` against the PDD's own constraint
 * table found four classes, in 253 records:
 *
 * ```
 * 251  people-counts as FLOATS (hh_represented 45.33, male_attendance 41.305)
 *      across 11 fields — the PDD requires integers, bounds 0-500
 * 242  savings not whole Malawi Kwacha (amount_saved_mwk 65993.1)
 *  34  no_meeting_reason populated where meeting_conducted = yes — the form
 *      skips that branch entirely
 *  22  meeting_conducted = no carrying full attendance blocks: a meeting that
 *      did not happen, with 41 attendees
 *  17  meeting_conducted = no with no reason at all
 * ```
 *
 * Plus a premise the PDD states outright ("20 CBFs across 20 communities, **1
 * CBF per community**"): 190 distinct (facilitator, community) pairs across 20
 * facilitators — facilitators roaming freely, which makes the PDD's dedup key
 * (community + meeting date) meaningless.
 *
 * Root cause: the labs manifest is a **distribution language**. It draws every
 * field independently; integers are enforced only when the HQ form schema
 * types the question `Int`; conditional blocks are populated regardless of
 * branch. Nothing checked the result, and `demo-data-setup-qa` passed — it
 * checks that dashboard URLs are live run deep-links, not that the records are
 * legal.
 *
 * The skill then wrote a hand-checked CLAIM into run_state that was not true,
 * and the claim is what the orchestrator and every downstream reader trusts.
 * So this module returns COUNTS: "0 violations" becomes a measured number
 * rather than an assertion.
 *
 * Why blocks-e2e and not polish: a funder-facing dashboard rendering "45.33
 * households represented" and "a meeting that did not happen, attended by 41
 * people" is the first thing a partner M&E director checks, and it discredits
 * the arithmetic the whole demo exists to make credible.
 */

export type ConstraintKind =
  | 'non-integer'
  | 'out-of-bounds'
  | 'fractional-currency'
  | 'conditional-off-branch'
  | 'conditional-missing'
  | 'cross-field'
  | 'pair-cardinality';

export interface IntegerFieldSpec {
  field: string;
  min?: number;
  max?: number;
}

export interface ConditionalFieldSpec {
  field: string;
  /** The branch on which this field is asked at all. */
  requiredWhen: { field: string; equals: unknown };
}

export interface CrossFieldRule {
  lhs: string;
  op: '<=' | '<' | '>=' | '>';
  rhs: string;
}

export interface UniquePairSpec {
  /** Two field names; the first is the grouping key. */
  fields: [string, string] | string[];
  /** How many distinct second-values each first-value may have. */
  perFirst: number;
}

export interface DatasetSpec {
  integerFields?: IntegerFieldSpec[];
  wholeCurrencyFields?: string[];
  conditionalFields?: ConditionalFieldSpec[];
  crossFieldRules?: CrossFieldRule[];
  uniquePairs?: UniquePairSpec[];
}

export interface ConstraintViolation {
  kind: ConstraintKind;
  field?: string;
  /** How many records violate it — the number that makes "0" measured. */
  count: number;
  detail: string;
}

export interface ConstraintReport {
  ok: boolean;
  total: number;
  violations: ConstraintViolation[];
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

function compare(a: number, op: CrossFieldRule['op'], b: number): boolean {
  switch (op) {
    case '<=': return a <= b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '>': return a > b;
  }
}

export function auditDataset(rows: Row[], spec: DatasetSpec): ConstraintReport {
  const violations: ConstraintViolation[] = [];
  const add = (kind: ConstraintKind, field: string | undefined, count: number, detail: string) => {
    if (count > 0) violations.push({ kind, field, count, detail });
  };

  for (const f of spec.integerFields ?? []) {
    const vals = rows.map((r) => num(r[f.field])).filter((v): v is number => v !== null);
    const nonInt = vals.filter((v) => !Number.isInteger(v)).length;
    add(
      'non-integer', f.field, nonInt,
      `${f.field} is a COUNT and must be an integer — ${nonInt} record(s) carry a fraction ` +
        '(the manifest draws it from a continuous distribution unless the HQ schema types it Int)',
    );
    const oob = vals.filter(
      (v) => (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max),
    ).length;
    add('out-of-bounds', f.field, oob, `${f.field} outside its stated bounds [${f.min ?? '-∞'}, ${f.max ?? '∞'}]`);
  }

  for (const field of spec.wholeCurrencyFields ?? []) {
    const bad = rows
      .map((r) => num(r[field]))
      .filter((v): v is number => v !== null && !Number.isInteger(v)).length;
    add('fractional-currency', field, bad, `${field} must be a whole currency unit — ${bad} record(s) are fractional`);
  }

  for (const c of spec.conditionalFields ?? []) {
    const offBranch = rows.filter(
      (r) => r[c.requiredWhen.field] !== c.requiredWhen.equals && present(r[c.field]),
    ).length;
    add(
      'conditional-off-branch', c.field, offBranch,
      `${c.field} is populated on records where ${c.requiredWhen.field} != ` +
        `${JSON.stringify(c.requiredWhen.equals)} — the form skips that branch entirely, so the value ` +
        'cannot exist in real data',
    );
    const missing = rows.filter(
      (r) => r[c.requiredWhen.field] === c.requiredWhen.equals && !present(r[c.field]),
    ).length;
    add(
      'conditional-missing', c.field, missing,
      `${c.field} is absent on ${missing} record(s) where ${c.requiredWhen.field} = ` +
        `${JSON.stringify(c.requiredWhen.equals)} asks for it`,
    );
  }

  for (const rule of spec.crossFieldRules ?? []) {
    const bad = rows.filter((r) => {
      const a = num(r[rule.lhs]);
      const b = num(r[rule.rhs]);
      return a !== null && b !== null && !compare(a, rule.op, b);
    }).length;
    add('cross-field', rule.lhs, bad, `${rule.lhs} ${rule.op} ${rule.rhs} fails on ${bad} record(s)`);
  }

  for (const p of spec.uniquePairs ?? []) {
    const [first, second] = p.fields;
    const byFirst = new Map<string, Set<string>>();
    for (const r of rows) {
      const a = String(r[first] ?? '');
      const b = String(r[second] ?? '');
      if (!a) continue;
      if (!byFirst.has(a)) byFirst.set(a, new Set());
      byFirst.get(a)!.add(b);
    }
    const offenders = [...byFirst.entries()].filter(([, set]) => set.size > p.perFirst);
    add(
      'pair-cardinality', `${first}+${second}`, offenders.length,
      `the PDD states ${p.perFirst} ${second} per ${first}, but ` +
        offenders.map(([a, set]) => `${a} has ${set.size}`).join(', ') +
        ' — the dedup key the PDD asserts stops being meaningful',
    );
  }

  return { ok: violations.length === 0, total: rows.length, violations };
}

export function formatConstraintReport(r: ConstraintReport): string {
  if (r.ok) {
    return `dataset-constraints: 0 violations across ${r.total} records (measured, not asserted)`;
  }
  return [
    `dataset-constraints: ${r.violations.length} constraint class(es) violated across ${r.total} records —`,
    'the labs manifest is a DISTRIBUTION language: it draws every field independently, so a legal-looking',
    'set can be arithmetically impossible. A funder-facing dashboard rendering a fractional household',
    'count, or a meeting that did not happen with 41 attendees, discredits the arithmetic the demo exists',
    'to make credible (dimagi-internal/ace#1346).',
    ...r.violations.map((v) => `  [${v.kind}] ${v.count} of ${r.total} — ${v.detail}`),
  ].join('\n');
}
