// Unit tests for the opportunity-capacity guard — the code-enforced
// "an opportunity must fund at least one FLW" preventer (jjackson/ace#729).
//
// Replaces the SKILL.md-prose budget guard from #722, which failed live on
// bednet-spot-check/20260606-2013: the agent computed the guard in dollars
// ($0.50) while storing cents (50), so number_of_users came out 5 in its head
// but 0.05 in Connect. A pure function over the integers actually sent to
// Connect cannot make that mistake.
import { describe, it, expect } from 'vitest';
import {
  minBudgetForOneUser,
  numberOfUsers,
  assertFundsAtLeastOneUser,
  OpportunityUnderfundedError,
} from '../../../../mcp/connect/opportunity-capacity.js';

describe('minBudgetForOneUser', () => {
  it('sums max_total × (amount + org_amount) across payment units', () => {
    expect(
      minBudgetForOneUser([
        { amount: 1, org_amount: 2, max_total: 50 }, // 50 × 3 = 150
        { amount: 3, org_amount: 0, max_total: 10 }, // 10 × 3 = 30
      ]),
    ).toBe(180);
  });

  it('treats a missing org_amount as 0', () => {
    expect(minBudgetForOneUser([{ amount: 5, max_total: 4 }])).toBe(20);
  });
});

describe('numberOfUsers', () => {
  it('divides total_budget by the per-user cost', () => {
    expect(numberOfUsers(450, [{ amount: 1, org_amount: 2, max_total: 50 }])).toBeCloseTo(3);
  });
});

describe('assertFundsAtLeastOneUser', () => {
  it('passes when total_budget funds exactly one user', () => {
    // 1 × (50 + 50) = 100; budget 100 → number_of_users = 1
    expect(() => assertFundsAtLeastOneUser(100, [{ amount: 50, org_amount: 50, max_total: 1 }])).not.toThrow();
  });

  it('passes when total_budget funds more than one user', () => {
    expect(() => assertFundsAtLeastOneUser(450, [{ amount: 1, org_amount: 2, max_total: 50 }])).not.toThrow();
  });

  it('throws OpportunityUnderfundedError when number_of_users < 1', () => {
    // The exact bednet-spot-check/20260606-2013 misconfig: amount/org stored as
    // cents (50/50), max_total 10, total_budget 50 → 50 / (10 × 100) = 0.05.
    expect(() => assertFundsAtLeastOneUser(50, [{ amount: 50, org_amount: 50, max_total: 10 }])).toThrow(
      OpportunityUnderfundedError,
    );
  });

  it('catches the dollars-vs-cents MIX that the prose guard missed', () => {
    // Agent reasoning in dollars: 10 × ($0.50 + $0.50) = $10 ≤ $50 → "5 users, fine".
    // But it stored cents: amount 50, org 50, max_total 10, total_budget 50 (whole $).
    // The code sees the integers → 0.05 < 1 → rejects. No way to "think in dollars".
    let err: unknown;
    try {
      assertFundsAtLeastOneUser(50, [{ name: 'Household Visit', amount: 50, org_amount: 50, max_total: 10 }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OpportunityUnderfundedError);
    const j = (err as OpportunityUnderfundedError).toJSON();
    expect(j.error).toBe('opportunity_underfunded');
    expect(j.total_budget).toBe(50);
    expect(j.min_budget_for_one_user).toBe(1000);
    expect(j.number_of_users).toBeCloseTo(0.05);
  });

  it('is a no-op for an empty payment-unit list (nothing to fund yet)', () => {
    expect(() => assertFundsAtLeastOneUser(0, [])).not.toThrow();
  });

  it('is a no-op when the per-user cost is zero (free opportunity)', () => {
    expect(() => assertFundsAtLeastOneUser(0, [{ amount: 0, org_amount: 0, max_total: 5 }])).not.toThrow();
  });

  it('the underfunded error is non-retryable (same args reproduce it)', () => {
    try {
      assertFundsAtLeastOneUser(50, [{ amount: 50, org_amount: 50, max_total: 10 }]);
    } catch (e) {
      expect((e as OpportunityUnderfundedError).retryable).toBe(false);
    }
  });
});
