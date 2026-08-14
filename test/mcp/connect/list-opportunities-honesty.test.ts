/**
 * dimagi-internal/ace#1022 — `listOpportunities` returned confident values it
 * had never parsed, and silently ignored a filter it accepts.
 *
 * `playwright.ts` destructured only `{ organization_slug, name }`:
 *
 *   let opportunities = stubs.map((s) => ({ ..., managed: true, active: false }));
 *   if (name) opportunities = opportunities.filter((o) => o.name === name);
 *
 * Three gaps in one atom:
 *
 *  1. `program_id` is declared in the Zod schema and accepted by the atom, but
 *     never used — the caller gets the WHOLE ORG's list back with no way to
 *     tell.
 *  2. `managed` and `active` are hardcoded rather than parsed. Every opp reads
 *     `active: false` regardless of its real state.
 *  3. `total_budget` is absent from the returned shape entirely.
 *
 * Two callers are structurally broken by that:
 *
 *  - `connect-program-setup § Step 4a` (program-budget headroom, ace#588)
 *    needs `Σ(total_budget)` over a PROGRAM's opps. Neither input is
 *    obtainable — the filter is ignored AND total_budget isn't returned — so
 *    the headroom check silently no-ops and surfaces later as an
 *    un-actionable "Budget exceeds the program budget" rejection.
 *  - `connect-opp-setup § Step 4` (single-active-opp invariant, #106 finding
 *    11) warns "for each opp where active=true". `active` is hardcoded false,
 *    so that WARN can NEVER fire: the silent-deactivation surprise the check
 *    was written to catch is undetectable by it.
 *
 * Live on spark-facilitator/20260728-1338: called with a program created
 * seconds earlier holding ZERO opportunities, it returned 20 opportunities
 * belonging to other programs — Bednet Spot-Check, LEEP Paint Surveillance,
 * Household Poverty Targeting, Malaria ITN — every one `managed: true,
 * active: false`, no `total_budget`.
 *
 * The fix follows the issue's own guidance: a loud `unsupported_filter` beats
 * a wrong result set, and an UNKNOWN field beats a fabricated one.
 */
import { describe, it, expect, vi } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../mcp/connect/backends/playwright.js';

/** Anchor markup matching parseOpportunitiesList's `flex flex-col` selector. */
const opp = (uuid: string, name: string, desc: string) =>
  `<a href="/a/ai-demo-space/opportunity/${uuid}/" class="flex flex-col items-start">` +
  `<p>${name}</p><p>${desc}</p></a>`;

const LIST_HTML = `<html><body>
  ${opp('11111111-1111-1111-1111-111111111111', 'Bednet Spot-Check', 'desc one')}
  ${opp('22222222-2222-2222-2222-222222222222', 'Malaria ITN', 'desc two')}
</body></html>`;

function backend(html = LIST_HTML): PlaywrightBackend {
  const request = {
    get: async () =>
      ({ status: () => 200, headers: () => ({ 'content-type': 'text/html' }), text: async () => html }) as unknown as APIResponse,
  } as unknown as APIRequestContext;
  return new PlaywrightBackend({ baseUrl: 'https://connect.dimagi.com', csrfToken: 'csrf', request });
}

describe('listOpportunities honesty (#1022)', () => {
  it('REFUSES program_id rather than returning the whole org silently', async () => {
    const b = backend();
    await expect(
      b.listOpportunities({ organization_slug: 'ai-demo-space', program_id: 'a115e4f2-6af6-401b-8add-8b97af80f43c' }),
    ).rejects.toThrow(/unsupported_filter/);
  });

  it("names what the caller should do instead of the ignored filter", async () => {
    const b = backend();
    await expect(
      b.listOpportunities({ organization_slug: 'ai-demo-space', program_id: 'x' }),
    ).rejects.toThrow(/get_opportunity|program page/i);
  });

  it('leaves active/managed UNDEFINED rather than fabricating them', async () => {
    const b = backend();
    const { opportunities } = await b.listOpportunities({ organization_slug: 'ai-demo-space' });
    expect(opportunities).toHaveLength(2);
    for (const o of opportunities) {
      expect(o.active, 'active must not be a hardcoded false').toBeUndefined();
      expect(o.managed, 'managed must not be a hardcoded true').toBeUndefined();
      expect(o.total_budget).toBeUndefined();
    }
  });

  it('still filters by name — the one filter it can honour', async () => {
    const b = backend();
    const { opportunities } = await b.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: 'Malaria ITN',
    });
    expect(opportunities.map((o) => o.name)).toEqual(['Malaria ITN']);
  });

  it('hydrates real active state on request, via the page that actually parses it', async () => {
    const b = backend();
    const spy = vi
      .spyOn(b, 'getOpportunity')
      .mockImplementation(async ({ opportunity_id }: any) => ({
        id: opportunity_id,
        name: 'x',
        short_description: '',
        description: '',
        managed: true,
        active: opportunity_id.startsWith('1'),
      }) as any);

    const { opportunities } = await b.listOpportunities({
      organization_slug: 'ai-demo-space',
      hydrate: true,
    } as any);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(opportunities.map((o) => o.active)).toEqual([true, false]);
  });
});
