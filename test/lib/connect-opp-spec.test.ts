/**
 * Tests for `lib/connect-opp-spec.ts` â€” the standalone-opportunity spec
 * validator behind `/ace:connect-opp-create`.
 *
 * Two jobs:
 *
 *  1. **Behaviour.** Each rule fires on the shape that motivated it, and does
 *     NOT fire on a healthy spec. (A validator that rejects everything is as
 *     useless as one that rejects nothing, and only the second half of that
 *     is usually tested.)
 *
 *  2. **Anti-drift.** Two rules are re-derived in `lib/` because the repo
 *     convention is `mcp/` imports `lib/` and never the reverse. A silent
 *     copy is exactly the class ACE keeps paying for, so this file imports
 *     BOTH sides and pins them equal:
 *       - the is_test run-id name prefix (`mcp/connect/opportunity-name.ts`)
 *       - the funds-â‰¥1-FLW capacity formula (`mcp/connect/opportunity-capacity.ts`)
 *     If either moves, this fails rather than the two quietly disagreeing
 *     about whether a create will be accepted.
 */
import { describe, it, expect } from 'vitest';
import {
  validateConnectOppSpec,
  hasBlockingIssue,
  formatSpecIssues,
  minBudgetForOneUser,
  RUN_ID_PREFIX_RE,
  SHORT_DESCRIPTION_MAX,
  type ConnectOppSpec,
} from '../../lib/connect-opp-spec.js';
import { OPP_NAME_RUN_ID_PREFIX_RE } from '../../mcp/connect/opportunity-name.js';
import { minBudgetForOneUser as mcpMinBudget } from '../../mcp/connect/opportunity-capacity.js';

/** A spec with every rule satisfied â€” the baseline every case mutates. */
function healthySpec(): ConnectOppSpec {
  return {
    organization_slug: 'ai-demo-space',
    program_id: '11111111-2222-3333-4444-555555555555',
    name: 'Bednet Spot-Check â€” Kano',
    short_description: 'Bednet spot-check visits in Kano',
    description: 'Field workers verify bednet presence and condition at household level.',
    start_date: '2026-09-15',
    end_date: '2026-12-15',
    total_budget: 900,
    passing_score: 80,
    is_test: false,
    learn_app: {
      cc_domain: 'connect-ace-prod',
      cc_app_id: 'a'.repeat(32),
      description: 'Bednet spot-check training',
    },
    deliver_app: { cc_domain: 'connect-ace-prod', cc_app_id: 'b'.repeat(32) },
    payment_units: [{ name: 'Per verified visit', amount: 2, max_total: 100 }],
    fund_users: 3,
  };
}

const codes = (s: ConnectOppSpec) => validateConnectOppSpec(s).map((i) => i.code);

describe('validateConnectOppSpec â€” healthy baseline', () => {
  it('accepts a complete spec with no errors and no warnings', () => {
    const issues = validateConnectOppSpec(healthySpec());
    expect(formatSpecIssues(issues)).toBe('spec OK â€” no issues.');
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('reports every missing required field at once, not just the first', () => {
    const issues = validateConnectOppSpec({});
    const fields = new Set(issues.map((i) => i.field));
    for (const f of [
      'organization_slug',
      'program_id',
      'name',
      'short_description',
      'description',
      'start_date',
      'end_date',
      'total_budget',
      'passing_score',
      'learn_app',
      'deliver_app',
      'payment_units',
    ]) {
      expect(fields, `expected an issue for ${f}`).toContain(f);
    }
  });
});

describe('validateConnectOppSpec â€” server-enforced limits', () => {
  it('rejects a short_description over the 50-char server cap', () => {
    const s = healthySpec();
    s.short_description = 'x'.repeat(SHORT_DESCRIPTION_MAX + 1);
    expect(codes(s)).toContain('short_description_too_long');
  });

  it('accepts a short_description exactly at the cap', () => {
    const s = healthySpec();
    s.short_description = 'x'.repeat(SHORT_DESCRIPTION_MAX);
    expect(codes(s)).not.toContain('short_description_too_long');
  });

  it('rejects the same HQ app on both sides', () => {
    const s = healthySpec();
    s.deliver_app!.cc_app_id = s.learn_app!.cc_app_id;
    expect(codes(s)).toContain('same_app_both_sides');
  });

  it('rejects an inverted date window', () => {
    const s = healthySpec();
    s.end_date = '2026-09-01';
    expect(codes(s)).toContain('window_inverted');
  });

  it('rejects a non-ISO date', () => {
    const s = healthySpec();
    s.start_date = '15/09/2026';
    expect(codes(s)).toContain('bad_date_format');
  });

  it('rejects a passing_score outside 0-100', () => {
    const s = healthySpec();
    s.passing_score = 120;
    expect(codes(s)).toContain('bad_passing_score');
  });
});

describe('validateConnectOppSpec â€” currency is whole units, never cents', () => {
  it('rejects a fractional amount (the serializer refuses floats)', () => {
    const s = healthySpec();
    s.payment_units = [{ name: 'Per visit', amount: 1.5, max_total: 100 }];
    expect(codes(s)).toContain('non_integer_currency');
  });

  it('catches cents-as-amount via the capacity floor', () => {
    // $1.50 posted as 150 reads to Connect as $150/visit: Î£ becomes 15,000
    // against a 900 budget, so number_of_users collapses below 1 and no
    // OpportunityClaim is ever created (the bednet-spot-check/20260605-2303
    // class).
    const s = healthySpec();
    s.payment_units = [{ name: 'Per visit', amount: 150, max_total: 100 }];
    expect(codes(s)).toContain('opportunity_underfunded');
  });

  it('warns â€” but does not block â€” when headroom is thin', () => {
    const s = healthySpec();
    s.total_budget = 250; // funds 1.25 FLW against a 200 min, asks for 3
    const issues = validateConnectOppSpec(s);
    expect(issues.map((i) => i.code)).toContain('thin_headroom');
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('blocks an opportunity with no payment unit at all', () => {
    const s = healthySpec();
    s.payment_units = [];
    expect(codes(s)).toContain('no_payment_units');
  });
});

describe('validateConnectOppSpec â€” is_test name prefix', () => {
  it('rejects an is_test opp whose name lacks the run-id prefix', () => {
    const s = healthySpec();
    s.is_test = true;
    expect(codes(s)).toContain('invalid_opp_name_prefix');
  });

  it('accepts the prefixed form', () => {
    const s = healthySpec();
    s.is_test = true;
    s.name = '20260901-1430 · Bednet Spot-Check';
    expect(codes(s)).not.toContain('invalid_opp_name_prefix');
  });

  it('leaves non-test opportunities alone â€” real opps keep human names', () => {
    const s = healthySpec();
    s.is_test = false;
    expect(codes(s)).not.toContain('invalid_opp_name_prefix');
  });
});

describe('validateConnectOppSpec â€” clone provenance', () => {
  it('refuses a clone that reuses the source Deliver app (ace#573)', () => {
    const s = healthySpec();
    s.clone_from = {
      opportunity_id: 'aaaa-bbbb',
      source_deliver_app_id: s.deliver_app!.cc_app_id,
    };
    const issues = validateConnectOppSpec(s);
    expect(issues.map((i) => i.code)).toContain('clone_reuses_deliver_app');
    expect(hasBlockingIssue(issues)).toBe(true);
  });

  it('refuses a clone that reuses the source Learn app (ace#1350)', () => {
    const s = healthySpec();
    s.clone_from = {
      opportunity_id: 'aaaa-bbbb',
      source_learn_app_id: s.learn_app!.cc_app_id,
    };
    expect(codes(s)).toContain('clone_reuses_learn_app');
  });

  it('accepts a clone once fresh app ids have been minted', () => {
    const s = healthySpec();
    s.clone_from = {
      opportunity_id: 'aaaa-bbbb',
      source_learn_app_id: 'c'.repeat(32),
      source_deliver_app_id: 'd'.repeat(32),
    };
    expect(validateConnectOppSpec(s)).toEqual([]);
  });

  it('says nothing about app reuse when the spec is not a clone', () => {
    // Provenance is what makes reuse detectable â€” without clone_from we have
    // no source ids and must not invent a complaint.
    const s = healthySpec();
    expect(codes(s)).not.toContain('clone_reuses_deliver_app');
  });
});

describe('anti-drift â€” lib and mcp must agree', () => {
  it('the run-id prefix regex matches the MCP boundary guard exactly', () => {
    expect(RUN_ID_PREFIX_RE.source).toBe(OPP_NAME_RUN_ID_PREFIX_RE.source);
    expect(RUN_ID_PREFIX_RE.flags).toBe(OPP_NAME_RUN_ID_PREFIX_RE.flags);
  });

  it('the run-id prefix agrees on real names, not just on its own source', () => {
    const cases = [
      '20260901-1430 · Bednet Spot-Check',
      'Bednet Spot-Check',
      '20260901-1430 - Bednet Spot-Check', // hyphen, not U+00B7
      '2026091-1430 · Bednet', // 7-digit date
      ' 20260901-1430 · Bednet', // leading space
    ];
    for (const name of cases) {
      expect(RUN_ID_PREFIX_RE.test(name), name).toBe(OPP_NAME_RUN_ID_PREFIX_RE.test(name));
    }
  });

  it('the capacity formula agrees with the MCP guard', () => {
    const units = [
      { name: 'a', amount: 2, max_total: 100 },
      { name: 'b', amount: 3, org_amount: 1, max_total: 50 },
      { name: 'c', amount: 0, max_total: 10 },
    ];
    expect(minBudgetForOneUser(units)).toBe(mcpMinBudget(units));
    expect(minBudgetForOneUser(units)).toBe(100 * 2 + 50 * 4 + 0);
  });
});
