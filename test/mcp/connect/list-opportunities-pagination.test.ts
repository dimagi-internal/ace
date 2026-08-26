/**
 * dimagi-internal/ace#1590 — `listOpportunities` returned only Connect's FIRST
 * PAGE and gave the caller no way to know more existed.
 *
 * `playwright.ts` did a single unparameterised GET:
 *
 *   const path = `/a/${organization_slug}/opportunity/`;
 *   const res = await this.request.get(path);
 *   const stubs = parseOpportunitiesList(await res.text());
 *
 * Upstream's `OpportunityList` is a paginated `SingleTableView`
 * (`commcare_connect/opportunity/views.py`) whose page size comes from
 * `get_validated_page_size(request)`, and `commcare_connect/utils/tables.py`
 * pins that to `DEFAULT_PAGE_SIZE = 20` with
 * `PAGE_SIZE_OPTIONS = [20, 30, 50, 100]`. So the atom returned the 20
 * most-recent opportunities and nothing else — no `has_more`, no error.
 *
 * Two callers break on that silence:
 *
 *  - `connect-program-setup § Step 4a` sums `total_budget` over a program's
 *    opps to size the budget headroom. It enumerates exactly three "Σ is
 *    UNKNOWN" conditions (missing total_budget, missing program_name,
 *    duplicate program name) and "the listing was truncated" is NOT one of
 *    them — so a truncated page yields a Σ that looks fully known and is too
 *    small. The raise never fires, and the next `connect_create_opportunity`
 *    rejects with "Budget exceeds the program budget", the exact failure the
 *    step exists to prevent.
 *  - The `name` filter is applied CLIENT-SIDE to whatever came back, so a
 *    lookup returned zero for an opportunity that exists on page 2+.
 *
 * Observed live on ai-demo-space 2026-08-23 (bednet-check-2-visit Phase 4):
 * exactly 20 rows for an org that demonstrably holds more.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../mcp/connect/backends/playwright.js';

/** Anchor markup matching parseOpportunitiesList's `flex flex-col` selector. */
const opp = (uuid: string, name: string) =>
  `<a href="/a/ai-demo-space/opportunity/${uuid}/" class="flex flex-col items-start">` +
  `<p>${name}</p><p>short desc</p></a>`;

const uuidFor = (n: number) => `${String(n).padStart(8, '0')}-1111-1111-1111-111111111111`;

/**
 * A fake Connect that paginates exactly the way upstream does: `page_size`
 * honoured only when in PAGE_SIZE_OPTIONS, `page` slices, out-of-range 404s.
 */
function paginatingBackend(totalOpps: number) {
  const requestedPaths: string[] = [];
  const all = Array.from({ length: totalOpps }, (_, i) => ({ id: uuidFor(i + 1), name: `Opp ${i + 1}` }));
  const request = {
    get: async (path: string) => {
      requestedPaths.push(path);
      const url = new URL(path, 'https://connect.dimagi.com');
      const rawSize = Number(url.searchParams.get('page_size'));
      const size = [20, 30, 50, 100].includes(rawSize) ? rawSize : 20; // get_validated_page_size
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = all.slice((page - 1) * size, page * size);
      if (slice.length === 0 && page > 1) {
        return { status: () => 404, headers: () => ({}), text: async () => 'not found' } as unknown as APIResponse;
      }
      const html = `<html><body>${slice.map((o) => opp(o.id, o.name)).join('')}</body></html>`;
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => html,
      } as unknown as APIResponse;
    },
  } as unknown as APIRequestContext;
  const backend = new PlaywrightBackend({
    baseUrl: 'https://connect.dimagi.com',
    csrfToken: 'csrf',
    request,
  });
  return { backend, requestedPaths };
}

describe('listOpportunities pagination (#1590)', () => {
  it('returns EVERY opportunity, not just Connect’s first page', async () => {
    // 253 opps = 3 pages at 100. The pre-fix code returned 20.
    const { backend } = paginatingBackend(253);
    const { opportunities } = await backend.listOpportunities({ organization_slug: 'ai-demo-space' });
    expect(opportunities).toHaveLength(253);
    expect(new Set(opportunities.map((o) => o.id)).size).toBe(253);
  });

  it('requests a page_size upstream actually honours', async () => {
    // get_validated_page_size falls back to 20 for anything outside
    // PAGE_SIZE_OPTIONS, so an "optimised" 500 would silently paginate at 20.
    const { backend, requestedPaths } = paginatingBackend(30);
    await backend.listOpportunities({ organization_slug: 'ai-demo-space' });
    for (const p of requestedPaths) {
      const size = Number(new URL(p, 'https://connect.dimagi.com').searchParams.get('page_size'));
      expect([20, 30, 50, 100]).toContain(size);
    }
  });

  it('finds a name-filtered opportunity that lives beyond the first page', async () => {
    // The client-side name filter is only as complete as the listing feeding
    // it: pre-fix this returned [] for an opportunity that exists.
    const { backend } = paginatingBackend(150);
    const { opportunities } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: 'Opp 140',
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].id).toBe(uuidFor(140));
  });

  it('stops on a short page rather than walking to the page cap', async () => {
    const { backend, requestedPaths } = paginatingBackend(150);
    await backend.listOpportunities({ organization_slug: 'ai-demo-space' });
    expect(requestedPaths).toHaveLength(2); // 100 + 50, then stop
  });

  it('does not spin forever against a server that ignores `page`', async () => {
    // Termination must not depend on the server paginating correctly.
    let calls = 0;
    const html = `<html><body>${Array.from({ length: 100 }, (_, i) => opp(uuidFor(i + 1), `Opp ${i + 1}`)).join('')}</body></html>`;
    const request = {
      get: async () => {
        calls++;
        return {
          status: () => 200,
          headers: () => ({ 'content-type': 'text/html' }),
          text: async () => html,
        } as unknown as APIResponse;
      },
    } as unknown as APIRequestContext;
    const backend = new PlaywrightBackend({ baseUrl: 'https://connect.dimagi.com', csrfToken: 'csrf', request });
    const { opportunities } = await backend.listOpportunities({ organization_slug: 'ai-demo-space' });
    expect(opportunities).toHaveLength(100);
    expect(calls).toBe(2); // page 2 adds nothing new -> stop
  });

  it('still throws when the FIRST page fails (a real error, not an empty list)', async () => {
    const request = {
      get: async () =>
        ({ status: () => 500, headers: () => ({}), text: async () => 'boom' }) as unknown as APIResponse,
    } as unknown as APIRequestContext;
    const backend = new PlaywrightBackend({ baseUrl: 'https://connect.dimagi.com', csrfToken: 'csrf', request });
    await expect(backend.listOpportunities({ organization_slug: 'ai-demo-space' })).rejects.toThrow();
  });
});
