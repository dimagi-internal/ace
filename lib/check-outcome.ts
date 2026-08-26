/**
 * `CheckOutcome` — the shape that makes "I checked and it's fine" and
 * "I never looked" impossible to confuse.
 *
 * ## The defect this exists to make unrepresentable
 *
 * ACE's structural helpers used to return `{ checked: boolean; ok: boolean;
 * findings }`, and every one of them set `ok: true` on the not-run path:
 *
 * ```ts
 * // lib/scoring-arithmetic.ts, before this module
 * if (items.length === 0) {
 *   return { checked: false, ok: true, itemScores: [], findings: [] };
 * }
 * ```
 *
 * A caller reading `.ok` cannot tell "verified fine" from "didn't look." Both
 * read `true`. Every one of those helpers carries a comment saying `checked:
 * false` is "not applicable, NOT a pass" — prose that only binds a reader who
 * reads it, on a field the type system happily lets you ignore.
 *
 * It cost a real run. On `bednet-check-2-visit/20260825-1310`,
 * `checkScoringArithmetic` returned `checked: false` for BOTH Learn scoring
 * forms — including the gating assessment — because its `ITEM_SCORE` regex was
 * depth-anchored at `/data/<name>_score` while Nova nests fields inside their
 * section container. The scoring gate covered nothing and reported fine. That
 * was dimagi-internal/ace#1634, the FOURTH instance of the same
 * regex-blindness class (#1332 → #1538 → #1576 → #1634): each time, the check
 * matched zero inputs, took the not-run path, and the `ok: true` on that path
 * turned a blind check into a green one.
 *
 * The regex bugs are individually fixable and will recur — that is the nature
 * of matching against artifacts another system generates. What must not recur
 * is a blind check RENDERING AS A PASS. So the two states stop being two
 * booleans and become one discriminant: `.ok` is unreachable without first
 * narrowing on `.status`, and the compiler enforces the narrowing.
 *
 * ## Contract
 *
 * - `status: 'checked'` — the check RAN. `ok` then means what it says.
 * - `status: 'unable'` — the check did not run, and `reason` says why in
 *   human-readable prose. There is no `ok` on this branch to misread.
 *
 * `reason` is REQUIRED because "I could not check" is only useful if it says
 * why: an unexplained not-applicable is indistinguishable from a bug in the
 * matcher, which is exactly what all four of the cited issues were.
 *
 * ## Rendering
 *
 * `formatUnable` is the one renderer for the `unable` branch. It never emits
 * "PASS", "clean", or any green-looking string — the report an operator reads
 * must not look like a pass either.
 *
 * *Enforced:* `test/lib/check-outcome-contract.test.ts` scans `lib/*.ts`
 * source and fails any helper that reintroduces the two-boolean shape.
 */

/** The check ran. `ok` is a real verdict about `findings`. */
export interface CheckedOutcome<F> {
  status: 'checked';
  /** True iff the check ran to completion and found nothing. */
  ok: boolean;
  findings: F[];
}

/**
 * The check did not run. There is deliberately NO `ok` here — a caller that
 * wants to treat this as a pass has to say so in as many words.
 */
export interface UnableOutcome {
  status: 'unable';
  /** Why the check could not run, in prose an operator can act on. */
  reason: string;
}

/**
 * `Extra` carries whatever payload a specific check reports alongside its
 * findings (`itemScores`, `components`, `blind`, …). It attaches to the
 * `checked` branch only, so reaching it also requires narrowing — a report
 * field read off an unrun check is a compile error, not a silent `undefined`.
 */
export type CheckOutcome<F, Extra = unknown> = (CheckedOutcome<F> & Extra) | UnableOutcome;

/** Build a `checked` outcome. Spread it to attach a check's own extras. */
export function checked<F>(ok: boolean, findings: F[]): CheckedOutcome<F> {
  return { status: 'checked', ok, findings };
}

/**
 * Build an `unable` outcome. Throws on an empty reason: a reason-less
 * "couldn't check" is the same silent hole this module exists to close, and
 * a throw at construction is cheaper than one more blind gate in production.
 */
export function unable(reason: string): UnableOutcome {
  if (!reason.trim()) {
    throw new Error(
      'unable() requires a non-empty reason — an unexplained "could not check" is ' +
        'indistinguishable from a broken matcher (dimagi-internal/ace#1634)',
    );
  }
  return { status: 'unable', reason };
}

/**
 * The ONLY predicate that means "this check passed."
 *
 * `unable` is NOT a pass. Nothing was verified, so there is nothing to pass.
 */
export function isPass<F, E>(outcome: CheckOutcome<F, E>): boolean {
  return outcome.status === 'checked' && outcome.ok;
}

/** True when the check did not run. Sugar for the narrowing, for readability. */
export function isUnable<F, E>(outcome: CheckOutcome<F, E>): outcome is UnableOutcome {
  return outcome.status === 'unable';
}

/**
 * Render the `unable` branch. Deliberately loud and deliberately not green:
 * the previous wording ("not applicable") read as benign in build memos, and
 * that is how four successive blind gates were signed off.
 */
export function formatUnable(label: string, reason: string): string {
  return [
    `${label}: UNABLE TO CHECK — ${reason}`,
    `  This is NOT a pass. Nothing was verified, so treat whatever this check covers`,
    `  as UNEVALUATED, and record it in the verdict's checks[] with this reason.`,
    `  If the input looks like it SHOULD have matched, the matcher is the bug`,
    `  (dimagi-internal/ace#1332 → #1538 → #1576 → #1634 were all exactly that).`,
  ].join('\n');
}

/**
 * Narrow to the `checked` branch, throwing if the check never ran.
 *
 * For callers (and tests) that REQUIRE the check to have run: the throw names
 * the reason, so "the gate covered nothing" surfaces as a loud failure instead
 * of a green report. This is the one sanctioned way to get at `ok` without
 * writing the narrowing by hand.
 */
export function assertChecked<F, E>(
  outcome: CheckOutcome<F, E>,
): asserts outcome is CheckedOutcome<F> & E {
  if (outcome.status !== 'checked') {
    throw new Error(
      `expected the check to have run, but it reported UNABLE: ${outcome.reason}`,
    );
  }
}

/**
 * Narrow to the `unable` branch, throwing if the check DID run. The mirror of
 * `assertChecked`, so a test asserting the not-run path gets the same
 * compile-time narrowing rather than reaching for a cast.
 */
export function assertUnable<F, E>(
  outcome: CheckOutcome<F, E>,
): asserts outcome is UnableOutcome {
  if (outcome.status !== 'unable') {
    throw new Error('expected the check to report UNABLE, but it ran');
  }
}
