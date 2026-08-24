/**
 * dimagi-internal/ace#1590, second half — the walk landed in PR #1600; this
 * covers what a caller still could not SEE.
 *
 * PR #1600 made `listOpportunities` page through the listing instead of
 * returning Connect page 1 (20 rows). What it did not add is any way for a
 * caller to tell a COMPLETE listing from a capped one, and the walk itself
 * rested on two guesses about the upstream surface. Both matter because
 * `connect-program-setup § Step 4a` SUMS `total_budget` over these rows to
 * size program-budget headroom: a Sigma over a partial listing is not a
 * smaller-but-valid total, it is a number about a different set, and it looks
 * exactly as confident as a correct one.
 *
 * So this file pins:
 *
 *  - the `listing` completeness envelope (`complete`, `total_count`,
 *    `pages_fetched`, `declared_pages`, `truncated_reason`), including
 *    `complete: false` at the page cap;
 *  - the page-parameter NAME being read off the footer rather than hardcoded
 *    to `page` — django-tables2 exposes `prefixed_page_field`, and a prefixed
 *    table ignores a bare `?page=` entirely;
 *  - `paginator.num_pages` being read off the footer, so the walk stops where
 *    the paginator says it ends;
 *  - the REAL out-of-range behaviour (see below), which is not a 404;
 *  - a bounded hydrate pool, since exhaustive paging removed the accidental
 *    20-row ceiling that used to bound the fan-out.
 *
 * ## The upstream contract these tests encode
 *
 * Read from source, not inferred:
 *
 *  - `commcare_connect/utils/tables.py:17-18` — `DEFAULT_PAGE_SIZE = 20`,
 *    `PAGE_SIZE_OPTIONS = [20, 30, 50, 100]`.
 *  - `commcare_connect/utils/tables.py:111-116` — `get_validated_page_size`
 *    honours `?page_size=<n>` only for `n` in `PAGE_SIZE_OPTIONS`, else 20.
 *  - `commcare_connect/opportunity/views.py:288-306` — `OpportunityList` is a
 *    `SingleTableView` whose `get_paginate_by` returns that validated size.
 *  - `commcare_connect/templates/base_table.html` — the footer renders
 *    `max="{{ table.paginator.num_pages }}"` and
 *    `goToPage('{{ table.prefixed_page_field }}', ...)`, i.e. the total page
 *    count AND the page parameter name are both on the page. It renders only
 *    `{% if table.page and table.paginator.count > DEFAULT_PAGE_SIZE %}`, so
 *    its ABSENCE means "20 rows or fewer", never "one page".
 *  - `django_tables2/config.py::RequestConfig.configure` — `silent=True` by
 *    default, mapping `EmptyPage` to `paginator.page(num_pages)`. **An
 *    out-of-range page returns the LAST page with HTTP 200, never a 404.**
 *    The fake server below reproduces that deliberately, because a walk whose
 *    termination depends on an error that never arrives does not terminate.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { parseTablePagination } from '../../../../mcp/connect/backends/html-scrape.js';

const PAGE_SIZE_OPTIONS = [20, 30, 50, 100];
const DEFAULT_PAGE_SIZE = 20;

const uuidFor = (i: number) => `${String(i).padStart(8, '0')}-1111-1111-1111-111111111111`;

/** Anchor markup matching parseOpportunitiesList's `flex flex-col` selector. */
const anchor = (i: number) =>
  `<a href="/a/ai-demo-space/opportunity/${uuidFor(i)}/" class="flex flex-col items-start">` +
  `<p>Opp ${i}</p><p>desc ${i}</p></a>`;

/** The pagination footer from `base_table.html`, rendered for one page. */
const footerHtml = (page: number, numPages: number, pageField = 'page') => `
  <div class="table-footer w-full flex items-center justify-between h-14">
    <button type="button" @click="goToPage('${pageField}', ${Math.max(1, page - 1)})" class="button-icon"></button>
    <span class="whitespace-nowrap">Page</span>
    <input type="number"
           value="${page}"
           min="1"
           max="${numPages}"
           class="base-input w-16 text-center"
           aria-label="Current page number, input to navigate"
           hx-trigger="change"
           hx-on:change="goToPage('${pageField}', this.value)">
    <span class="whitespace-nowrap ml-1">of ${numPages}</span>
    <button type="button" @click="goToPage('${pageField}', ${page + 1})" class="button-icon"></button>
    <select id="page-size" name="page_size" @change="goToPage('page_size', $event.target.value)">
      <option value="20">20</option><option value="100">100</option>
    </select>
  </div>`;

interface FakeServer {
  backend: PlaywrightBackend;
  calls: string[];
}

/**
 * A fake Connect that paginates exactly the way upstream does — including the
 * two behaviours that make a naive scraper wrong: `page_size` is honoured only
 * for values in `PAGE_SIZE_OPTIONS`, and an out-of-range `page` yields the LAST
 * page with a 200 rather than an error.
 */
function fakeConnect(opts: {
  total: number;
  honorPageSize?: boolean;
  renderFooter?: boolean;
  pageField?: string;
}): FakeServer {
  const { total, honorPageSize = true, renderFooter = true, pageField = 'page' } = opts;
  const calls: string[] = [];
  const request = {
    get: async (path: string) => {
      calls.push(path);
      const url = new URL(path, 'https://connect.dimagi.com');
      const requested = Number(url.searchParams.get('page_size') ?? DEFAULT_PAGE_SIZE);
      const size =
        honorPageSize && PAGE_SIZE_OPTIONS.includes(requested) ? requested : DEFAULT_PAGE_SIZE;
      const numPages = Math.max(1, Math.ceil(total / size));
      let page = Number(url.searchParams.get(pageField) ?? 1);
      if (!Number.isFinite(page) || page < 1) page = 1;
      // django-tables2 RequestConfig(silent=True): EmptyPage -> LAST page.
      if (page > numPages) page = numPages;
      const start = (page - 1) * size;
      const rows = Array.from({ length: Math.min(size, total - start) }, (_, k) => anchor(start + k));
      const footer = renderFooter && total > DEFAULT_PAGE_SIZE ? footerHtml(page, numPages, pageField) : '';
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => `<html><body>${rows.join('\n')}${footer}</body></html>`,
      } as unknown as APIResponse;
    },
  } as unknown as APIRequestContext;
  return {
    calls,
    backend: new PlaywrightBackend({
      baseUrl: 'https://connect.dimagi.com',
      csrfToken: 'csrf',
      request,
    }),
  };
}

describe('parseTablePagination (base_table.html footer)', () => {
  it('reads num_pages, current page and the page parameter off the footer', () => {
    const got = parseTablePagination(`<html>${footerHtml(2, 7)}</html>`);
    expect(got).toEqual({ num_pages: 7, current_page: 2, page_field: 'page' });
  });

  it('reads a PREFIXED page field rather than assuming "page"', () => {
    // django-tables2 exposes `prefixed_page_field`, so a table with a prefix
    // ignores `?page=` entirely.
    const got = parseTablePagination(`<html>${footerHtml(1, 4, 'opps-page')}</html>`);
    expect(got.page_field).toBe('opps-page');
    expect(got.num_pages).toBe(4);
  });

  it('never mistakes the page-size selector for the page parameter', () => {
    expect(parseTablePagination(`<html>${footerHtml(1, 3)}</html>`).page_field).not.toBe('page_size');
  });

  it('returns nothing when the footer is absent (<= 20 rows renders no footer)', () => {
    expect(parseTablePagination('<html><body>no footer here</body></html>')).toEqual({});
  });

  it('falls back to the rendered "of <n>" when the input is restyled', () => {
    const html = `<html><span class="whitespace-nowrap ml-1">of 9</span>
      <button @click="goToPage('page', 2)"></button></html>`;
    expect(parseTablePagination(html).num_pages).toBe(9);
  });
});

describe('listOpportunities pagination (#1590)', () => {
  it('asks for the LARGEST page size upstream will honour', async () => {
    const { backend, calls } = fakeConnect({ total: 5 });
    await backend.listOpportunities({ organization_slug: 'ai-demo-space' });
    expect(calls[0]).toContain('page_size=100');
    // 100 is the max of PAGE_SIZE_OPTIONS; anything outside that list is
    // silently downgraded to 20 by get_validated_page_size.
    const asked = Number(new URL(calls[0], 'https://x').searchParams.get('page_size'));
    expect(PAGE_SIZE_OPTIONS).toContain(asked);
    expect(asked).toBe(Math.max(...PAGE_SIZE_OPTIONS));
  });

  it('returns EVERY opportunity, not just the first page', async () => {
    const { backend, calls } = fakeConnect({ total: 250 });
    const { opportunities, listing } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
    });
    expect(opportunities).toHaveLength(250);
    expect(new Set(opportunities.map((o) => o.id)).size).toBe(250);
    expect(opportunities.map((o) => o.name)).toContain('Opp 249');
    expect(listing).toMatchObject({
      complete: true,
      total_count: 250,
      pages_fetched: 3,
      page_size: 100,
      declared_pages: 3,
    });
    expect(listing.truncated_reason).toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it('walks the pages even when the server IGNORES page_size (the live shape)', async () => {
    // The live 2026-08-23 observation was exactly 20 rows back. If a
    // deployment pins the page at DEFAULT_PAGE_SIZE, the walk must still
    // exhaust it rather than trusting the size it asked for.
    const { backend } = fakeConnect({ total: 63, honorPageSize: false });
    const { opportunities, listing } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
    });
    expect(opportunities).toHaveLength(63);
    expect(listing).toMatchObject({ complete: true, total_count: 63, pages_fetched: 4 });
  });

  it('terminates when an out-of-range page silently re-serves the LAST page', async () => {
    // No footer to read num_pages off, so the walk has only the response to go
    // on — and django-tables2 answers an over-range page with the last page and
    // a 200. Stopping on "nothing new" is what keeps this finite.
    const { backend, calls } = fakeConnect({ total: 40, honorPageSize: false, renderFooter: false });
    const { opportunities, listing } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
    });
    expect(opportunities).toHaveLength(40);
    expect(listing.complete).toBe(true);
    expect(listing.declared_pages).toBeUndefined();
    // 2 pages of real rows + 1 that repeated the last page and added nothing.
    expect(calls).toHaveLength(3);
  });

  it('does not read a DEFAULT_PAGE_SIZE response as a short final page', async () => {
    // The stop-on-a-short-page rule has to be measured against the size the
    // server actually used, not the size we asked for. A deployment that pins
    // the page at DEFAULT_PAGE_SIZE hands back 20 rows, which is "short" only
    // relative to the 100 we requested -- reading that as the last page stops
    // the walk at exactly 20 rows, which is the shape ace#1590 reported live.
    const { backend } = fakeConnect({ total: 25, honorPageSize: false, renderFooter: false });
    const { opportunities, listing } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
    });
    expect(opportunities).toHaveLength(25);
    expect(listing.complete).toBe(true);
  });

  it('honours the page parameter name the footer declares, not a hardcoded "page"', async () => {
    const { backend, calls } = fakeConnect({ total: 250, pageField: 'opps-page' });
    const { opportunities } = await backend.listOpportunities({ organization_slug: 'ai-demo-space' });
    expect(opportunities).toHaveLength(250);
    expect(calls[1]).toContain('opps-page=2');
  });

  it('stops after ONE request when the whole org fits on one page', async () => {
    const { backend, calls } = fakeConnect({ total: 12 });
    const { opportunities, listing } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
    });
    expect(opportunities).toHaveLength(12);
    expect(calls).toHaveLength(1);
    expect(listing).toMatchObject({ complete: true, pages_fetched: 1, total_count: 12 });
  });

  it('applies the name filter across ALL pages, not just page 1', async () => {
    // Pre-fix, "Opp 249" existed and came back as zero rows because it sat on
    // page 3 of the listing.
    const { backend } = fakeConnect({ total: 250 });
    const { opportunities } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: 'Opp 249',
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].id).toBe(uuidFor(249));
  });

  it('declares itself INCOMPLETE rather than silently truncating at the page cap', async () => {
    // 60 declared pages against a 50-page cap: the caller must be able to tell
    // this apart from a complete listing, because Step 4a sums over it.
    const { backend } = fakeConnect({ total: 100 * 60 });
    const { opportunities, listing } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
    });
    expect(opportunities).toHaveLength(5000);
    expect(listing.complete).toBe(false);
    expect(listing.pages_fetched).toBe(50);
    expect(listing.declared_pages).toBe(60);
    expect(listing.truncated_reason).toMatch(/50 pages/);
  }, 30_000);

  it('hydrates through a BOUNDED pool, not one unbounded burst per row', async () => {
    // Hydration is 2 GETs per row and used to be bounded by accident (the
    // listing stopped at 20). Exhaustive paging must not turn a 40-request
    // burst into a 230-request one on a real org.
    const total = 60;
    let inFlight = 0;
    let peak = 0;
    const { backend } = fakeConnect({ total });
    // getOpportunity is what hydration fans out to; instrument it directly so
    // the ceiling is measured on the real call path.
    const real = backend.getOpportunity.bind(backend);
    backend.getOpportunity = (async (args: { organization_slug: string; opportunity_id: string }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      void real;
      return { id: args.opportunity_id, name: `hydrated ${args.opportunity_id}` };
    }) as typeof backend.getOpportunity;

    const { opportunities } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      hydrate: true,
    });
    expect(opportunities).toHaveLength(total);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
    // Order is preserved despite the pool.
    expect(opportunities[0].id).toBe(uuidFor(0));
    expect(opportunities[total - 1].id).toBe(uuidFor(total - 1));
  });

  it('reports total_count BEFORE the client-side name filter narrows it', async () => {
    const { backend } = fakeConnect({ total: 250 });
    const { opportunities, listing } = await backend.listOpportunities({
      organization_slug: 'ai-demo-space',
      name: 'Opp 7',
    });
    expect(opportunities).toHaveLength(1);
    expect(listing.total_count).toBe(250);
    expect(listing.complete).toBe(true);
  });
});
