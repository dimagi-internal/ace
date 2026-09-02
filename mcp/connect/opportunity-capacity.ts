// Code-enforced "an opportunity must fund at least one FLW" guard.
//
// Connect computes managed-opp capacity as
//   number_of_users = total_budget / Σ(max_total × (amount + org_amount))
// (commcare_connect/opportunity/models.py `Opportunity.number_of_users`). When
// that value is < 1, `create_claim_limits` under-allocates and the FLW can
// never claim a full visit allotment — the silent root behind the Phase-6
// Deliver "Unable to claim" / no-OpportunityClaim class.
//
// #722 tried to enforce this as SKILL.md prose. It failed live on
// bednet-spot-check/20260606-2013: the agent evaluated the guard in DOLLARS
// ($0.50) while STORING cents (50), so the ratio came out 5 in its head but
// 0.05 in Connect, and Phase 4 shipped an unclaimable opp. The lesson
// (CLAUDE.md "class-level preventers > instance fixes"): enforce at the MCP
// boundary, in code, over the integers actually sent to Connect — then no
// amount of agent unit-confusion can slip an underfunded opp through.
//
// amount / org_amount / total_budget are all integers in the SAME
// whole-currency unit (PositiveIntegerField / PositiveBigIntegerField); there
// are no cents in the wire model, so this comparison is unit-consistent BY
// CONSTRUCTION as long as the caller passes the same total_budget it set on the
// opportunity. A dollars-vs-cents MIX (the observed bug) surfaces here as
// number_of_users < 1 and is rejected.
import { ConnectError } from './errors.js';
import {
  minBudgetForOneUser,
  numberOfUsers,
  fundsAtLeastOneUser,
} from '../../lib/connect-opp-invariants.js';

// The formula itself is canonical in `lib/connect-opp-invariants.ts` so the
// standalone spec validator enforces the SAME arithmetic. Re-exported here
// because that is where callers have always imported it from.
//
// The move also fixed a fail-open both copies shared: `users < 1` is `false`
// for `NaN`, so a non-numeric `amount` or `total_budget` sailed through the
// guard. `fundsAtLeastOneUser` treats non-finite as a failure.
export type { CapacityPaymentUnit } from '../../lib/connect-opp-invariants.js';
export { minBudgetForOneUser, numberOfUsers } from '../../lib/connect-opp-invariants.js';
import type { CapacityPaymentUnit } from '../../lib/connect-opp-invariants.js';

export class OpportunityUnderfundedError extends ConnectError {
  retryable = false;
  constructor(
    public total_budget: number,
    public min_budget_for_one_user: number,
    public number_of_users: number,
    public breakdown: Array<{ name: string; max_total: number; amount: number; org_amount: number; cost: number }>,
  ) {
    super(
      `Opportunity total_budget ${total_budget} funds only ${number_of_users.toFixed(4)} FLW (< 1). ` +
        `Need total_budget ≥ ${min_budget_for_one_user} = Σ(max_total × (amount + org_amount)) across ` +
        `payment units. Connect computes number_of_users = total_budget / that sum ` +
        `(Opportunity.number_of_users); a value < 1 under-allocates create_claim_limits, so the FLW cannot ` +
        `claim a full visit allotment (the Phase-6 "Unable to claim" class). Fixes: raise total_budget AND ` +
        `the program budget, or lower max_total. NOTE: amount / org_amount / total_budget are whole-currency-` +
        `unit integers (NOT cents) — if you passed cents (e.g. 50 for $0.50) you 100×-inflated the per-user ` +
        `cost; pass whole units instead.`,
    );
  }

  toJSON(): {
    error: 'opportunity_underfunded';
    message: string;
    total_budget: number;
    min_budget_for_one_user: number;
    number_of_users: number;
    breakdown: Array<{ name: string; max_total: number; amount: number; org_amount: number; cost: number }>;
  } {
    return {
      error: 'opportunity_underfunded',
      message: this.message,
      total_budget: this.total_budget,
      min_budget_for_one_user: this.min_budget_for_one_user,
      number_of_users: this.number_of_users,
      breakdown: this.breakdown,
    };
  }
}

/**
 * Throw `OpportunityUnderfundedError` when `total_budget` cannot fund at least
 * one FLW at the configured payment units. No-op for an empty PU list or a
 * zero-cost (free) opportunity. Call this BEFORE creating payment units so the
 * boundary rejects an underfunded config without leaving an orphan PU.
 */
export function assertFundsAtLeastOneUser(
  total_budget: number,
  paymentUnits: CapacityPaymentUnit[],
): void {
  if (paymentUnits.length === 0) return;
  const min = minBudgetForOneUser(paymentUnits);
  // A zero-cost opportunity funds anyone; a NON-FINITE min means we could not
  // compute the cost at all and must NOT be read as zero-cost.
  if (min === 0) return;
  const users = numberOfUsers(total_budget, paymentUnits);
  if (!fundsAtLeastOneUser(total_budget, paymentUnits)) {
    const breakdown = paymentUnits.map((pu) => ({
      name: pu.name ?? '',
      max_total: pu.max_total,
      amount: pu.amount,
      org_amount: pu.org_amount ?? 0,
      cost: pu.max_total * (pu.amount + (pu.org_amount ?? 0)),
    }));
    throw new OpportunityUnderfundedError(total_budget, min, users, breakdown);
  }
}
