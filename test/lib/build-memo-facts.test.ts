import { describe, expect, it } from 'vitest';
import { buildMemoFacts, renderFactSheet } from '../../lib/build-memo-facts';

const runState = {
  run_id: '20260926-1800',
  forked_from: '20260925-1536',
  phases: {
    'commcare-setup': { products: { apps: { learn: { name: 'Spark Learn', released_version: 22, build_status: 'success' }, deliver: { name: 'Spark Deliver', released_version: 14 } } } },
    'connect-setup': {
      products: {
        connect: {
          organization_slug: 'ai-demo-space',
          opportunity: { name: 'Spark opp', is_test: true },
          payment_units: [{ name: 'Per verified community meeting', amount: 7500, org_amount: 3000, currency: 'MWK', max_total: 21, max_daily: 1 }],
          verification: { form_field_rules: [], form_field_rules_saved: 0, not_applied_reason: 'refused on a self-managed opp (ace#2419)' },
          ace_test_user: { invite_row_present: true },
          // the memo's own pointer is NEVER a fact source
          build_memo: { complete: true, gaps: [] },
        },
      },
    },
  },
};

describe('build-memo fact sheet', () => {
  it('assembles what was built from run_state, never from the memo', () => {
    const facts = buildMemoFacts(runState);
    const by = Object.fromEntries(facts.map((f) => [f.key, f.value]));
    expect(by['run.run_id']).toBe('20260926-1800');
    expect(by['run.forked_from']).toBe('20260925-1536');
    expect(by['apps.learn.released_version']).toBe('22');
    expect(by['payment_units.0.amount']).toBe('7500 MWK');
    expect(by['payment_units.0.org_amount']).toBe('3000 MWK');
    expect(by['verification.rules_saved']).toBe('0');
    expect(by['verification.not_applied_reason']).toMatch(/ace#2419/);
    expect(facts.some((f) => /build_memo/.test(f.key))).toBe(false);
  });

  it('adds the live Connect half with its source', () => {
    const facts = buildMemoFacts(runState, {
      opportunity: { active: true, end_date: '2027-02-26', total_budget: 3276000 },
      paymentUnits: [{ name: 'Per verified community meeting' }],
    });
    const end = facts.find((f) => f.key === 'live.opportunity.end_date');
    expect(end).toMatchObject({ value: '2027-02-26', source: 'live:connect_get_opportunity' });
    expect(facts.find((f) => f.key === 'live.payment_units.count')?.value).toBe('1');
    expect(renderFactSheet(facts)).toMatch(/^\| Fact \| Value \| Source \|/);
  });

  it('omits what is unknown rather than inventing a value', () => {
    expect(buildMemoFacts({}).length).toBe(0);
  });
});
