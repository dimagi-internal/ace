/**
 * Which action a weekly-review row should offer, derived from why the row is there.
 *
 * ace#1394. In the `llo_weekly_review` dashboard the ACTION column rendered ONE
 * control on every row — `Draft coaching message` — regardless of why the row
 * was listed. On spark-facilitator/20260813-2126's hero week that included:
 *
 *   - Peter Masamba — 2 of 2 payable, `100% of 2`, and the row's own annotation
 *     reading WHY THE REST WERE NOT PAID: all payable. Listed only because one
 *     record was flagged for a second look.
 *   - Rhoda Chimwemwe — 100% payable, listed only for a location fix above the
 *     50 m tolerance, which the same page's WHAT IS NOT A PAYMENT GATE card
 *     says never blocks payment.
 *
 * The product's only offered next step for both was to coach them. That turns
 * "read this record" into "this person is underperforming", against the
 * review's own stated posture. It was raised at iteration 2, re-cited and
 * re-scored at iteration 3, and capped `design_soundness` at 2 again at
 * iteration 4 — three rounds, same defect, three different scores.
 *
 * This module is the ACE-side fix. The labs `llo_weekly_review` template is a
 * generic scaffold whose own docstring says "ACE's polish skill rewrites the
 * JSX", so the universal action is authored by ACE, not shipped by labs.
 * `synthetic-workflow-polish` must transcribe THIS mapping into the render
 * code rather than re-deriving it — the reason array is already computed to
 * render the row's amber annotations, so branching on it costs nothing.
 */

/** Why a row appears in the review. Mirrors what `attention(c)` already builds. */
export type AttentionReason =
  /** A specific record is flagged for a second look. */
  | 'flagged-record'
  /** No record filed in the period. */
  | 'no-records'
  /** A rate sits below its stated review threshold. */
  | 'below-threshold'
  /** A location fix above tolerance — advisory; the page says it never blocks payment. */
  | 'fix-above-tolerance';

export interface RowAction {
  /** Button label. */
  label: string;
  /** What it does — a drill-down or a drafted message. */
  kind: 'drill' | 'message';
  /** Why this row gets this action. Rendered as the control's title/tooltip. */
  rationale: string;
}

/** Drill-down only. Nothing to send; the row is advisory. */
export const DRILL_ONLY: RowAction = {
  label: 'Open records',
  kind: 'drill',
  rationale: 'Advisory only — nothing here blocks payment, so there is nothing to action.',
};

/**
 * Priority order. A row can carry several reasons at once; the action should
 * answer the most actionable one. Coaching sits BELOW the two specific,
 * non-judgemental actions on purpose: offering it when a more precise action
 * exists is what produced the defect.
 */
const PRIORITY: readonly AttentionReason[] = [
  'flagged-record',
  'no-records',
  'below-threshold',
  'fix-above-tolerance',
];

const BY_REASON: Record<AttentionReason, RowAction> = {
  'flagged-record': {
    label: 'Open flagged record',
    kind: 'drill',
    rationale: 'A specific record is flagged — the next step is to read it, not to coach.',
  },
  'no-records': {
    label: 'Draft check-in message',
    kind: 'message',
    rationale: 'Nothing was filed this period; a check-in asks why before assuming performance.',
  },
  'below-threshold': {
    label: 'Draft coaching message',
    kind: 'message',
    rationale: 'A rate is below its stated review threshold — the one case coaching fits.',
  },
  'fix-above-tolerance': DRILL_ONLY,
};

/**
 * The row's primary action.
 *
 * A row with no reasons should not be in the list at all; it gets the
 * drill-down rather than an assertion, so a rendering bug never surfaces as an
 * unwarranted coaching prompt.
 */
export function primaryRowAction(reasons: readonly AttentionReason[]): RowAction {
  for (const r of PRIORITY) {
    if (reasons.includes(r)) return BY_REASON[r];
  }
  return DRILL_ONLY;
}

/**
 * True when coaching is the honest offer. Exported so render code can assert it
 * directly rather than defaulting to coaching and hoping.
 */
export function shouldOfferCoaching(reasons: readonly AttentionReason[]): boolean {
  return primaryRowAction(reasons).label === 'Draft coaching message';
}
