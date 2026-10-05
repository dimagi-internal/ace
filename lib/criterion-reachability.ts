//
// Multi-day criteria and the NOT REACHED contract across the deep-QA chain
// (dimagi-internal/ace#2670).
//
// On a longitudinal-visits app some deep-journey criteria need N > 1 DATED
// records on the SAME case. When the date field's validate is strictly
// increasing against the previous record AND capped at today(), a case takes
// at most one such record per device-day, so one `/ace:qa-deep` session
// cannot reach "the 4th meeting is labelled not paid". The as-built
// spark-facilitator Community Meeting Record `date_of_meeting` is the
// canonical case:
//
//   . <= today() and . >= today() - 1096
//     and (#form/enrolment_date_ref = '' or . >= date(#form/enrolment_date_ref))
//     and (#form/prev_meeting_date = '' or . > date(#form/prev_meeting_date))
//
// Back-dating cannot rescue it: the 2.64.0 picker has only a calibrated +1-day
// forward drive (lib/date-picker-drive.ts, ace#2518). And faking the days by
// moving the device clock is forbidden (commands/qa-deep.md Stage B step 4).
//
// The chain:
//   app-test-cases  DECLARES   { name, reachability: multi-day, reason }
//   /ace:qa-deep    RECORDS    it NOT REACHED with that reason
//   app-ux-eval     LISTS      it under not_reached, WARNs, caps
//                              journey_completion at 2 (never 0, never a pass)
//   llo-launch      NAMES      every NOT REACHED criterion at the gate
//
// Pure: no I/O. Callers read the validate / catalog / verdict and pass values.
//

export type Reachability = 'single-session' | 'multi-day';

export interface MultiDayDetection {
  /** `. > <prior record>` — strictly after a previous record's date. */
  strictlyIncreasing: boolean;
  /** `. <= today()` / `. < today()` / `today() >= .` — no forward-dating. */
  cappedAtToday: boolean;
  /** Both: at most one record per case per device-day. */
  multiDay: boolean;
}

// `.` followed by a strict `>` (not `>=`), then an operand that references
// ANOTHER value in the form (#form/…, /data/…, date(#form/…)). A `>` against
// today() itself is a window, not an ordering against a prior record.
const STRICT_AFTER_PRIOR = /(^|[^\w/])\.\s*>(?!=)\s*(date\(\s*)?(#form\/|\/data\/|#case\/)/;
const CAPPED_AT_TODAY = /(^|[^\w/])\.\s*<=?\s*today\(\)|today\(\)\s*>=?\s*\.(?![\w/])/;

/** Classify a date field's `validate` expression. */
export function detectMultiDayDateConstraint(validate: string | undefined | null): MultiDayDetection {
  const v = validate ?? '';
  const strictlyIncreasing = STRICT_AFTER_PRIOR.test(v);
  const cappedAtToday = CAPPED_AT_TODAY.test(v);
  return { strictlyIncreasing, cappedAtToday, multiDay: strictlyIncreasing && cappedAtToday };
}

/** A structural_pass_criteria entry: a bare name, or the mapping form. */
export type CriterionEntry =
  | string
  | { name: string; reachability?: Reachability; reason?: string };

export interface NormalizedCriterion {
  name: string;
  reachability: Reachability;
  reason?: string;
}

/**
 * Normalize a catalog criterion. A `multi-day` declaration without a reason is
 * refused: the reason (field, constraint, N) is what the judge and the gate
 * quote, and a bare flag is as unactionable as the "space the walks across
 * days" note that motivated this contract.
 */
export function normalizeCriterion(entry: CriterionEntry): NormalizedCriterion {
  if (typeof entry === 'string') return { name: entry, reachability: 'single-session' };
  const reachability = entry.reachability ?? 'single-session';
  if (reachability !== 'single-session' && reachability !== 'multi-day') {
    throw new Error(
      `criterion ${entry.name}: unknown reachability ${JSON.stringify(reachability)} (expected single-session | multi-day)`,
    );
  }
  if (reachability === 'multi-day') {
    if (!entry.reason || !entry.reason.trim()) {
      throw new Error(
        `criterion ${entry.name}: reachability: multi-day requires a reason naming the date field, its constraint and N (ace#2670)`,
      );
    }
    return { name: entry.name, reachability, reason: entry.reason.trim() };
  }
  return entry.reason ? { name: entry.name, reachability, reason: entry.reason } : { name: entry.name, reachability };
}

export interface NotReachedEntry {
  criterion: string;
  reason: string;
}

export interface Reconciliation {
  /** Recorded NOT REACHED, in catalog order, each with a stated reason. */
  notReached: NotReachedEntry[];
  /**
   * Neither graded nor recorded NOT REACHED — the silent drop this contract
   * exists to prevent. app-ux-eval surfaces each as a [WARN] owner HARNESS.
   */
  unaccounted: string[];
}

/**
 * Reconcile a journey's catalog criteria against what the walk graded and the
 * NOT REACHED list Stage B handed over. A `multi-day` criterion that was not
 * graded is NOT REACHED with its catalog reason even if Stage B forgot to list
 * it; one that WAS graded (successive device-days on the same cases) is not
 * listed at all.
 */
export function reconcileNotReached(
  criteria: readonly CriterionEntry[],
  graded: Iterable<string>,
  recorded: readonly NotReachedEntry[] = [],
): Reconciliation {
  const gradedSet = new Set(graded);
  const recordedBy = new Map(recorded.map((r) => [r.criterion, r.reason]));
  const notReached: NotReachedEntry[] = [];
  const unaccounted: string[] = [];
  for (const raw of criteria) {
    const c = normalizeCriterion(raw);
    if (gradedSet.has(c.name)) continue;
    const stated = recordedBy.get(c.name);
    if (stated && stated.trim()) {
      notReached.push({ criterion: c.name, reason: stated.trim() });
    } else if (c.reachability === 'multi-day') {
      notReached.push({ criterion: c.name, reason: `reachability: multi-day — ${c.reason}` });
    } else {
      unaccounted.push(c.name);
    }
  }
  return { notReached, unaccounted };
}

/** NOT REACHED caps journey_completion here: a WARN, not a pass, not a fail. */
export const JOURNEY_COMPLETION_NOT_REACHED_CAP = 2;

/**
 * Apply the cap. Never raises a score and never lowers it to the
 * "journey didn't finish" hard deduction on account of a calendar constraint.
 */
export function capJourneyCompletion(score: number, notReached: readonly NotReachedEntry[]): number {
  return notReached.length > 0 ? Math.min(score, JOURNEY_COMPLETION_NOT_REACHED_CAP) : score;
}

interface VerdictLike {
  per_item?: ReadonlyArray<{ ref?: string; journey?: string; not_reached?: ReadonlyArray<{ criterion?: string; reason?: string }> }>;
  not_reached?: ReadonlyArray<{ journey?: string; criterion?: string; reason?: string }>;
  [k: string]: unknown;
}

/**
 * The lines llo-launch prints for an app-ux-eval deep verdict. NOT REACHED
 * does not block activation by itself (the verdict's own `verdict:` does);
 * it must be NAMED so an approve never hides what it did not observe.
 * Reads both the flattened top-level list and per_item, de-duplicated.
 */
export function notReachedGateLines(verdict: VerdictLike): string[] {
  const seen = new Map<string, string>();
  const add = (journey: string | undefined, criterion: string | undefined, reason: string | undefined) => {
    if (!criterion) return;
    const key = `${journey ?? '?'}\u0000${criterion}`;
    const prev = seen.get(key);
    if (prev === undefined || (!prev && reason)) seen.set(key, reason ?? '');
  };
  for (const n of verdict.not_reached ?? []) add(n.journey, n.criterion, n.reason);
  for (const item of verdict.per_item ?? []) {
    for (const n of item.not_reached ?? []) add(item.journey ?? item.ref, n.criterion, n.reason);
  }
  return [...seen.entries()].map(([key, reason]) => {
    const [journey, criterion] = key.split('\u0000');
    return `[WARN] ${journey}: ${criterion} NOT REACHED${reason ? ` (${reason})` : ''}`;
  });
}
