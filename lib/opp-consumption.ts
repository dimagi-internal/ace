/**
 * Pre-AVD consumed-precondition probe for Phase 6 (dimagi-internal/ace#796).
 *
 * ## What this is for
 *
 * Connect's Learn completion is ONE-WAY per `(test user, opportunity)`. Once a
 * Phase-6 dispatch walks Learn to 100%, Connect routes "Continue Learning" to
 * the Deliver gate forever after; once the visit quota is spent, the Deliver
 * leg has nothing left to walk either. A Phase-6 RETRY on the same run cannot
 * restore either precondition, because the run reuses the same opp. The only
 * restore is a fresh `/ace:run` (CLAUDE.md § "Phase preconditions are restored,
 * not adapted"; `docs/learnings/2026-05-18-connect-gates-deliver-on-learn-completion.md`).
 *
 * Until now that was discovered ~10 minutes in — after a full AVD cold boot —
 * as a cryptic Deliver-leg failure. `connect_get_learn_progress` (#897) and
 * `connect_get_deliver_progress` (#1066) made the state readable server-side,
 * headlessly, before any device work. This classifier is the pure decision that
 * sits on top of them.
 *
 * ## This is a COST-skip, not a correctness-skip
 *
 * CLAUDE.md's rule: *"For an external state transition, attempt the transition
 * and treat the conflict as the skip — never let a read-back flag stand in for
 * it."* A **cost-skip** (avoids redundant work, re-validated live downstream) is
 * fine; a **correctness-skip** (reads one system's flag and decides not to
 * perform a transition another path depends on) is a footgun.
 *
 * This is deliberately the former. The on-device recipe branches remain
 * authoritative about what the walk actually does — `connect-claim-opp.yaml`
 * still classifies its own landing, and `app-screenshot-capture` Step 2.7 still
 * records `satisfied-by-prior-completion`. All this saves is the boot.
 *
 * That is why **every ambiguous read fails OPEN**. A missing worker row, a
 * missing Deliver row, an unreadable progress bar, a zero quota — none of them
 * may produce `fully-consumed`. A false halt stops a run that could have walked,
 * which is strictly worse than the wasted boot it was trying to prevent.
 *
 * ## Why the exhaustion rule is what it is
 *
 * `progress_completed` / `progress_total` are read from Connect's Deliver
 * progress bar by `parseWorkerDeliverTable`, and were confirmed live against a
 * real roster (`test/fixtures/connect-worker-deliver-table.html`, `ACE Test`
 * at 2/5). The rule is `progress_completed >= progress_total` with a readable,
 * positive `progress_total` — derived from that observed shape, not guessed.
 * Reading the device banner text ("you have completed the maximum number of
 * visits") would be the guess; the server count is the source of truth.
 */

/**
 * The fields of `WorkerLearnRow` this classifier reads.
 *
 * Declared structurally rather than imported from `mcp/connect/types.ts` so
 * `lib/` stays free of MCP dependencies. `WorkerLearnRow` is the source of
 * truth for the semantics — in particular `learn_complete` is Connect's own
 * derivation (pct >= 100 OR a rendered `completed_learn_date`), and the DATE is
 * the authoritative gate, so trust the boolean over the percentage.
 */
export interface LearnRowLike {
  name: string;
  modules_completed_pct: number;
  learn_complete: boolean;
}

/**
 * The fields of `WorkerDeliverRow` this classifier reads.
 *
 * One row per worker + payment unit, so a worker on a multi-unit opp has
 * several. `progress_completed` / `progress_total` are `null` when the progress
 * bar did not render two integers — which means *unreadable*, never *zero*.
 */
export interface DeliverRowLike {
  name: string;
  payment_unit: string | null;
  progress_completed: number | null;
  progress_total: number | null;
}

export type OppConsumptionVerdict =
  /** Learn not complete. Full Learn + Deliver walk available. */
  | 'fresh'
  /** Learn complete, Deliver quota remaining. Deliver leg only — this is the
   *  state #570/#863 already handle on-device; do NOT halt. */
  | 'learn-consumed'
  /** Learn complete AND every readable payment unit's quota spent. Nothing
   *  left to walk on this opp — halt before booting the AVD. */
  | 'fully-consumed'
  /** The test user has no row on this opp, or the roster was unreadable.
   *  Cannot judge, so proceed. */
  | 'worker-not-found';

export interface OppConsumption {
  verdict: OppConsumptionVerdict;
  learn_complete: boolean;
  deliver_quota_exhausted: boolean;
  /** Legs a Phase-6 dispatch could still usefully walk. Empty ⇒ halt. */
  walkable_legs: Array<'learn' | 'deliver'>;
  /** Operator-readable explanation. On a halt it names the remediation. */
  reason: string;
}

const BOTH_LEGS: Array<'learn' | 'deliver'> = ['learn', 'deliver'];

/** Connect renders operator-entered names; compare forgivingly. */
function sameWorker(rowName: string, workerName: string): boolean {
  return rowName.trim().toLowerCase() === workerName.trim().toLowerCase();
}

/**
 * A single row's quota is spent only when the bar rendered a POSITIVE total we
 * could read AND the completed count reached it. `null` (unreadable) and `0`
 * (no meaningful target) both mean "cannot conclude exhausted".
 */
function rowQuotaSpent(row: DeliverRowLike): boolean {
  const { progress_completed: done, progress_total: total } = row;
  if (total === null || total <= 0) return false;
  if (done === null) return false;
  return done >= total;
}

/**
 * Decide whether a Phase-6 walk on this (worker, opportunity) still has
 * anything to do — from Connect's server-side rosters alone, before any AVD
 * boot. See the module doc for the fail-open contract.
 */
export function classifyOppConsumption(input: {
  learnWorkers: LearnRowLike[];
  deliverWorkers: DeliverRowLike[];
  workerName: string;
}): OppConsumption {
  const { learnWorkers, deliverWorkers, workerName } = input;

  const learnRow = learnWorkers.find((r) => sameWorker(r.name, workerName));

  // Fail open: no row means we cannot judge, not that nothing is walkable.
  if (!learnRow) {
    return {
      verdict: 'worker-not-found',
      learn_complete: false,
      deliver_quota_exhausted: false,
      walkable_legs: [...BOTH_LEGS],
      reason:
        `No Learn roster row for "${workerName}" on this opportunity ` +
        `(${learnWorkers.length} accepted worker(s) read). Cannot judge the ` +
        `precondition from the server, so proceeding — the on-device recipe ` +
        `branches stay authoritative.`,
    };
  }

  if (!learnRow.learn_complete) {
    return {
      verdict: 'fresh',
      learn_complete: false,
      deliver_quota_exhausted: false,
      walkable_legs: [...BOTH_LEGS],
      reason:
        `Learn is ${learnRow.modules_completed_pct}% complete for ` +
        `"${workerName}" — the Learn precondition holds (Deliver unlocks only ` +
        `at 100%). Both legs walkable.`,
    };
  }

  // Learn is spent. Whether anything remains turns on the Deliver quota.
  const rows = deliverWorkers.filter((r) => sameWorker(r.name, workerName));
  const readable = rows.filter((r) => r.progress_total !== null && r.progress_total > 0);
  const exhausted = readable.length > 0 && readable.every(rowQuotaSpent);

  if (!exhausted) {
    const detail =
      readable.length === 0
        ? rows.length === 0
          ? 'no Deliver roster row yet (none is created until the first submission)'
          : 'the Deliver progress bar did not render a readable quota'
        : readable
            .map((r) => `${r.payment_unit ?? 'unnamed unit'} ${r.progress_completed}/${r.progress_total}`)
            .join(', ');
    return {
      verdict: 'learn-consumed',
      learn_complete: true,
      deliver_quota_exhausted: false,
      walkable_legs: ['deliver'],
      reason:
        `Learn already complete for "${workerName}" (one-way — the Learn walk ` +
        `cannot be re-run on this opp), but Deliver quota remains: ${detail}. ` +
        `Proceeding to the Deliver leg; the claim recipe records ` +
        `satisfied-by-prior-completion.`,
    };
  }

  const spent = readable
    .map((r) => `${r.payment_unit ?? 'unnamed unit'} ${r.progress_completed}/${r.progress_total}`)
    .join(', ');
  return {
    verdict: 'fully-consumed',
    learn_complete: true,
    deliver_quota_exhausted: true,
    walkable_legs: [],
    reason:
      `This opportunity is already fully walked for "${workerName}": Learn is ` +
      `complete and every payment unit's visit quota is spent (${spent}). Both ` +
      `preconditions are one-way and a retry on this run reuses the same opp, ` +
      `so neither can be restored here. Start a fresh /ace:run — do NOT re-mint ` +
      `the opportunity (a fresh opp reusing the same released Deliver app ` +
      `cannot create a payment unit, ace#573).`,
  };
}
