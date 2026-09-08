/**
 * The ARITHMETIC tier — can the numbers on the dashboard all be true at once?
 *
 * `demo-data-setup-qa`'s check 9 judges the RECORDS: every generated visit is
 * measured against a constraint spec derived from the released Deliver app. It
 * is good at that and it is not the tier this module covers. What reaches a
 * funder is not a record — it is a ROW of pipeline aggregates rendered as
 * columns, and the relations between those columns are invisible to a spec
 * derived from a form.
 *
 * ## The run that is this module's evidence (ace#2250)
 *
 * `spark-facilitator/20260907-1120` shipped a payment ledger where **Steps
 * closed out exceeded Steps covered on 6 of 12 rows** — Annie K. 8 vs 7,
 * Gift M. 7 vs 6, Tamara P. 10 vs 6, Esnart B. 8 vs 5, Lameck N. 9 vs 6,
 * Patuma K. 7 vs 6 — and four of those values (8, 10, 8, 9) also exceeded the
 * seven-step ceiling the adjacent column header itself declares, *"of the 7
 * Goal Setting steps"*.
 *
 * The cause was one word in the pipeline schema:
 *
 *     steps_covered    count_distinct  form.fcap_step_screen.pilot_fcap_step
 *     steps_completed  count           form.closing.step_completed (= yes)
 *
 * `steps_covered` counts DISTINCT STEPS, so it is bounded by seven.
 * `steps_completed` counts RECORDS that marked a step complete, so three
 * meetings on one step contribute three. The two were rendered side by side as
 * counts of the same noun. Neither field is wrong on its own; the pair cannot
 * both be what the header says they are.
 *
 * **Check 9 passed this dataset with "0 unexempted violations."** It was not
 * wrong — no record violated anything. The invariant lives one level up, between
 * two aggregates, and nobody had written it down. A measured zero was reported
 * over a relation that was never in scope. That is the thing this module fixes:
 * not the arithmetic, but the silence.
 *
 * The user-artifact judge caught it and capped `trust` at 2 on its own deduction
 * rule — *"a programme lead who spot-checks any right-hand column finds a number
 * that cannot be true, and will discount the payment figures beside it."* That
 * is the whole cost of a demo, paid for one word.
 *
 * ## Why this check is DECLARATIVE, and why an unknown field is blocking
 *
 * There is no way to derive `steps_completed <= steps_covered <= 7` from the
 * form: the app knows a step was closed, it does not know that a dashboard will
 * render the count against a seven-step denominator. The relation is a claim the
 * dashboard's own header makes, so the author of the dashboard is the one who
 * can state it. This check measures what was stated.
 *
 * That design has one failure mode and it is the expensive one, so it is closed
 * here explicitly: **an invariant naming a column the payload does not carry is
 * BLOCKING, never a silent skip.** A check that quietly declines to evaluate and
 * reports a pass is exactly the vacuous green of ace#2253 — `checkScrollFraming`
 * returned `pass` having judged nothing, an operator read it as approval, and
 * the gate was green on an artifact that could not reproduce its own video. A
 * typo in a field name must fail loudly rather than buy a free pass.
 *
 * For the same reason, declaring NOTHING over a payload that carries several
 * numeric columns is reported rather than ignored — the sibling posture
 * `checkCoinedTerms` takes with `no-terms-enumerated`. A recorded empty list is
 * evidence; an omitted one is not.
 */

import type { QACheckResult } from './qa-types';

/** The comparisons a column relation can need. Deliberately few. */
export type InvariantOp = '<=' | '<' | '==' | '>=' | '>';

/**
 * One relation that must hold on every rendered row.
 *
 * `left` and `right` are pipeline field names as they appear in the payload,
 * except that `right` may be a NUMBER when the bound is a literal the dashboard
 * states — `{ left: 'steps_covered', op: '<=', right: 7 }` for a seven-step
 * programme.
 */
export interface ColumnInvariant {
  left: string;
  op: InvariantOp;
  right: string | number;
  /**
   * Why it must hold, in the dashboard's own words where possible — quote the
   * column header or the PDD clause. This is what a reader of a violation needs
   * in order to know which side is wrong.
   */
  because: string;
}

export type InvariantFindingKind =
  /** A row breaks a declared relation. The dataset or the schema is wrong. */
  | 'invariant-violated'
  /** A declared invariant names a column the payload does not carry. */
  | 'unknown-field'
  /** A column that is not a number on some row, so the relation cannot be read. */
  | 'non-numeric-field'
  /** Numeric columns are rendered and no relation between them was stated. */
  | 'no-invariants-declared';

export interface InvariantFinding {
  kind: InvariantFindingKind;
  /** The relation, rendered back as `left op right`. */
  invariant?: string;
  /** The row's grouping key, so a violation is findable on the page. */
  row?: string;
  blocking: boolean;
  detail: string;
}

export interface InvariantReport extends QACheckResult {
  findings: InvariantFinding[];
  /** Invariant-row pairs actually evaluated, so a clean report is measured. */
  judged: number;
}

/** A row of pipeline aggregates, as `pipeline_preview` returns it. */
export type AggregateRow = Record<string, unknown>;

/** Fields every pipeline carries as scaffolding — never the subject of a claim. */
const STRUCTURAL_FIELDS = new Set([
  'id',
  'username',
  'entity_id',
  'entity_name',
  'opportunity_id',
  'status',
  'flagged',
  'visit_date',
  'first_visit_date',
  'last_visit_date',
]);

function renderInvariant(inv: ColumnInvariant): string {
  return `${inv.left} ${inv.op} ${inv.right}`;
}

function rowKey(row: AggregateRow, index: number): string {
  for (const k of ['username', 'entity_name', 'entity_id', 'id']) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return `(row ${index + 1})`;
}

function compare(a: number, op: InvariantOp, b: number): boolean {
  switch (op) {
    case '<=':
      return a <= b;
    case '<':
      return a < b;
    case '==':
      return a === b;
    case '>=':
      return a >= b;
    case '>':
      return a > b;
  }
}

/**
 * Numeric columns a reader would compare — the ones a missing invariant is
 * about. Averages and dates are excluded: nothing on the page reads them
 * against each other.
 */
function comparableNumericFields(rows: AggregateRow[]): string[] {
  const out: string[] = [];
  const first = rows[0] ?? {};
  for (const k of Object.keys(first)) {
    if (STRUCTURAL_FIELDS.has(k)) continue;
    if (k.startsWith('avg_')) continue;
    const allNumeric = rows.every((r) => typeof r[k] === 'number' && Number.isFinite(r[k] as number));
    if (allNumeric) out.push(k);
  }
  return out;
}

/**
 * Judge every declared column relation against every rendered row.
 *
 * Pass `invariants` exactly as `demo-data-setup` declared them and `rows`
 * exactly as `pipeline_preview` returned them — this function does no fetching
 * and re-derives nothing, so what it judges is what the dashboard renders.
 */
export function checkColumnInvariants(
  invariants: ColumnInvariant[] | undefined,
  rows: AggregateRow[] | undefined,
): InvariantReport {
  const findings: InvariantFinding[] = [];
  const declared = invariants ?? [];
  const data = rows ?? [];
  let judged = 0;

  if (declared.length === 0) {
    const numeric = comparableNumericFields(data);
    if (numeric.length >= 2) {
      findings.push({
        kind: 'no-invariants-declared',
        blocking: false,
        detail:
          `this dashboard renders ${numeric.length} comparable numeric column(s) — ` +
          `${numeric.join(', ')} — and no relation between any of them was declared, so this ` +
          `check judged nothing. Read the pass above as "no relation was tested", never as ` +
          `"the numbers agree". On spark-facilitator/20260907-1120 the ledger rendered Steps ` +
          `closed out above Steps covered on 6 of 12 rows, four of them above the seven-step ` +
          `ceiling the column header itself states, and the run's constraint check reported ` +
          `zero violations throughout — correctly, because the relation was never in its ` +
          `scope. Declare what must hold between these columns, even when the answer is that ` +
          `nothing does: a recorded empty list is evidence and an omitted one is not. ace#2250`,
      });
    }
    return finish(findings, judged);
  }

  for (const inv of declared) {
    const label = renderInvariant(inv);

    if (data.length === 0) {
      findings.push({
        kind: 'unknown-field',
        invariant: label,
        blocking: true,
        detail:
          `no rows were supplied, so this relation could not be evaluated. An invariant that ` +
          `silently does not run is worse than none, because it reads as a pass it never ` +
          `earned (ace#2253). Fetch the dashboard payload and judge against it`,
      });
      continue;
    }

    const missing = new Set<string>();
    for (const name of [inv.left, inv.right]) {
      if (typeof name !== 'string') continue;
      if (!data.every((r) => name in r)) missing.add(name);
    }
    if (missing.size > 0) {
      findings.push({
        kind: 'unknown-field',
        invariant: label,
        blocking: true,
        detail:
          `names ${[...missing].map((m) => `"${m}"`).join(' and ')}, which the payload does ` +
          `not carry on every row. This is BLOCKING rather than skipped on purpose: a ` +
          `mistyped column would otherwise buy a free pass, and a check that declines to ` +
          `evaluate while reporting a pass is the exact failure of ace#2253. Fix the name ` +
          `against the pipeline schema, or drop the invariant deliberately. Available ` +
          `columns: ${comparableNumericFields(data).join(', ') || '(none numeric)'}`,
      });
      continue;
    }

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const l = row[inv.left];
      const r = typeof inv.right === 'number' ? inv.right : row[inv.right];

      if (typeof l !== 'number' || typeof r !== 'number' || !Number.isFinite(l) || !Number.isFinite(r)) {
        findings.push({
          kind: 'non-numeric-field',
          invariant: label,
          row: rowKey(row, i),
          blocking: true,
          detail:
            `cannot be read as a comparison on this row — ${inv.left} is ${JSON.stringify(l)} ` +
            `and ${typeof inv.right === 'number' ? 'the bound' : inv.right} is ` +
            `${JSON.stringify(r)}. A null column is usually an aggregation that matched no ` +
            `record; decide whether that is legitimate before restating the invariant`,
        });
        continue;
      }

      judged++;
      if (!compare(l, inv.op, r)) {
        findings.push({
          kind: 'invariant-violated',
          invariant: label,
          row: rowKey(row, i),
          blocking: true,
          detail:
            `${rowKey(row, i)} renders ${inv.left} = ${l} and ` +
            `${typeof inv.right === 'number' ? inv.right : `${inv.right} = ${r}`}, which breaks ` +
            `"${label}". ${inv.because} A viewer who spot-checks this row finds a number that ` +
            `cannot be true and discounts every figure beside it, which is why the user judge ` +
            `treats it as an entity-level hard cap rather than a blemish. Before changing the ` +
            `data, check the pipeline schema: the canonical cause is an aggregation that counts ` +
            `RECORDS where the column header promises a count of THINGS — a count where the ` +
            `sibling column uses count_distinct (ace#2250)`,
        });
      }
    }
  }

  return finish(findings, judged);
}

function finish(findings: InvariantFinding[], judged: number): InvariantReport {
  const blockers = findings.filter((f) => f.blocking);
  return {
    pass: blockers.length === 0,
    judged,
    findings,
    detail:
      `${judged} invariant-row pair(s) judged; ${blockers.length} blocking, ` +
      `${findings.length - blockers.length} reported`,
    ...(blockers.length > 0
      ? {
          auto_fix_hint: blockers
            .map((f) => `[${f.kind}] ${f.invariant ?? ''}${f.row ? ` @ ${f.row}` : ''} — ${f.detail}`)
            .join('\n'),
        }
      : {}),
  };
}
