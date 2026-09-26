/**
 * Does the released Deliver app's capped index admit exactly as many payable
 * keys as the per-entity cap allows?
 *
 * ## Why this exists (dimagi-internal/ace#2148)
 *
 * `_app-component-library § payability-scoped-key` routes the per-entity cap
 * through the dedup key: Connect dedups on `entity_id` and never reads the
 * app's own `is_payable` flag, so "the cap is enforced by deduplication, not by
 * the app refusing a submission." The app therefore puts a CLAMPED counter in
 * the key — a fresh index per payable encounter until the cap, then the same
 * index forever after, so the over-cap encounters collide onto a key Connect
 * has already paid.
 *
 * The clamp constant and the cap are NOT the same number, and which way they
 * differ depends on when the counter is read. On
 * `spark-facilitator/20260906-2233` the per-step cap was 3 and the app shipped:
 *
 * ```
 * payable_count_this_step = <paid meetings on that step, from casedb>
 * capped_index            = if(payable_count_this_step >= 3, 3, payable_count_this_step)
 * entity_key              = concat(case_id, '-', step, '-', capped_index, '-', outcome_code)
 * ```
 *
 * A `casedb` read is the state BEFORE this submission, so the k-th payable
 * meeting reads `k - 1`: indices 0, 1, 2 — and then the FOURTH reads 3, which
 * `>= 3` clamps to 3, an index that has never existed. Connect mints a fresh
 * CompletedWork for it and pays it; only the fifth onward collide. A cap of 3
 * silently became a cap of 4, i.e. 28 payable events against a declared
 * `total_cap_per_flw` of 21. The app's own `is_payable` was correctly 0 on that
 * fourth meeting and it made no difference, because nothing downstream reads
 * it.
 *
 * Nothing at build time could see it: `validate_app`, `compile_app` and
 * `make_build` all pass, the CCZ is structurally perfect, and the app is
 * internally consistent with its own wrong key. It surfaced only because
 * `pdd-to-deliver-app-eval` re-derived the arithmetic by hand.
 *
 * ## The invariant, and why a formula is not good enough
 *
 * The obvious statement — "clamp at `cap - 1` when the counter is read before
 * this submission is added" — is right for the `min(counter, K)` shape and
 * silently wrong for the shape ACE actually shipped the FIX as, where the
 * comparison threshold and the clamped value are different numbers
 * (`if(pcts >= 3, 2, pcts)`). So this module does not evaluate a formula. It
 * SIMULATES the first several submissions and counts the distinct indices —
 * the same hand-trace the eval did, done mechanically. `payableKeyIndices` is
 * the primitive; every verdict here is derived from it.
 *
 * ## What decides the counter's timing
 *
 * A `casedb` read is always the pre-submission state, because the case
 * property is written on submit. So:
 *
 *   - counter resolves to a `casedb` read           -> `pre-increment`
 *   - counter resolves to a `casedb` read plus one  -> `includes-current`
 *
 * Both shapes are live in ACE today, in the same opportunity, five weeks
 * apart. Released build `b08533bdf26a48a295a362ff204fb88d`
 * (`spark-facilitator/20260828-0703`) clamps `min(<casedb count> + 1, 3)` —
 * `includes-current`, indices 1..3, three payable. Released build
 * `0cb63a78fd9949b696876ee7a642b685` (`spark-facilitator/20260906-2233`,
 * post-fix) clamps `if(pcts >= 3, 2, pcts)` over a bare `casedb` read —
 * `pre-increment`, indices 0..2, three payable. Both are CORRECT and they
 * share no constant, which is exactly why a rule about the constant alone
 * cannot gate this and a simulation can.
 *
 * "Resolves to" means the counter is EVALUATED as (casedb count + an integer
 * offset) across every node it reads, wherever the `+ 1` sits — in the
 * clamp's own counter expression (`stored_index + 1`, the casedb read one hop
 * down) as much as inside the node that reads the case (ace#2480; the old
 * "one part holds both" rule called that pre-increment and proposed a remedy
 * that under-paid).
 *
 * A counter this module cannot reduce to a `casedb` read plus 0 or 1 is
 * reported `unable`, never assumed. Guessing the timing is guessing at payment.
 */

import { DOMParser } from '@xmldom/xmldom';
import { extractEntityIdComponents } from './entity-id-grain.js';
import { type CheckOutcome, checked, unable, formatUnable } from './check-outcome.js';

/**
 * When the counter the clamp reads is measured, relative to the submission
 * being keyed.
 */
export type CounterTiming =
  /** The counter excludes this submission (the usual case — a `casedb` read). */
  | 'pre-increment'
  /** The counter already counts this submission (`<casedb read> + 1`). */
  | 'includes-current';

/**
 * A clamp, normalised so every supported spelling simulates identically.
 *
 * `threshold` is the SMALLEST counter value at which `clampedValue` is
 * emitted. `min(x, 3)` and `if(x >= 3, 3, x)` and `if(x > 2, 3, x)` all
 * normalise to `{ threshold: 3, clampedValue: 3 }`; the shipped fix
 * `if(x >= 3, 2, x)` normalises to `{ threshold: 3, clampedValue: 2 }`.
 */
export interface Clamp {
  /** The expression being clamped — the counter, verbatim. */
  counter: string;
  /** Smallest counter value at which `clampedValue` is emitted. */
  threshold: number;
  /** The index emitted from `threshold` onward. */
  clampedValue: number;
  /** The clamp sub-expression, verbatim. */
  raw: string;
}

/** Collapse whitespace so two spellings of one expression compare equal. */
function norm(expr: string): string {
  return expr.replace(/\s+/g, '');
}

/** Parse an integer literal, or `null` if the text is not one. */
function intLiteral(expr: string): number | null {
  const t = expr.trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
}

/** Index of the `)` matching the `(` at `open`, or `-1`. */
function matchingParen(expr: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Split a call's argument list at top level, quote- and paren-aware. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((a) => a.trim());
}

/**
 * `{ counter, threshold }` for a comparison that fires once the counter
 * reaches the cap — in either operand order, for `>`, `>=`, `<` and `<=`.
 *
 * `fireOnTrue` says whether the comparison being TRUE selects the clamped
 * value; an `if(x < 3, x, 3)` is the same clamp written inside out.
 */
function parseComparison(
  cond: string,
  fireOnTrue: boolean,
): { counter: string; threshold: number } | null {
  const m = cond.match(/^(.*?)(>=|<=|>|<)(.*)$/s);
  if (!m) return null;
  const [, leftRaw, op, rightRaw] = m;
  const left = leftRaw.trim();
  const right = rightRaw.trim();

  // Orient so `counter <op> N`.
  let counter: string;
  let n: number | null;
  let oriented: string;
  const rightN = intLiteral(right);
  const leftN = intLiteral(left);
  if (rightN !== null && leftN === null) {
    counter = left;
    n = rightN;
    oriented = op;
  } else if (leftN !== null && rightN === null) {
    counter = right;
    n = leftN;
    oriented = { '>=': '<=', '<=': '>=', '>': '<', '<': '>' }[op] as string;
  } else {
    return null;
  }
  if (n === null || !counter) return null;

  // The TRUE branch fires at `>= t`. When the false branch is the clamped
  // one, invert the comparison first.
  const effective = fireOnTrue
    ? oriented
    : ({ '>=': '<', '<=': '>', '>': '<=', '<': '>=' }[oriented] as string);
  if (effective === '>=') return { counter, threshold: n };
  if (effective === '>') return { counter, threshold: n + 1 };
  return null;
}

/** Parse ONE expression as a clamp. Returns `null` if it is not one. */
export function parseClamp(expr: string): Clamp | null {
  const raw = expr.trim();

  if (/^min\s*\(/.test(raw)) {
    const open = raw.indexOf('(');
    if (matchingParen(raw, open) !== raw.length - 1) return null;
    const args = splitArgs(raw.slice(open + 1, -1));
    if (args.length !== 2) return null;
    const [a, b] = args;
    const an = intLiteral(a);
    const bn = intLiteral(b);
    if (an === null && bn !== null) return { counter: a, threshold: bn, clampedValue: bn, raw };
    if (bn === null && an !== null) return { counter: b, threshold: an, clampedValue: an, raw };
    return null;
  }

  if (/^if\s*\(/.test(raw)) {
    const open = raw.indexOf('(');
    if (matchingParen(raw, open) !== raw.length - 1) return null;
    const args = splitArgs(raw.slice(open + 1, -1));
    if (args.length !== 3) return null;
    const [cond, thenArg, elseArg] = args;
    const thenN = intLiteral(thenArg);
    const elseN = intLiteral(elseArg);

    // `if(<cmp>, <N>, <counter>)` — the true branch is the clamped value.
    if (thenN !== null && elseN === null) {
      const cmp = parseComparison(cond, true);
      if (cmp && norm(cmp.counter) === norm(elseArg)) {
        return { counter: cmp.counter, threshold: cmp.threshold, clampedValue: thenN, raw };
      }
      return null;
    }
    // `if(<cmp>, <counter>, <N>)` — written inside out.
    if (elseN !== null && thenN === null) {
      const cmp = parseComparison(cond, false);
      if (cmp && norm(cmp.counter) === norm(thenArg)) {
        return { counter: cmp.counter, threshold: cmp.threshold, clampedValue: elseN, raw };
      }
      return null;
    }
    return null;
  }

  return null;
}

/**
 * The first clamp anywhere inside an expression.
 *
 * Nova puts the clamp wherever the surrounding branch logic needs it — on
 * build `b08533bd…` it sits three `if()`s deep, inside the payable branch of
 * a same-step test — so a top-level-only parse reads a correct build as
 * having no cap at all.
 */
export function findClamp(expr: string): Clamp | null {
  for (let i = 0; i < expr.length; i++) {
    if (!/[mi]/.test(expr[i])) continue;
    if (!/^(min|if)\s*\(/.test(expr.slice(i))) continue;
    // Not a call if the preceding character can be part of an identifier.
    if (i > 0 && /[\w-]/.test(expr[i - 1])) continue;
    const open = expr.indexOf('(', i);
    const close = matchingParen(expr, open);
    if (close === -1) continue;
    const clamp = parseClamp(expr.slice(i, close + 1));
    if (clamp) return clamp;
  }
  return null;
}

/**
 * The index each of the first `submissions` PAYABLE submissions writes into
 * the key, in order. The hand-trace, mechanised.
 */
export function payableKeyIndices(
  clamp: Pick<Clamp, 'threshold' | 'clampedValue'>,
  timing: CounterTiming,
  submissions: number,
): number[] {
  const out: number[] = [];
  for (let k = 1; k <= submissions; k++) {
    const counter = timing === 'pre-increment' ? k - 1 : k;
    out.push(counter >= clamp.threshold ? clamp.clampedValue : counter);
  }
  return out;
}

/** How many submissions are simulated to settle a clamp's capacity. */
function horizon(clamp: Pick<Clamp, 'threshold'>): number {
  return Math.max(clamp.threshold + 2, 3);
}

/**
 * How many distinct payable keys the clamp admits — the number of encounters
 * Connect will pay for on one entity.
 *
 * Derived by simulation, never by formula. Once the counter is past the
 * threshold every further submission repeats `clampedValue`, so the distinct
 * count is settled by `threshold + 2` submissions.
 */
export function payableCapacity(
  clamp: Pick<Clamp, 'threshold' | 'clampedValue'>,
  timing: CounterTiming,
): number {
  return new Set(payableKeyIndices(clamp, timing, horizon(clamp))).size;
}

/**
 * The 1-based submission at which the clamp admits one key too many, or
 * `null` when it never does.
 */
export function firstOvercappedSubmission(
  clamp: Pick<Clamp, 'threshold' | 'clampedValue'>,
  timing: CounterTiming,
  cap: number,
): number | null {
  const seen = new Set<number>();
  const indices = payableKeyIndices(clamp, timing, horizon(clamp));
  for (let i = 0; i < indices.length; i++) {
    seen.add(indices[i]);
    if (seen.size > cap) return i + 1;
  }
  return null;
}

/**
 * A clamp expression that admits exactly `cap` payable keys, written in the
 * spelling ACE has shipped for that timing.
 */
export function canonicalClampExpression(
  counter: string,
  cap: number,
  timing: CounterTiming,
): string {
  return timing === 'pre-increment'
    ? `if(${counter} >= ${cap}, ${cap - 1}, ${counter})`
    : `min(${counter}, ${cap})`;
}

// ── Reading it off a released form ──────────────────────────────────────────

/**
 * Every `<bind>` carrying a `calculate`, by nodeset.
 *
 * Deliberately a local read rather than a shared one: the DOM parse is four
 * lines and this module must keep working if `entity-id-grain` changes what
 * it needs from a bind. Entities are decoded by the parser, so a `calculate`
 * written `&lt;` in the CCZ arrives here as `<`.
 */
function calculateBinds(xml: string): Map<string, string> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const out = new Map<string, string>();
  for (const b of Array.from(doc.getElementsByTagName('bind'))) {
    const nodeset = b.getAttribute('nodeset');
    const calculate = b.getAttribute('calculate');
    if (nodeset && calculate) out.set(nodeset, calculate);
  }
  return out;
}

/** Bound on sub-expressions + node hops the counter evaluator descends. */
const MAX_EVAL_DEPTH = 16;

const CASEDB = /instance\(\s*'casedb'\s*\)/;
/** A bare casedb path read — `instance('casedb')/casedb/case[…]/prop`. */
const CASEDB_READ = /^instance\(\s*'casedb'\s*\)\/[^\s,()]*(?:\[[^\]]*\][^\s,()]*)*$/;
const SINGLE_DATA_PATH = /^\/data\/[A-Za-z_][\w-]*(?:\/[A-Za-z_][\w-]*)*$/;
const STRING_LITERAL = /^(?:'[^']*'|"[^"]*")$/;

/** Strip whitespace and any parentheses wrapping the WHOLE expression. */
function unwrap(expr: string): string {
  let t = expr.trim();
  while (t.startsWith('(') && matchingParen(t, 0) === t.length - 1) t = t.slice(1, -1).trim();
  return t;
}

/**
 * Split at top-level `+` / `-` into signed terms, quote- and paren-aware.
 *
 * A `-` counts as an operator only with whitespace on both sides: XPath
 * names (`/data/step-count`) may contain hyphens.
 */
function additiveTerms(expr: string): Array<{ sign: 1 | -1; term: string }> {
  const out: Array<{ sign: 1 | -1; term: string }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  let sign: 1 | -1 = 1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === '+' || (c === '-' && /\s/.test(expr[i - 1] ?? '') && /\s/.test(expr[i + 1] ?? '')))) {
      out.push({ sign, term: expr.slice(start, i).trim() });
      sign = c === '+' ? 1 : -1;
      start = i + 1;
    }
  }
  out.push({ sign, term: expr.slice(start).trim() });
  return out;
}

/**
 * The counter's value relative to the stored `casedb` count, evaluated
 * across every hop: `0` means it IS the pre-submission count, `1` means the
 * count plus this submission. `null` when the expression cannot be reduced
 * to "one casedb count plus an integer constant".
 *
 * This evaluates rather than pattern-matches (ace#2480). Asking "does one
 * resolved part contain both a casedb read and a `+ 1`" misreads a counter
 * whose `+ 1` sits in the clamp's own expression while the casedb read lives
 * one hop down — `stored_index + 1` over `stored_index = <casedb read>` — as
 * pre-increment, and then proposes a remedy that under-pays.
 *
 * Branching (`if`, `cond`) evaluates every non-literal value branch and
 * requires them to agree; literal branches are the empty-case default
 * (`if(<read> = '', 0, number(<read>))`) or a no-selection fallback, and
 * carry no timing. A `+ 1` in a CONDITION is never a term, so an unrelated
 * increment elsewhere in the chain cannot flip the answer.
 */
function counterOffset(
  expr: string,
  binds: Map<string, string>,
  depth = 0,
  visiting: Set<string> = new Set(),
): number | null {
  if (depth > MAX_EVAL_DEPTH) return null;
  const t = unwrap(expr);
  if (!t) return null;

  const terms = additiveTerms(t);
  if (terms.length > 1) {
    let offset = 0;
    let counterTerm: string | null = null;
    for (const { sign, term } of terms) {
      const n = intLiteral(term);
      if (n !== null) offset += sign * n;
      else if (counterTerm === null && sign === 1) counterTerm = term;
      else return null;
    }
    if (counterTerm === null) return null;
    const inner = counterOffset(counterTerm, binds, depth + 1, visiting);
    return inner === null ? null : inner + offset;
  }

  if (CASEDB_READ.test(t)) return 0;

  if (SINGLE_DATA_PATH.test(t)) {
    const calc = binds.get(t);
    if (calc === undefined || visiting.has(t)) return null;
    visiting.add(t);
    const r = counterOffset(calc, binds, depth + 1, visiting);
    visiting.delete(t);
    return r;
  }

  const call = /^([\w-]+)\s*\(/.exec(t);
  if (!call || matchingParen(t, t.indexOf('(')) !== t.length - 1) return null;
  const args = splitArgs(t.slice(t.indexOf('(') + 1, -1));
  const fn = call[1];

  if (fn === 'number' && args.length === 1) return counterOffset(args[0], binds, depth + 1, visiting);
  // A count over casedb is the pre-submission count.
  if (fn === 'count' && args.length === 1 && CASEDB.test(args[0])) return 0;

  let values: string[] | null = null;
  if (fn === 'if' && args.length === 3) values = [args[1], args[2]];
  else if (fn === 'cond' && args.length >= 3 && args.length % 2 === 1) {
    values = args.filter((_, i) => i % 2 === 1 || i === args.length - 1);
  }
  if (!values) return null;

  let agreed: number | null = null;
  for (const v of values) {
    const u = unwrap(v);
    if (intLiteral(u) !== null || STRING_LITERAL.test(u)) continue;
    const r = counterOffset(u, binds, depth + 1, visiting);
    if (r === null || (agreed !== null && r !== agreed)) return null;
    agreed = r;
  }
  return agreed;
}

/**
 * Whether the counter the clamp reads already counts this submission.
 *
 * Decided by EVALUATING the counter as (casedb count + constant offset)
 * across every hop it resolves through — never by where a `+ 1` happens to
 * sit (ace#2480). Offset 0 is `pre-increment`, offset 1 is
 * `includes-current`.
 *
 * `null` means undecidable from the form — the counter never reduces to a
 * `casedb` read plus 0 or 1, so nothing here knows what it counts. That is an
 * `unable`, not a default: assuming a timing is assuming a payment.
 */
export function classifyCounterTiming(
  counterExpr: string,
  binds: Map<string, string>,
): CounterTiming | null {
  const offset = counterOffset(counterExpr, binds);
  if (offset === 0) return 'pre-increment';
  if (offset === 1) return 'includes-current';
  return null;
}

/**
 * The cap the app's OWN payability guard implies, so the check still runs
 * when no declared cap is plumbed through.
 *
 * `is_payable` and the clamp are two encodings of one number, and on the
 * ace#2148 build they disagreed — `is_payable` was right and the key was
 * wrong. Reading both makes that disagreement decidable from the form alone.
 */
export function capFromPayabilityGuard(
  xml: string,
  counter: string,
  timing: CounterTiming,
): number | null {
  const binds = calculateBinds(xml);
  const wanted = norm(counter);
  // `is_payable` first: it is the guard by convention, and a counter node is
  // also `payable`-named on every build ACE has shipped.
  const candidates = [...binds].sort(
    (a, b) => Number(/is_payable$/.test(b[0])) - Number(/is_payable$/.test(a[0])),
  );
  for (const [nodeset, calc] of candidates) {
    if (!/payable/i.test(nodeset)) continue;
    for (const m of calc.matchAll(/([^\s(),]+)\s*(<=|<)\s*(\d+)/g)) {
      const [, lhs, op, nRaw] = m;
      if (norm(lhs) !== wanted) continue;
      const n = Number(nRaw);
      if (op === '<') return timing === 'pre-increment' ? n : n - 1;
      return timing === 'pre-increment' ? n + 1 : n;
    }
  }
  return null;
}

export type PayableCapFindingKind =
  /** The key admits exactly one more (or one fewer) payable event than the cap. */
  | 'payable-cap-off-by-one'
  /** The key and the cap disagree by more than one. */
  | 'payable-cap-mismatch'
  /** No clamp can express this cap — a cap below 1 is not a dedup problem. */
  | 'payable-cap-not-expressible';

export interface PayableCapFinding {
  kind: PayableCapFindingKind;
  /** The node whose `calculate` carries the clamp. */
  node: string;
  timing: CounterTiming;
  threshold: number;
  clampedValue: number;
  /** Distinct payable keys the clamp admits. */
  capacity: number;
  /** The cap it should admit. */
  cap: number;
  capSource: CapSource;
  /** 1-based submission that mints a key it should not, when over cap. */
  firstOvercapped: number | null;
  /** A clamp expression that would admit exactly `cap`. */
  remedy: string;
  detail: string;
}

export type CapSource = 'declared' | 'is_payable';

export interface PayableCapExtra {
  node: string | null;
  clamp: Clamp | null;
  timing: CounterTiming | null;
  capacity: number | null;
  cap: number | null;
  capSource: CapSource | null;
  /** The first several submissions' key indices — the trace, for the report. */
  indices: number[];
}

export type PayableCapReport = CheckOutcome<PayableCapFinding, PayableCapExtra>;

/**
 * Check a released Deliver form's capped index against the per-entity cap.
 *
 * `declaredCap` is the PDD's per-entity cap (`program_parameters`, or the
 * per-step cap § Payment Model states). When it is absent the app's own
 * `is_payable` guard supplies it; when neither does, the check reports
 * `unable`.
 */
export function checkPayableCapArithmetic(
  formXml: string,
  opts: { declaredCap?: number } = {},
): PayableCapReport {
  const entity = extractEntityIdComponents(formXml);
  if (!entity.resolved) {
    return unable(
      'no readable `entity_id` calculate in this form — there is no dedup key to carry a capped index',
    );
  }
  if (entity.components.length === 0) {
    return unable(
      'the `entity_id` calculate resolves to no components — nothing in the key can be a capped index',
    );
  }

  const binds = calculateBinds(formXml);
  let node: string | null = null;
  let clamp: Clamp | null = null;
  for (const component of entity.components) {
    const expr = binds.get(component.trim()) ?? component;
    const found = findClamp(expr);
    if (found) {
      node = component.trim();
      clamp = found;
      break;
    }
  }
  if (!clamp || !node) {
    return unable(
      `no clamped counter in \`entity_id\` (components: ${entity.components.join(', ')}) — ` +
        'this form does not cap payable events per entity through the key, so there is no ' +
        'cap arithmetic to check. If the PDD DOES declare a per-entity cap, that is the ' +
        'finding: the cap is not enforced at all.',
    );
  }

  const timing = classifyCounterTiming(clamp.counter, binds);
  if (!timing) {
    return unable(
      `the counter \`${clamp.counter}\` in \`${node}\` never reduces to a casedb read plus 0 or 1, so ` +
        'whether it already counts this submission cannot be decided from the form. ' +
        'Read the counter by hand and call `payableCapacity` with the timing.',
    );
  }

  const declared = opts.declaredCap;
  const derived = declared === undefined ? capFromPayabilityGuard(formXml, clamp.counter, timing) : null;
  const cap = declared ?? derived;
  const capSource: CapSource | null = declared !== undefined ? 'declared' : derived !== null ? 'is_payable' : null;
  if (cap === null || capSource === null) {
    return unable(
      `\`${node}\` clamps \`${clamp.counter}\`, but no per-entity cap is available to check it ` +
        'against — pass the PDD\'s cap as `declaredCap`, or give the form an `is_payable` ' +
        'guard over the same counter.',
    );
  }

  const capacity = payableCapacity(clamp, timing);
  const indices = payableKeyIndices(clamp, timing, horizon(clamp));
  const extra: PayableCapExtra = {
    node,
    clamp,
    timing,
    capacity,
    cap,
    capSource,
    indices,
  };

  if (cap < 1) {
    return {
      ...checked<PayableCapFinding>(false, [
        {
          kind: 'payable-cap-not-expressible',
          node,
          timing,
          threshold: clamp.threshold,
          clampedValue: clamp.clampedValue,
          capacity,
          cap,
          capSource,
          firstOvercapped: 1,
          remedy: 'remove the payable deliver marker, or make the branch non-payable',
          detail:
            `cap of ${cap} cannot be expressed by a clamped index: every clamp admits at ` +
            'least one key, so the first submission is always payable. A cap below 1 is a ' +
            'payability question, not a dedup one.',
        },
      ]),
      ...extra,
    };
  }

  if (capacity === cap) return { ...checked<PayableCapFinding>(true, []), ...extra };

  const firstOvercapped = firstOvercappedSubmission(clamp, timing, cap);
  const traced = indices.map((v, i) => `#${i + 1}->${v}`).join(' ');
  return {
    ...checked<PayableCapFinding>(false, [
      {
        kind: Math.abs(capacity - cap) === 1 ? 'payable-cap-off-by-one' : 'payable-cap-mismatch',
        node,
        timing,
        threshold: clamp.threshold,
        clampedValue: clamp.clampedValue,
        capacity,
        cap,
        capSource,
        firstOvercapped,
        remedy: canonicalClampExpression(clamp.counter, cap, timing),
        detail:
          `\`${node}\` = ${clamp.raw} over a ${timing} counter admits ${capacity} distinct ` +
          `payable key(s) per entity against a cap of ${cap} (${capSource}). Trace: ${traced}.` +
          (firstOvercapped === null
            ? ' The key under-counts: an encounter inside the cap collides onto one already paid.'
            : ` Submission #${firstOvercapped} mints a key that has never existed, so Connect ` +
              'creates a CompletedWork for it and pays it.'),
      },
    ]),
    ...extra,
  };
}

/** Render a report for a build memo / verdict. Never green on `unable`. */
export function formatPayableCapReport(report: PayableCapReport): string {
  if (report.status === 'unable') return formatUnable('payable-cap-arithmetic', report.reason);
  if (report.ok) {
    return (
      `payable-cap-arithmetic: clean — ${report.node} admits ${report.capacity} payable ` +
      `key(s) per entity against a cap of ${report.cap} (${report.capSource}, ${report.timing})`
    );
  }
  return [
    'payable-cap-arithmetic: the key does NOT enforce the declared cap.',
    ...report.findings.map((f) => `  [${f.kind}] ${f.detail}`),
    ...report.findings.map((f) => `  remedy: ${f.node} = ${f.remedy}`),
  ].join('\n');
}
