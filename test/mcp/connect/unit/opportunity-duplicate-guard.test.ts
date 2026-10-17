// connect_create_opportunity's boundary rail: an `is_test` create whose EXACT
// name already exists is refused (ace#2083). The name is deterministic per run,
// so the existing row is this run's own half-built opportunity; a second create
// strands it as a permanent setup_incomplete orphan (no delete API; Connect
// purges visit-free opps at 6 months).
import { describe, expect, it } from 'vitest';
import {
  assertNoExistingRunOpportunity,
  OpportunityAlreadyExistsError,
  OpportunityExistenceUnknownError,
  runIdOfOppName,
} from '../../../../mcp/connect/opportunity-name.js';

const NAME = '20260820-0832 · Bednet Check';
const base = { organization_slug: 'ai-demo-space', name: NAME, is_test: true };

function lister(rows: Array<Record<string, unknown>>, complete = true) {
  const calls: Array<{ organization_slug: string; name: string }> = [];
  const fn = async (a: { organization_slug: string; name: string }) => {
    calls.push(a);
    return { opportunities: rows, listing: { complete } };
  };
  return { fn, calls };
}

describe('assertNoExistingRunOpportunity', () => {
  it('lists by the run id and passes when nothing carries the exact name', async () => {
    const l = lister([{ id: 'x', name: '20260820-0832 · Something Else' }]);
    await expect(assertNoExistingRunOpportunity(base, l.fn)).resolves.toBeUndefined();
    expect(l.calls).toEqual([{ organization_slug: 'ai-demo-space', name: '20260820-0832' }]);
  });

  it('REFUSES when the exact name exists, naming the id and its dashboard_read', async () => {
    const l = lister([{ id: 'opp-1', name: NAME, dashboard_read: 'setup_incomplete' }]);
    const err = await assertNoExistingRunOpportunity(base, l.fn).catch((e) => e);
    expect(err).toBeInstanceOf(OpportunityAlreadyExistsError);
    expect(err.message).toMatch(/^OPPORTUNITY_ALREADY_EXISTS/);
    expect(err.toJSON().existing).toEqual([{ id: 'opp-1', dashboard_read: 'setup_incomplete' }]);
  });

  it('refuses on an incomplete listing rather than creating blind', async () => {
    const l = lister([], false);
    await expect(assertNoExistingRunOpportunity(base, l.fn)).rejects.toBeInstanceOf(OpportunityExistenceUnknownError);
  });

  it('refuses when the listing call itself fails', async () => {
    const fn = async () => {
      throw new Error('502');
    };
    await expect(assertNoExistingRunOpportunity(base, fn)).rejects.toBeInstanceOf(OpportunityExistenceUnknownError);
  });

  it('is a no-op (no list call) for non-test opps and for an explicit allow_existing_name', async () => {
    const l = lister([{ id: 'opp-1', name: NAME }]);
    await assertNoExistingRunOpportunity({ ...base, is_test: false }, l.fn);
    await assertNoExistingRunOpportunity({ ...base, allow_existing_name: true }, l.fn);
    expect(l.calls).toHaveLength(0);
  });

  it('runIdOfOppName reads only the canonical front prefix', () => {
    expect(runIdOfOppName(NAME)).toBe('20260820-0832');
    expect(runIdOfOppName('Bednet Check (run 20260820-0832)')).toBeNull();
  });
});
