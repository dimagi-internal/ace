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

export interface CapacityPaymentUnit {
  name?: string;
  amount: number;
  org_amount?: number;
  max_total: number;
}

/** Σ over payment units of `max_total × (amount + org_amount)` — the budget
 *  needed to fund exactly one FLW at the configured payment-unit maxima. */
export function minBudgetForOneUser(paymentUnits: CapacityPaymentUnit[]): number {
  return paymentUnits.reduce(
    (sum, pu) => sum + pu.max_total * (pu.amount + (pu.org_amount ?? 0)),
    0,
  );
}

/** Connect's managed-opp capacity formula. Returns Infinity for a zero-cost
 *  (free) opportunity so the caller's `< 1` check is a no-op there. */
export function numberOfUsers(total_budget: number, paymentUnits: CapacityPaymentUnit[]): number {
  const min = minBudgetForOneUser(paymentUnits);
  if (min <= 0) return Infinity;
  return total_budget / min;
}

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
  if (min <= 0) return;
  const users = total_budget / min;
  if (users < 1) {
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
