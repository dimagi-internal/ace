/**
 * commcare_get_subscription — the plan read-back for a new project space
 * (ace#2552). A space `commcare_create_domain` makes starts on HQ's Free plan,
 * whose REST API is closed; an HQ superuser converts it to Enterprise under the
 * ace-enterprise subscription ("Test or Demo Project"). This atom is how ACE
 * confirms that landed, from HQ's own page rather than a 401 that also means
 * "no such space" (ace#2551).
 *
 * Fixtures are the verbatim `plan` page-data divs of the live subscription
 * pages, read 2026-10-02 as ace@: connect-ace-spark (created by a clone,
 * still Free) and connect-ace-prod (paid).
 */
import { readFileSync } from 'fs';
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend, parseSubscriptionPage } from '../../../../mcp/connect/backends/commcare.js';

const fixture = (n: string) => readFileSync(new URL(`../../../fixtures/hq-subscription/${n}.html`, import.meta.url), 'utf8');

describe('parseSubscriptionPage', () => {
  it('reads a freshly created space as Free — not paid', () => {
    const info = parseSubscriptionPage(fixture('connect-ace-spark'), 'connect-ace-spark');
    expect(info).toMatchObject({ edition: 'Free', name: 'CommCare Free Edition', is_paid_edition: false, do_not_invoice: false, date_end: null });
  });

  it('reads a paid space as paid, with its end date', () => {
    const info = parseSubscriptionPage(fixture('connect-ace-prod'), 'connect-ace-prod');
    expect(info).toMatchObject({ edition: 'Advanced', is_paid_edition: true, do_not_invoice: true, date_end: 'Dec 31, 2026' });
  });

  it('reads the Enterprise "Test or Demo Project" shape as paid', () => {
    const plan = { edition: 'Enterprise', name: 'CommCare Enterprise Edition', do_not_invoice: true, is_paused: false, date_start: 'Oct 02, 2026', date_end: '--' };
    const html = `<div data-name="plan" data-value="${JSON.stringify(plan).replace(/"/g, '&quot;')}"></div>`;
    expect(parseSubscriptionPage(html, 'x')).toMatchObject({ edition: 'Enterprise', is_paid_edition: true, date_end: null });
  });

  it('treats a paused plan as not paid, and a page without plan data as null', () => {
    const html = `<div data-name="plan" data-value="${JSON.stringify({ edition: 'Paused', is_paused: true }).replace(/"/g, '&quot;')}"></div>`;
    expect(parseSubscriptionPage(html, 'x')?.is_paid_edition).toBe(false);
    expect(parseSubscriptionPage('<html>no plan</html>', 'x')).toBeNull();
  });
});

function backend(status: number, body = '', location = '') {
  const request = {
    get: vi.fn(async (_url: string) => ({ status: () => status, text: async () => body, headers: () => ({ location }) })),
    storageState: vi.fn(async () => ({ cookies: [] })),
  };
  const session = { getContext: async () => ({ request }), invalidate: async () => {} };
  return { request, be: new CommCareBackend({ baseUrl: 'https://www.commcarehq.org', session: session as never }) };
}

describe('CommCareBackend.getSubscription', () => {
  it('GETs the subscription page and parses it', async () => {
    const { be, request } = backend(200, fixture('connect-ace-spark'));
    await expect(be.getSubscription({ domain: 'connect-ace-spark' })).resolves.toMatchObject({ edition: 'Free' });
    expect(request.get.mock.calls[0][0]).toBe('https://www.commcarehq.org/a/connect-ace-spark/settings/project/subscription/');
  });

  it('names a non-member / missing space instead of returning a plan', async () => {
    const { be } = backend(404, 'Not Found');
    await expect(be.getSubscription({ domain: 'ace-enterprise' })).rejects.toThrow(/does not exist or ace@ is not a member/);
  });
});
