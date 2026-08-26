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
  /**
   * The question's full XForm XPath, when the spec was derived from the app
   * (`specFromDeliverApp`). `auditDataset` ignores it — it exists so
   * `scrubOffBranchFields` can locate the field inside a NESTED fixture
   * record, where the leaf name alone is ambiguous. Optional so a
   * hand-declared entry stays a two-line object (ace#1658).
   */
  path?: string;
  /** The branch on which this field is asked at all. */
  requiredWhen: { field: string; path?: string; equals: unknown };
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
  }

  // `conditional-missing` is evaluated ONCE PER FIELD, over the CONJUNCTION of
  // that field's gates — not once per gate (ace#1693).
  //
  // `specFromDeliverApp` emits one spec per gate, inheriting a group-level
  // `relevant` down to every descendant, so one question under two gates yields
  // two entries. Checking them independently is correct for the OFF-BRANCH
  // direction above (if ANY gate is unsatisfied the value cannot exist) and
  // wrong here: the form asks for the field only when EVERY gate holds, so
  // demanding it present whenever a SINGLE gate holds contradicts the other
  // gate, and the field becomes unsatisfiable in both directions.
  //
  // Measured on deliver app 28464041b4d54511af2989f4349fce30 v14 (opp 2219):
  // 12 of 59 derived `conditionalFields` carry two gates. `meeting_photo` is
  // gated on `meeting_conducted='yes'` (group) AND `consent_given='yes'`
  // (field), so a meeting that happened but declined the photograph — the only
  // legal shape for that case — fired `conditional-missing` with the photo
  // absent and `conditional-off-branch` with it present. `step_phase_2/3/4`
  // were worse: `phase` holds one value per record, so they fired on EVERY
  // meeting record by construction and no dataset could pass check 9.
  const gatesByField = new Map<string, ConditionalFieldSpec[]>();
  for (const c of spec.conditionalFields ?? []) {
    const group = gatesByField.get(c.field);
    if (group) group.push(c);
    else gatesByField.set(c.field, [c]);
  }
  for (const [field, gates] of gatesByField) {
    const missing = rows.filter(
      (r) =>
        gates.every((g) => r[g.requiredWhen.field] === g.requiredWhen.equals) && !present(r[field]),
    ).length;
    const where = gates
      .map((g) => `${g.requiredWhen.field} = ${JSON.stringify(g.requiredWhen.equals)}`)
      .join(' and ');
    add(
      'conditional-missing', field, missing,
      `${field} is absent on ${missing} record(s) where ${where} asks for it`,
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

// ────────────────────────────────────────────────────────────────────
// Mechanical spec derivation + the post-generation branch scrub
// (dimagi-internal/ace#1658)
//
// `auditDataset` above is only as good as the `DatasetSpec` handed to it,
// and until now the skill built that spec by reading PDD prose. Under-declare
// one entry and the gate reports a MEASURED zero over a spec narrowed to
// exclude the finding — ace#1346's failure mode displaced one level up, into
// the spec instead of the count.
//
// Measured, same opp, same app, same generator:
//   `bednet-check-2-visit/20260817-1720` declared `conditionalFields: []` on
//   the strength of "no conditional blocks" and recorded check 9 `pass`.
//   `get_opportunity_apps(2214, 'deliver')` returns, verbatim:
//     {"value": "/data/net_check/slept_under_net",
//      "relevant": "/data/agree_again/consent_confirmed = 'yes'", ...}
//   `20260825-1310` declared the same two gates honestly and measured 18 of
//   276 off-branch on each.
//
// So the spec is DERIVED from the app (`specFromDeliverApp`), hand-declared
// entries are ADDITIONS (`mergeDatasetSpecs`), and anything the parser cannot
// read comes back in `unparsed[]` rather than being silently dropped — silent
// narrowing is the whole defect.
//
// The second half: the fix the old auto-fix hint demanded ("regenerate with
// the constraint applied at the manifest") does not exist. connect-labs
// `connect_labs/labs/synthetic/generator/fixtures/manifest.py` gives
// `BeneficiaryCohort` `field_distributions` / `progression` / `correlation` /
// `repeat_groups` / `longitudinal` and no conditional / relevant / branch
// primitive of any kind; `FieldDistribution.null_rate` is unconditional and
// `CorrelationSpec` can make two fields co-vary but cannot make one ABSENT on
// a branch. So a gated form could never pass, and the only routes to green
// were under-declaring the spec or hand-patching records. `scrubOffBranchFields`
// is the third: a declared, reproducible, idempotent post-generation step
// driven by the app's own `relevant` expressions.
// ────────────────────────────────────────────────────────────────────

/**
 * One question as `get_opportunity_apps(<opp>, 'deliver')` returns it.
 *
 * That atom wraps Connect's `/export/opportunity/<id>/app_structure/`, which
 * returns HQ's `api/v0.5/application/<id>/` document verbatim
 * (`commcare_connect/utils/commcarehq_api.py::get_app_structure`). HQ builds
 * each question dict in `corehq/apps/app_manager/xform.py` with exactly these
 * keys — `value` (the XForm XPath), `type` (the data type: `Int`, `Select1`,
 * `Group`, …), `relevant`, `required`, `constraint`, `is_group`.
 */
export interface DeliverAppQuestion {
  value?: string;
  type?: string | null;
  relevant?: string | null;
  constraint?: string | null;
  required?: boolean;
  is_group?: boolean;
  [key: string]: unknown;
}

export type UnparsedKind = 'relevant' | 'constraint';

/**
 * An expression the derivation could NOT turn into a spec entry.
 *
 * Returned rather than dropped: a spec that silently omits a gate it could
 * not read is indistinguishable from a form that has no gate, and that
 * confusion is exactly what produced the false green.
 */
export interface UnparsedExpression {
  kind: UnparsedKind;
  /** Leaf field name (what generated records key on). */
  field: string;
  /** The question's full XForm XPath. */
  path: string;
  expression: string;
  reason: string;
}

export interface DerivedDatasetSpec {
  spec: DatasetSpec;
  unparsed: UnparsedExpression[];
  /** Non-group questions the app declared. 0 means nothing was derived. */
  questionsSeen: number;
  /** Gates successfully parsed into `spec.conditionalFields`. */
  gatesParsed: number;
}

/** Question types that hold other questions rather than a value. */
const CONTAINER_TYPES = new Set(['Group', 'Repeat', 'FieldList']);
/** Question types whose value is a whole number. */
const INTEGER_TYPES = new Set(['Int', 'Long']);

/** The last segment of an XForm XPath — the name generated records key on. */
export function leafFieldName(xpath: string): string {
  const segments = String(xpath ?? '')
    .trim()
    .split('/')
    .filter((s) => s.length > 0);
  return segments.length ? segments[segments.length - 1] : '';
}

/**
 * `<path> = '<value>'` — the only `relevant` shape that maps onto
 * `ConditionalFieldSpec`, which can express equality and nothing else.
 *
 * The left-hand character class excludes `!`, `<`, `>` and `=` on purpose:
 * without that, `a!='b'` parses as field `a!` rather than failing, which would
 * invert the gate. A bare numeric right-hand side is deliberately NOT accepted
 * — `auditDataset` compares with `!==`, and whether the fixture stores `1` or
 * `'1'` is not derivable from the app, so guessing would produce a gate that
 * silently never matches.
 */
const RELEVANT_EQUALITY = /^\s*([^\s()'"!<>=]+)\s*=\s*(?:'([^']*)'|"([^"]*)")\s*$/;

/** A single `. >= <n>` / `. <= <n>` clause of a constraint expression. */
const CONSTRAINT_BOUND = /^\s*\(?\s*\.\s*(>=|<=)\s*(-?\d+(?:\.\d+)?)\s*\)?\s*$/;

interface Gate {
  ownerPath: string;
  expression: string;
}

function collectQuestions(appJson: unknown): DeliverAppQuestion[] {
  const root = (appJson ?? {}) as Record<string, unknown>;
  // Accept either the whole `get_opportunity_apps` envelope or the app JSON.
  const app = (root.deliver_app ?? root.learn_app ?? root) as Record<string, unknown>;
  const modules = Array.isArray(app?.modules) ? (app.modules as Record<string, unknown>[]) : [];
  const out: DeliverAppQuestion[] = [];
  for (const m of modules) {
    const forms = Array.isArray(m?.forms) ? (m.forms as Record<string, unknown>[]) : [];
    for (const f of forms) {
      const questions = Array.isArray(f?.questions) ? (f.questions as DeliverAppQuestion[]) : [];
      for (const q of questions) if (q && typeof q === 'object') out.push(q);
    }
  }
  return out;
}

function isContainer(q: DeliverAppQuestion): boolean {
  return q.is_group === true || CONTAINER_TYPES.has(String(q.type ?? ''));
}

/** Parse `. >= 1 and . <= 30` into inclusive bounds. All-or-nothing. */
function parseIntegerBounds(constraint: string): { min?: number; max?: number } | null {
  const clauses = constraint.split(/\s+and\s+/i);
  const out: { min?: number; max?: number } = {};
  for (const clause of clauses) {
    const m = CONSTRAINT_BOUND.exec(clause);
    if (!m) return null;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) return null;
    if (m[1] === '>=') out.min = out.min === undefined ? value : Math.max(out.min, value);
    else out.max = out.max === undefined ? value : Math.min(out.max, value);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Derive `conditionalFields` + `integerFields` from the deliver app itself.
 *
 * Gate inheritance is handled: a `relevant` on a GROUP gates every question
 * underneath it, so each descendant gets that gate too (HQ only repeats a
 * `relevant` on the node that declares it). One question under two gates
 * yields two `ConditionalFieldSpec` entries; `auditDataset` checks each
 * independently, which is the correct semantics for an `and` of gates.
 */
export function specFromDeliverApp(appJson: unknown): DerivedDatasetSpec {
  const questions = collectQuestions(appJson);
  const unparsed: UnparsedExpression[] = [];

  const gates: Gate[] = [];
  for (const q of questions) {
    const path = String(q.value ?? '').trim();
    const relevant = String(q.relevant ?? '').trim();
    if (path && relevant) gates.push({ ownerPath: path, expression: relevant });
  }

  const conditionalFields: ConditionalFieldSpec[] = [];
  const integerFields: IntegerFieldSpec[] = [];
  const seenConditional = new Set<string>();
  let questionsSeen = 0;

  for (const q of questions) {
    if (isContainer(q)) continue;
    const path = String(q.value ?? '').trim();
    if (!path) continue;
    questionsSeen += 1;
    const field = leafFieldName(path);

    for (const gate of gates) {
      const applies = gate.ownerPath === path || path.startsWith(`${gate.ownerPath}/`);
      if (!applies) continue;
      const m = RELEVANT_EQUALITY.exec(gate.expression);
      if (!m) {
        unparsed.push({
          kind: 'relevant',
          field,
          path,
          expression: gate.expression,
          reason:
            "not of the form <path> = '<value>' — ConditionalFieldSpec can only express equality, " +
            'so this gate must be hand-declared as an addition (or the expression simplified)',
        });
        continue;
      }
      const gateField = leafFieldName(m[1]);
      const equals = m[2] !== undefined ? m[2] : m[3];
      const key = `${field}|${gateField}|${String(equals)}`;
      if (seenConditional.has(key)) continue;
      seenConditional.add(key);
      conditionalFields.push({
        field,
        path,
        requiredWhen: { field: gateField, path: m[1], equals },
      });
    }

    if (INTEGER_TYPES.has(String(q.type ?? ''))) {
      const constraint = String(q.constraint ?? '').trim();
      const bounds = constraint ? parseIntegerBounds(constraint) : null;
      if (constraint && !bounds) {
        unparsed.push({
          kind: 'constraint',
          field,
          path,
          expression: constraint,
          reason:
            'not a conjunction of `. >= <n>` / `. <= <n>` clauses — the integrality check still ' +
            'applies, but the bounds must be hand-declared as an addition',
        });
      }
      integerFields.push({ field, ...(bounds ?? {}) });
    }
  }

  const spec: DatasetSpec = {};
  if (conditionalFields.length) spec.conditionalFields = conditionalFields;
  if (integerFields.length) spec.integerFields = integerFields;

  return { spec, unparsed, questionsSeen, gatesParsed: conditionalFields.length };
}

/**
 * Merge hand-declared entries onto a derived spec as ADDITIONS.
 *
 * Never a replacement: the derived half is what the app actually declares, and
 * an author who replaces it re-creates the false green. Additions win only on
 * an exact duplicate (same field, same gate / same bounds key).
 */
export function mergeDatasetSpecs(derived: DatasetSpec, additions: DatasetSpec): DatasetSpec {
  const out: DatasetSpec = {};

  const conditionalKey = (c: ConditionalFieldSpec) =>
    `${c.field}|${c.requiredWhen.field}|${JSON.stringify(c.requiredWhen.equals)}`;
  const conditionals = new Map<string, ConditionalFieldSpec>();
  for (const c of derived.conditionalFields ?? []) conditionals.set(conditionalKey(c), c);
  for (const c of additions.conditionalFields ?? []) conditionals.set(conditionalKey(c), c);
  if (conditionals.size) out.conditionalFields = [...conditionals.values()];

  const integers = new Map<string, IntegerFieldSpec>();
  for (const f of derived.integerFields ?? []) integers.set(f.field, f);
  for (const f of additions.integerFields ?? []) {
    const prior = integers.get(f.field);
    integers.set(f.field, prior ? { ...prior, ...f } : f);
  }
  if (integers.size) out.integerFields = [...integers.values()];

  const currency = new Set([...(derived.wholeCurrencyFields ?? []), ...(additions.wholeCurrencyFields ?? [])]);
  if (currency.size) out.wholeCurrencyFields = [...currency];

  const rules = new Map<string, CrossFieldRule>();
  for (const r of [...(derived.crossFieldRules ?? []), ...(additions.crossFieldRules ?? [])]) {
    rules.set(`${r.lhs}|${r.op}|${r.rhs}`, r);
  }
  if (rules.size) out.crossFieldRules = [...rules.values()];

  const pairs = new Map<string, UniquePairSpec>();
  for (const p of [...(derived.uniquePairs ?? []), ...(additions.uniquePairs ?? [])]) {
    pairs.set(p.fields.join('|'), p);
  }
  if (pairs.size) out.uniquePairs = [...pairs.values()];

  return out;
}

// ── The post-generation branch scrub ────────────────────────────────

export interface ScrubFieldReport {
  field: string;
  path?: string;
  /** Records whose off-branch value for this field was removed. */
  recordsScrubbed: number;
  /** Records where the GATE field could not be located at all. */
  recordsGateMissing: number;
}

export interface ScrubReport {
  records: number;
  /** One entry per conditional spec, zeros included — a complete ledger. */
  fields: ScrubFieldReport[];
  totalCleared: number;
  /** Specs whose field could not be resolved in ANY record (ambiguous or absent). */
  unresolvedFields: string[];
}

type Container = Record<string, unknown>;

/**
 * Every leaf path in a record, dotted — `form.net_check.slept_under_net`.
 * Built once per record so resolution does not depend on knowing whether the
 * fixture nests under `form`, `form_json.form`, or nothing at all.
 */
function leafPaths(record: Container, prefix = '', out: Map<string, [Container, string]> = new Map()) {
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      leafPaths(value as Container, path, out);
    } else {
      out.set(path, [record, key]);
    }
  }
  return out;
}

/**
 * Resolve one spec field inside a record by longest matching XPath suffix.
 *
 * `/data/net_check/slept_under_net` matches `form.net_check.slept_under_net`
 * and a flat `slept_under_net` alike. A tie (two different leaves that both
 * match) resolves to nothing and is reported — guessing which one the form
 * meant is how a scrub would delete real data.
 */
function resolveField(
  index: Map<string, [Container, string]>,
  field: string,
  xpath?: string,
): [Container, string] | null {
  const wanted = (xpath ? xpath.split('/').filter(Boolean) : [field]).slice();
  const candidates: { key: string; score: number }[] = [];
  for (const key of index.keys()) {
    const parts = key.split('.');
    if (parts[parts.length - 1] !== wanted[wanted.length - 1]) continue;
    let score = 0;
    while (
      score < wanted.length &&
      score < parts.length &&
      parts[parts.length - 1 - score] === wanted[wanted.length - 1 - score]
    ) {
      score += 1;
    }
    candidates.push({ key, score });
  }
  if (candidates.length === 0) return null;
  const best = Math.max(...candidates.map((c) => c.score));
  const winners = candidates.filter((c) => c.score === best);
  if (winners.length !== 1) return null;
  return index.get(winners[0].key) ?? null;
}

/**
 * Remove every field value that its own `relevant` expression says cannot
 * exist on that record's branch.
 *
 * **Deletes rather than nulls.** CommCare does not submit a node the form
 * skipped, so an absent key is what real data looks like; `auditDataset`'s
 * `present()` and labs's path extraction both read a missing key and an
 * explicit `null` identically, so the choice costs nothing downstream and is
 * truer upstream.
 *
 * Pure and idempotent: input records are not mutated (the returned set is a
 * deep copy), and a second pass finds nothing left to remove.
 */
export function scrubOffBranchFields<T extends Container>(
  records: T[],
  conditionalFields: ConditionalFieldSpec[] = [],
): { records: T[]; report: ScrubReport } {
  const scrubbed: T[] = JSON.parse(JSON.stringify(records ?? []));
  const fields: ScrubFieldReport[] = [];
  const unresolvedFields: string[] = [];
  let totalCleared = 0;

  for (const spec of conditionalFields) {
    let recordsScrubbed = 0;
    let recordsGateMissing = 0;
    let resolvedAnywhere = false;

    for (const record of scrubbed) {
      const index = leafPaths(record);
      const gateRef = resolveField(index, spec.requiredWhen.field, spec.requiredWhen.path);
      const fieldRef = resolveField(index, spec.field, spec.path);
      if (fieldRef) resolvedAnywhere = true;
      if (!gateRef) {
        recordsGateMissing += 1;
        continue;
      }
      const [gateContainer, gateKey] = gateRef;
      if (gateContainer[gateKey] === spec.requiredWhen.equals) continue; // on-branch: keep
      if (!fieldRef) continue; // already absent — the idempotent case
      const [container, key] = fieldRef;
      if (container[key] === undefined) continue;
      delete container[key];
      recordsScrubbed += 1;
    }

    if (!resolvedAnywhere) unresolvedFields.push(spec.field);
    totalCleared += recordsScrubbed;
    fields.push({ field: spec.field, path: spec.path, recordsScrubbed, recordsGateMissing });
  }

  return {
    records: scrubbed,
    report: { records: scrubbed.length, fields, totalCleared, unresolvedFields },
  };
}

export function formatScrubReport(report: ScrubReport): string {
  const lines = [
    `branch-scrub: cleared ${report.totalCleared} off-branch value(s) across ${report.records} record(s)`,
  ];
  for (const f of report.fields) {
    lines.push(
      `  ${f.field}: ${f.recordsScrubbed} cleared` +
        (f.recordsGateMissing ? `, ${f.recordsGateMissing} record(s) with no gate field` : ''),
    );
  }
  if (report.unresolvedFields.length) {
    lines.push(
      `  UNRESOLVED (never located in any record, so never scrubbed): ${report.unresolvedFields.join(', ')}`,
    );
  }
  return lines.join('\n');
}
