/**
 * dimagi-internal/ace#3211 — Connect's opportunity list page
 * (`/a/<org>/opportunity/`) applies DEFAULT filters (status=Active,
 * is_test=No) unless the request carries `filtered=1`. Every ACE opportunity
 * is `is_test: true`, so a request without it rendered "No Opportunities
 * created yet." and `listOpportunities` reported `{complete: true,
 * total_count: 0}` on orgs holding 13 opportunities (live probe,
 * connect-fi/20261018-1440, 2026-10-19 — query variants quoted in the issue).
 *
 * The fake below reproduces that upstream behaviour: without `filtered=1` it
 * serves the empty default view.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';

const uuidFor = (i: number) => `${String(i).padStart(8, '0')}-3211-3211-3211-321132113211`;
const anchor = (i: number) =>
  `<a href="/a/ace-nm-org/opportunity/${uuidFor(i)}/" class="flex flex-col items-start">` +
  `<p>Opp ${i}</p><p>desc ${i}</p></a>`;
const footer = (page: number, numPages: number) => `
  <div class="table-footer">
    <input type="number" value="${page}" min="1" max="${numPages}"
           hx-on:change="goToPage('page', this.value)">
    <span class="whitespace-nowrap ml-1">of ${numPages}</span>
  </div>`;

function fakeConnect(total: number) {
  const calls: string[] = [];
  const request = {
    get: async (path: string) => {
      calls.push(path);
      const url = new URL(path, 'https://connect.dimagi.com');
      const filtered = url.searchParams.get('filtered') === '1';
      // Default filters (status=Active, is_test=No) hide every ACE opportunity.
      const visible = filtered ? total : 0;
      const size = 100;
      const numPages = Math.max(1, Math.ceil(visible / size));
      let page = Number(url.searchParams.get('page') ?? 1);
      if (page > numPages) page = numPages;
      const start = (page - 1) * size;
      const rows = Array.from({ length: Math.max(0, Math.min(size, visible - start)) }, (_, k) =>
        anchor(start + k),
      );
      const body =
        visible === 0
          ? '<form><select name="status"><option value="0" selected>Active</option></select>' +
            '<select name="is_test"><option value="false" selected>No</option></select></form>' +
            '<td>No Opportunities created yet.</td>'
          : rows.join('\n') + (visible > 20 ? footer(page, numPages) : '');
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => `<html><body>${body}</body></html>`,
      } as unknown as APIResponse;
    },
  } as unknown as APIRequestContext;
  return {
    calls,
    backend: new PlaywrightBackend({ baseUrl: 'https://connect.dimagi.com', csrfToken: 'csrf', request }),
  };
}

const listPageCalls = (calls: string[]) =>
  calls.filter((c) => /^\/a\/[^/]+\/opportunity\/\?/.test(c));

describe('listOpportunities disables Connect default filters (#3211)', () => {
  it('sends filtered=1 on EVERY page request of the walk', async () => {
    const { backend, calls } = fakeConnect(250);
    const { opportunities } = await backend.listOpportunities({ organization_slug: 'ace-nm-org' });
    expect(opportunities).toHaveLength(250);
    const pages = listPageCalls(calls);
    expect(pages.length).toBe(3);
    for (const c of pages) {
      expect(new URL(c, 'https://x').searchParams.get('filtered')).toBe('1');
    }
  });

  it('sees is_test opportunities the default view hides, instead of a complete empty listing', async () => {
    const { backend } = fakeConnect(13);
    const { opportunities, listing } = await backend.listOpportunities({
      organization_slug: 'ace-nm-org',
    });
    expect(opportunities).toHaveLength(13);
    expect(listing).toMatchObject({ complete: true, total_count: 13 });
  });
});
