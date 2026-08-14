/**
 * Can two required questions that capture the SAME real-world value both be
 * satisfied on the same walk path?
 *
 * Why this exists (dimagi-internal/ace#1015): on
 * spark-facilitator/20260728-1338 (Deliver app 67ec398d, form
 * `record_a_community_meeting`) the `savings` group carried no `relevant`, so
 * it displayed on BOTH branches of `meeting_conducted`. On the
 * did-not-happen branch the CBF was asked, in order:
 *
 * ```
 * meeting_did_not_happen/reschedule_date   . >= today()
 * savings/next_meeting_date                . > today() and . <= today() + 30
 * ```
 *
 * A CBF who reschedules for TODAY satisfies the first and is then hard-blocked
 * on the second, with no way to reconcile — on exactly the branch the PDD
 * requires to be "reachable without friction" (a CBF honestly reporting a
 * meeting that did not happen is doing the right thing).
 *
 * All three existing `field_answerability` hard-gates correctly PASS on this
 * form: no outcome-before-inputs, every constraint is local with a local
 * `validate_msg`, every relevance references an earlier field. The defect is a
 * fourth class — and it is only unsatisfiable at the EDGE, which is why
 * per-field analysis and a happy-path smoke walk both miss it.
 *
 * ## What is mechanical and what is not
 *
 * Deciding that two fields capture the same real-world value is semantic —
 * that stays the judge's call. What the pair IMPLIES once identified is
 * arithmetic, and lives here so it is not eyeballed.
 *
 * The parser understands only `today()`-relative comparisons on `.`, which is
 * the common date shape. Anything else returns `unparsed`, and a pair with an
 * unparsed side returns `'unknown'` rather than `true` — a checker that
 * silently passes what it could not read is how this class survives.
 *
 * ## Narrowed is a finding too
 *
 * The live pair's full ranges DO intersect (`[1, 30]`). Reporting it as
 * "unsatisfiable" would be wrong and would train readers to ignore the check.
 * The real finding is that the second question NARROWS what the first allowed
 * — the worker can pick a date the form already accepted and then be blocked.
 * So `narrowed` is reported separately from `satisfiable`.
 */

export interface DayRange {
  kind: 'range';
  /** Days relative to today; null = unbounded. Inclusive. */
  min: number | null;
  max: number | null;
}

export interface UnparsedConstraint {
  kind: 'unparsed';
}

export type ParsedConstraint = DayRange | UnparsedConstraint;

export interface ConstrainedField {
  id: string;
  required: boolean;
  constraint?: string;
}

const UNPARSED: UnparsedConstraint = { kind: 'unparsed' };

/** One `. <op> today() [+|- N]` comparison → the day range it permits. */
function parseComparison(text: string): DayRange | null {
  const m = /^\.\s*(>=|<=|>|<|=)\s*today\(\)\s*(?:([+-])\s*(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const [, op, sign, digits] = m;
  const offset = digits ? Number(digits) * (sign === '-' ? -1 : 1) : 0;
  switch (op) {
    case '>=': return { kind: 'range', min: offset, max: null };
    case '>':  return { kind: 'range', min: offset + 1, max: null };
    case '<=': return { kind: 'range', min: null, max: offset };
    case '<':  return { kind: 'range', min: null, max: offset - 1 };
    case '=':  return { kind: 'range', min: offset, max: offset };
    default:   return null;
  }
}

/**
 * A whole constraint expression → the day range it permits.
 *
 * Handles a single comparison or several joined by `and`. `or` is deliberately
 * NOT handled: a disjunction is not an interval, and approximating it as one
 * would make the checker claim things it cannot know.
 */
export function parseTodayRelativeConstraint(expr: string | undefined): ParsedConstraint {
  if (!expr || !expr.trim()) return UNPARSED;
  if (/\bor\b/i.test(expr)) return UNPARSED;
  const parts = expr.split(/\s+and\s+/i);
  let acc: DayRange = { kind: 'range', min: null, max: null };
  for (const part of parts) {
    const r = parseComparison(part);
    if (!r) return UNPARSED;
    const merged = intersectRanges(acc, r);
    if (!merged) return { kind: 'range', min: 1, max: 0 }; // self-contradictory, empty
    acc = merged;
  }
  return acc;
}

/** The overlap of two ranges, or null when they do not overlap. */
export function intersectRanges(a: DayRange, b: DayRange): DayRange | null {
  const min = a.min === null ? b.min : b.min === null ? a.min : Math.max(a.min, b.min);
  const max = a.max === null ? b.max : b.max === null ? a.max : Math.min(a.max, b.max);
  if (min !== null && max !== null && min > max) return null;
  return { kind: 'range', min, max };
}

export interface PairVerdict {
  /** true / false, or a non-answer when the checker must not guess. */
  satisfiable: boolean | 'unknown' | 'not-applicable';
  /** The second question rejects values the first accepted. */
  narrowed: boolean;
  detail: string;
}

function describe(r: DayRange): string {
  const lo = r.min === null ? 'any earlier date' : r.min === 0 ? 'today' : `today${r.min > 0 ? '+' : ''}${r.min}`;
  const hi = r.max === null ? 'any later date' : r.max === 0 ? 'today' : `today${r.max > 0 ? '+' : ''}${r.max}`;
  return `${lo} … ${hi}`;
}

/**
 * Given two fields the judge has identified as capturing the same real-world
 * value on one walk path, can both be satisfied — and does the second reject
 * anything the first accepted?
 */
export function checkPairSatisfiable(a: ConstrainedField, b: ConstrainedField): PairVerdict {
  if (!a.required || !b.required) {
    return {
      satisfiable: 'not-applicable',
      narrowed: false,
      detail: 'one of the pair is optional — the collision is with REQUIREDNESS, so there is nothing to reconcile',
    };
  }
  const ra = parseTodayRelativeConstraint(a.constraint);
  const rb = parseTodayRelativeConstraint(b.constraint);
  if (ra.kind === 'unparsed' || rb.kind === 'unparsed') {
    return {
      satisfiable: 'unknown',
      narrowed: false,
      detail:
        `could not read ${ra.kind === 'unparsed' ? a.id : b.id}'s constraint as a today()-relative range — ` +
        'judge this pair by hand rather than treating an unread constraint as satisfied',
    };
  }
  const overlap = intersectRanges(ra, rb);
  if (!overlap) {
    return {
      satisfiable: false,
      narrowed: true,
      detail:
        `no date satisfies both: ${a.id} permits ${describe(ra)}, ${b.id} permits ${describe(rb)}. ` +
        'A worker who answers the first legitimately is hard-blocked on the second with no way to reconcile',
    };
  }
  const narrowed =
    (rb.min !== null && (ra.min === null || rb.min > ra.min)) ||
    (rb.max !== null && (ra.max === null || rb.max < ra.max));
  return {
    satisfiable: true,
    narrowed,
    detail: narrowed
      ? `${b.id} narrows ${a.id}: the pair is only satisfiable over ${describe(overlap)}, so a worker can ` +
        `answer ${a.id} with a date the form ACCEPTED (e.g. today) and then be blocked on ${b.id}. ` +
        'Ask the value once, or align the two constraints'
      : `both are satisfiable over ${describe(overlap)}`,
  };
}
