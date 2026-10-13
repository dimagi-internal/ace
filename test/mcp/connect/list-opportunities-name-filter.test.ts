/**
 * ace#2891 — `listOpportunities`'s `name` filter was strict equality while its
 * sibling `listPrograms` did a case-insensitive substring match, so a caller
 * filtering by a real PREFIX of a real opportunity name got `[]` back with
 * `listing.complete: true` — an authoritative-looking "this does not exist".
 *
 *   mcp/connect/backends/playwright.ts (pre-fix)
 *     443  programs = programs.filter((p) => p.name.toLowerCase().includes(needle));
 *     693  if (name) opportunities = opportunities.filter((o) => o.name === name);
 *
 * jjackson/ace#1089 fixed line 443 and its body explicitly named this sibling
 * ("Sibling of #1022, which is the same class on `connect_list_opportunities`").
 * #1022 was then closed as an umbrella without line 693 ever being changed, so
 * the class was fixed on one atom and closed over on the other.
 *
 * Why the opportunity version is the more expensive of the two. Every ACE
 * opportunity is named `<run_id> · <display name>` (code-enforced,
 * INVALID_OPP_NAME_PREFIX), so the run id is the natural key and
 * `name: "<run_id>"` is exactly how a caller asks "did my create land?" after
 * an ambiguous response. Observed live on turmeric-market-study-ghana /
 * 20261012-1749: `connect_create_opportunity` returned HTTP 504 Gateway
 * Time-out while the backend had in fact COMPLETED the transaction, and the
 * run-id read-back returned [] with listing.complete true. Read at face value
 * that licenses a retry — and a duplicate opportunity is unrepairable:
 * `target_organization_slug` is create-time only (connect_update_opportunity
 * has no org field), and a second opp against the same released Deliver app
 * permanently burns the shared DeliverUnit.payment_unit binding
 * (jjackson/ace#573), so the duplicate cannot create payment units at all.
 *
 * The behavioural tests pin the fix. The source test is the actual preventer:
 * these two filters have now drifted apart twice, so the invariant worth
 * holding is that they share one contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../mcp/connect/backends/playwright.js';

/** Anchor markup matching parseOpportunitiesList's `flex flex-col` selector. */
const opp = (uuid: string, name: string) =>
  `<a href="/a/ai-demo-space/opportunity/${uuid}/" class="flex flex-col items-start">` +
  `<p>${name}</p><p>short desc</p></a>`;

const uuidFor = (n: number) => `${String(n).padStart(8, '0')}-1111-1111-1111-111111111111`;

/** The real shape: `<run_id> · <display name>`, with the U+00B7 separator. */
const ACE_OPPS = [
  '20261012-1749 · Turmeric Market Study (Ghana)',
  '20260914-1742 · Turmeric Market Survey',
  '20260915-1430 · Turmeric Market Survey',
  '20260908-1544 · Bednet Use Spot-Check — Two-Visit Household Follow-Up',
];

function backendServing(names: string[]) {
  const request = {
    get: async (path: string) => {
      const url = new URL(path, 'https://connect.dimagi.com');
      const page = Number(url.searchParams.get('page') ?? '1');
      // One short page: the walk stops after it.
      const slice = page === 1 ? names : [];
      if (slice.length === 0 && page > 1) {
        return { status: () => 404, headers: () => ({}), text: async () => 'not found' } as unknown as APIResponse;
      }
      const html = `<html><body>${slice.map((n, i) => opp(uuidFor(i + 1), n)).join('')}</body></html>`;
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => html,
      } as unknown as APIResponse;
    },
  } as unknown as APIRequestContext;
  return new PlaywrightBackend({ baseUrl: 'https://connect.dimagi.com', csrfToken: 'csrf', request });
}

describe('listOpportunities name filter (ace#2891)', () => {
  it('matches on the run-id prefix — the live 504 read-back that returned []', async () => {
    const backend = backendServing(ACE_OPPS);
    const { opportunities } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: '20261012-1749',
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].name).toBe('20261012-1749 · Turmeric Market Study (Ghana)');
  });

  it('still matches on the full exact name', async () => {
    const backend = backendServing(ACE_OPPS);
    const { opportunities } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: '20261012-1749 · Turmeric Market Study (Ghana)',
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].id).toBe(uuidFor(1));
  });

  it('is case-insensitive and tolerates surrounding whitespace, like listPrograms', async () => {
    const backend = backendServing(ACE_OPPS);
    const { opportunities } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: '  TURMERIC MARKET STUDY  ',
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].name).toContain('Turmeric Market Study');
  });

  it('returns every row sharing a substring rather than silently picking one', async () => {
    const backend = backendServing(ACE_OPPS);
    const { opportunities } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: 'Turmeric Market Survey',
    });
    expect(opportunities.map((o) => o.name)).toEqual([
      '20260914-1742 · Turmeric Market Survey',
      '20260915-1430 · Turmeric Market Survey',
    ]);
  });

  it('still returns [] for a name that genuinely is not there', async () => {
    const backend = backendServing(ACE_OPPS);
    const { opportunities } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: '20991231-0000',
    });
    expect(opportunities).toHaveLength(0);
  });

  it('reports the listing as complete regardless of the filter', async () => {
    // The false negative was dangerous precisely BECAUSE completeness stayed
    // true — the caller had no signal that the answer was a filter artefact.
    const backend = backendServing(ACE_OPPS);
    const { listing } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: '20261012-1749',
    });
    expect(listing.complete).toBe(true);
  });
});

describe('listPrograms and listOpportunities share one name-filter contract', () => {
  it('neither atom filters `name` by strict equality', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../mcp/connect/backends/playwright.ts', import.meta.url)),
      'utf8',
    );
    // The exact pre-fix line, and the listPrograms shape it drifted from.
    expect(src).not.toMatch(/\.filter\(\(\w+\)\s*=>\s*\w+\.name\s*===\s*name\)/);
    const substringFilters = src.match(/\w+\.name\.toLowerCase\(\)\.includes\(needle\)/g) ?? [];
    expect(substringFilters).toHaveLength(2); // programs + opportunities
  });
});
