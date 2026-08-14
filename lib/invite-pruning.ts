/**
 * Which of the ACE test user's Connect invites are safe to delete before a
 * Phase 6 walk?
 *
 * Why this exists (dimagi-internal/ace#1289). The test user accumulates an
 * invite per `/ace:run` forever — there is no cleanup — and **unclaimed
 * opportunities render under a "New Opportunities" section header that sits
 * BELOW the entire "In Progress" section**. On the dogfood device In Progress
 * is ~20 cards deep (~25 tiles total), so the target tile is roughly six full
 * viewport scrolls down and both tile-finding scrolls time out.
 *
 * `connect-resume-opp.yaml` is the worse of the two: it never received the
 * ace#647 recalibration at all (`timeout: 20000`, `visibilityPercentage: 60`,
 * default speed), and it blocks the Deliver leg exactly as the claim recipe
 * blocks the Learn leg.
 *
 * The issue names the class-level fix and says why a recalibration is not one:
 *
 * > A recalibration alone will expire again the same way — the list grows
 * > every run.
 *
 * This is the half that never touches the device: bound the list instead of
 * growing the budget. The scroll-budget changes are device-truth and are
 * deliberately not here.
 *
 * ## The safety property IS the design
 *
 * **Never delete the current run's invite.** Doing so breaks the very run
 * doing the pruning — a far worse failure than the slow scroll it fixes. So
 * `currentOpportunityId` is required, an empty one throws rather than
 * defaulting to "prune everything", and every exclusion is returned with a
 * reason so the skill can log what it left alone and why.
 *
 * Accepted invites are excluded too. The server skips them anyway
 * (`connect_delete_unaccepted_flw_invites` silently ignores
 * `status=accepted`), but an invite that represents a real worker should never
 * appear in a delete list ACE composes — being refused downstream is not the
 * same as never asking.
 */

export interface FlwInvite {
  id: number;
  opportunity_id: string;
  status?: string;
  phone_number?: string;
}

export type ExclusionReason = 'current-run' | 'accepted' | 'not-test-user';

export interface ExcludedInvite {
  id: number;
  opportunity_id: string;
  reason: ExclusionReason;
}

export interface PruneSelection {
  /** Opportunity UUID → invite ids to delete. Ready for the per-opp atom. */
  byOpportunity: Record<string, number[]>;
  excluded: ExcludedInvite[];
  /** Total invites selected for deletion. */
  total: number;
  /** How many opportunities the caller must iterate. */
  opportunityCount: number;
}

export interface PruneInputs {
  invites: FlwInvite[];
  /** The opportunity THIS run is walking. Never pruned. Required. */
  currentOpportunityId: string;
  /** When given, only this phone number's invites are considered. */
  testUserPhone?: string;
}

export function selectPrunableInvites(input: PruneInputs): PruneSelection {
  if (!input.currentOpportunityId) {
    throw new Error(
      'selectPrunableInvites: currentOpportunityId is required. Without it every invite looks ' +
        "prunable, including THIS run's — which would break the run doing the pruning " +
        '(dimagi-internal/ace#1289).',
    );
  }

  const byOpportunity: Record<string, number[]> = {};
  const excluded: ExcludedInvite[] = [];

  for (const inv of input.invites ?? []) {
    const base = { id: inv.id, opportunity_id: inv.opportunity_id };
    if (inv.opportunity_id === input.currentOpportunityId) {
      excluded.push({ ...base, reason: 'current-run' });
      continue;
    }
    if ((inv.status ?? '').toLowerCase() === 'accepted') {
      excluded.push({ ...base, reason: 'accepted' });
      continue;
    }
    if (input.testUserPhone && inv.phone_number !== input.testUserPhone) {
      excluded.push({ ...base, reason: 'not-test-user' });
      continue;
    }
    (byOpportunity[inv.opportunity_id] ??= []).push(inv.id);
  }

  const total = Object.values(byOpportunity).reduce((n, ids) => n + ids.length, 0);
  return {
    byOpportunity,
    excluded,
    total,
    opportunityCount: Object.keys(byOpportunity).length,
  };
}
