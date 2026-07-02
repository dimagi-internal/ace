/**
 * Unit tests for the Playwright HTML-form fallbacks added in 0.10.55.
 *
 * Background: commcare-connect PR #1135 (the REST automation API) is merged
 * but not yet deployed to connect.dimagi.com prod. Until then, the eight
 * write atoms (createProgram, createOpportunity, createPaymentUnit/s,
 * activateOpportunity, sendLloInvite, acceptProgramApplication,
 * sendFlwInvite) need to fall back to driving the legacy HTML forms via
 * the Playwright `APIRequestContext`. This file mocks the request context
 * and asserts the right URLs, form bodies, and response parsing.
 *
 * Mock pattern mirrors `rest.test.ts` — a tiny scripted-response harness
 * captures what the backend posted so we can assert on URL, body, and
 * headers.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { CompositeBackend } from '../../../../mcp/connect/backends/composite.js';
import {
  ConnectError,
  ConnectValidationError,
  HttpError,
} from '../../../../mcp/connect/errors.js';
import type { ConnectClient } from '../../../../mcp/connect/client.js';
import { TEST_PHONE, TEST_PHONE_2 } from '../../../fixtures/test-phone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fix = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../fixtures/connect-html', name), 'utf8');

// Minimal 7-column payment_unit_table <thead> (pre-2026-07 live layout).
// parsePaymentUnitTable resolves columns by header LABEL (dimagi-internal/
// ace#822) and refuses to parse data rows without a header row, so every
// mocked payment_unit_table body must carry one.
const puTableThead = `<thead><tr>
  <th><span>#</span></th><th><span>Payment Unit Name</span></th>
  <th><span>Start date</span></th><th><span>End date</span></th>
  <th><span>Total Deliveries</span></th><th><span>Max daily</span></th>
  <th><span>Delivery Units</span></th>
</tr></thead>`;

interface CapturedRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: string | Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

interface ScriptedResponse {
  status: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * Build a minimal APIRequestContext that returns scripted responses in
 * order, capturing every call. Routes by `${METHOD} ${url-path-without-query}`.
 * If the next scripted response is set up generically (no specific URL
 * matching), it answers in FIFO order.
 */
function makeRequestContext(
  scripted: ScriptedResponse[],
  captured: CapturedRequest[],
): APIRequestContext {
  let i = 0;
  const respond = (next: ScriptedResponse): APIResponse => {
    return {
      status: () => next.status,
      headers: () => ({
        'content-type': next.contentType ?? 'text/html; charset=utf-8',
        ...(next.headers ?? {}),
      }),
      text: async () => next.body,
    } as unknown as APIResponse;
  };
  const get = async (url: string) => {
    captured.push({ method: 'GET', url });
    const next = scripted[i++];
    if (!next) throw new Error(`No scripted response for GET #${i}: ${url}`);
    return respond(next);
  };
  const post = async (
    url: string,
    init?: { form?: Record<string, string | number | boolean>; data?: unknown; headers?: Record<string, string> },
  ) => {
    captured.push({
      method: 'POST',
      url,
      body: (init?.data as string) ?? init?.form,
      headers: init?.headers,
    });
    const next = scripted[i++];
    if (!next) throw new Error(`No scripted response for POST #${i}: ${url}`);
    return respond(next);
  };
  return { get, post } as unknown as APIRequestContext;
}

const baseUrl = 'https://connect.dimagi.com';
const csrfToken = 'cookie-csrf-fallback';

// Minimal valid HTML stubs ----------------------------------------------------

const FRESH_CSRF = 'fresh-form-csrf-12345';
const csrfInput = `<input type="hidden" name="csrfmiddlewaretoken" value="${FRESH_CSRF}">`;

const programInitHtml = fix('a-ai-demo-space-program-init.html');
const programsListHtml = fix('programs-list-with-data.html');

// ─── createProgram ──────────────────────────────────────────────────────────

describe('PlaywrightBackend.createProgram', () => {
  it('GETs the init form, POSTs name+description+resolved-codes, then lists to find the new program', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        // GET /a/<org>/program/init/  → form HTML (real fixture)
        { status: 200, body: programInitHtml },
        // POST /a/<org>/program/init/  → success (no errorlist)
        { status: 200, body: '<div>created</div>' },
        // GET /a/<org>/program/  → list (real fixture, has ACE-Probe program)
        { status: 200, body: programsListHtml },
        // GET /a/<org>/program/<uuid>/edit  → field values for hydration
        {
          status: 200,
          body:
            csrfInput +
            '<input name="name" value="ACE-Probe-2026-04-28">' +
            '<textarea name="description">probe</textarea>' +
            '<select name="delivery_type"><option value="13" selected>Nutrition</option></select>' +
            '<input name="budget" value="1000">' +
            '<select name="currency"><option value="USD" selected>US Dollar</option></select>' +
            '<select name="country"><option value="USA" selected>United States</option></select>' +
            '<input name="start_date" value="2026-05-01">' +
            '<input name="end_date" value="2026-12-31">',
        },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.createProgram({
      organization_slug: 'ai-demo-space',
      name: 'ACE-Probe-1777406601155',
      description: 'probe',
      delivery_type: 'Nutrition',
      budget: 1000,
      currency: 'USD',
      country: 'United States of America',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    });
    expect(out.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(out.organization_slug).toBe('ai-demo-space');

    const post = captured.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/a/ai-demo-space/program/init/');
    expect(post.headers!['Referer']).toBe('https://connect.dimagi.com/a/ai-demo-space/program/');
    expect(post.headers!['X-CSRFToken']).toBeDefined();
    const body = post.body as Record<string, string>;
    expect(body.name).toBe('ACE-Probe-1777406601155');
    expect(body.description).toBe('probe');
    expect(body.delivery_type).toBe('13'); // resolved from "Nutrition"
    expect(body.country).toBe('USA'); // resolved from "United States of America"
    expect(body.currency).toBe('USD');
    expect(body.budget).toBe('1000');
  });

  it('throws ConnectValidationError when the form re-renders with errorlist', async () => {
    const captured: CapturedRequest[] = [];
    // Real-shape validation HTML captured live from a POST that omitted name+description
    const validationFailHtml = `
      <form>${csrfInput}
        <div id="div_id_name" class="mb-3">
          <p id="error_1_id_name" class="text-red-500"><strong>This field is required.</strong></p>
        </div>
      </form>
    `;
    const request = makeRequestContext(
      [
        { status: 200, body: programInitHtml },
        { status: 200, body: validationFailHtml },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.createProgram({
        organization_slug: 'x',
        name: '',
        description: '',
        delivery_type: 'Nutrition',
        budget: 0,
        currency: 'USD',
        country: 'USA',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('falls back to listing when the success response has no UUID', async () => {
    // Same as the happy path above, but validates the listing call shape.
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: programInitHtml },
        { status: 200, body: '<div>swap target</div>' },
        { status: 200, body: programsListHtml },
        {
          status: 200,
          body: csrfInput + '<input name="name" value="ACE-Probe-2026-04-28">',
        },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await backend.createProgram({
      organization_slug: 'ai-demo-space',
      name: 'ACE-Probe-1777406601155',
      description: 'probe',
      delivery_type: 13,
      budget: 1000,
      currency: 'USD',
      country: 'USA',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    });
    const urls = captured.map((c) => `${c.method} ${c.url}`);
    expect(urls).toContain('GET /a/ai-demo-space/program/');
  });
});

// ─── createOpportunity (3-step HTMX fallback restored 0.10.68) ─────────────

describe('PlaywrightBackend.createOpportunity', () => {
  // Fixtures we'll lean on for the init-form GET + redirect parsing.
  const oppInitForm = fix('a-ai-demo-space-opportunity-init.html');
  const oppEditForm = fix('opportunity-dea88661-1cd6-486b-ab25-48584bf61a8e-edit.html');

  // The HTMX `/users/api_keys/?hq_server=N` endpoint returns a select-fragment.
  // For these tests we mock both branches: "key already registered" and
  // "key not yet registered → POST add_api_key/ → re-list → found".
  function mkKeyDropdown(opts: Array<{ value: string; text: string }>): string {
    return (
      '<select name="api_key">' +
      opts
        .map((o) => `<option value="${o.value}">${o.text}</option>`)
        .join('') +
      '</select>'
    );
  }

  // The HTMX `/hq/applications/?hq_server=&<field>=&api_key=` endpoint
  // returns a select with JSON-encoded `value` strings.
  function mkAppDropdown(apps: Array<{ id: string; name: string }>): string {
    return (
      '<select name="learn_app">' +
      apps
        .map((a) => {
          const json = JSON.stringify({ id: a.id, name: a.name }).replace(/"/g, '&quot;');
          return `<option value="${json}">${a.name}</option>`;
        })
        .join('') +
      '</select>'
    );
  }

  // Minimal program-edit HTML for getProgram (returns currency/country).
  const programEditHtml =
    csrfInput +
    '<input name="name" value="Test Program">' +
    '<textarea name="description">desc</textarea>' +
    '<select name="delivery_type"><option value="13" selected>Nutrition</option></select>' +
    '<input name="budget" value="1000000">' +
    '<select name="currency"><option value="USD" selected>USD</option></select>' +
    '<select name="country"><option value="USA" selected>USA</option></select>' +
    '<input name="start_date" value="2026-04-01">' +
    '<input name="end_date" value="2026-12-31">';

  // Minimal opp detail HTML so the post-create getOpportunity call returns
  // a proper Opportunity (parser finds zero apps but that's fine).
  const oppDetailEmpty = '<div>opp detail</div>';

  it('drives the init wizard: register HQ key → resolve apps → POST init → return hydrated opp (no finalize)', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        // 1) GET /opportunity/init/ → form HTML (real fixture, has hq_server select with prod=1)
        { status: 200, body: oppInitForm },
        // 2) ensureHqApiKeyRegistered: GET /users/api_keys/?hq_server=1 → dropdown WITHOUT our key
        { status: 200, body: mkKeyDropdown([{ value: '', text: '---------' }]) },
        // 3) POST /opportunity/add_api_key/ → 200 with re-rendered fragment
        { status: 200, body: '<div>added</div>' },
        // 4) GET /users/api_keys/?hq_server=1 → dropdown WITH our key (truncated label "abcd...0000")
        { status: 200, body: mkKeyDropdown([{ value: '42', text: 'abcd...0000' }]) },
        // 5) GET /hq/applications/...&learn_app_domain=learn-domain&... → JSON-encoded options
        {
          status: 200,
          body: mkAppDropdown([{ id: 'learn-app-id-32hex', name: 'Learn App' }]),
        },
        // 6) GET /hq/applications/...&deliver_app_domain=deliver-domain&... → JSON-encoded options
        {
          status: 200,
          body: mkAppDropdown([{ id: 'deliver-app-id-32hex', name: 'Deliver App' }]),
        },
        // 7) GET /opportunity/init/ AGAIN (refetch CSRF + country select before the create POST)
        { status: 200, body: oppInitForm },
        // 8) GET /program/<id>/edit (getProgram inside createOpportunity for currency/country)
        { status: 200, body: programEditHtml },
        // 9) POST /opportunity/init/ → 302 to /payment_units/create (real prod redirect)
        {
          status: 302,
          body: '',
          headers: {
            location: '/a/ai-demo-space/opportunity/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/payment_units/create',
          },
        },
        // 10) post-create getOpportunity: GET /opportunity/<id>/edit
        { status: 200, body: oppEditForm },
        // 11) post-create getOpportunity: GET /opportunity/<id>/ (detail)
        { status: 200, body: oppDetailEmpty },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.createOpportunity({
      organization_slug: 'ai-demo-space',
      program_id: '3472fe95-d6d3-42c2-824a-55c5c7dff552',
      name: 'Test Opp',
      short_description: 'short',
      description: 'longer description',
      target_organization_slug: 'ai-demo-space',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
      total_budget: 100000,
      learn_app: {
        hq_server_url: 'https://www.commcarehq.org',
        api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000', // truncated → "abcd...0000"
        cc_domain: 'learn-domain',
        cc_app_id: 'learn-app-id-32hex',
        description: 'Learn app',
        passing_score: 80,
      },
      deliver_app: {
        hq_server_url: 'https://www.commcarehq.org',
        api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
        cc_domain: 'deliver-domain',
        cc_app_id: 'deliver-app-id-32hex',
      },
    });
    expect(out.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const posts = captured.filter((c) => c.method === 'POST');
    // add_api_key + opportunity/init = 2 POSTs (no finalize anymore)
    expect(posts).toHaveLength(2);

    // 1) add_api_key/ POST
    const addKeyPost = posts.find((p) => p.url.endsWith('/add_api_key/'))!;
    expect(addKeyPost).toBeDefined();
    const akBody = addKeyPost.body as Record<string, string>;
    expect(akBody.hq_server).toBe('1'); // resolved from prod URL
    expect(akBody.api_key).toBe('abcdefghijklmnopqrstuvwxyz1234567890_0000');
    expect(addKeyPost.headers!['HX-Request']).toBe('true');

    // 2) opportunity/init/ POST
    const initPost = posts.find((p) => p.url === '/a/ai-demo-space/opportunity/init/')!;
    expect(initPost).toBeDefined();
    const initBody = initPost.body as Record<string, string>;
    expect(initBody.name).toBe('Test Opp');
    expect(initBody.short_description).toBe('short');
    expect(initBody.description).toBe('longer description');
    expect(initBody.hq_server).toBe('1');
    expect(initBody.api_key).toBe('42'); // int FK from dropdown
    expect(initBody.learn_app_domain).toBe('learn-domain');
    expect(initBody.deliver_app_domain).toBe('deliver-domain');
    expect(initBody.learn_app_passing_score).toBe('80');
    expect(initBody.learn_app_description).toBe('Learn app');
    // 0.10.82: program field is NOT sent (form doesn't accept it; sending
    // it was silently ignored on success and tripped a 500 path on edge cases).
    expect(initBody.program).toBeUndefined();
    // currency/country pulled from the parent program (HTML form requires both)
    expect(initBody.currency).toBe('USD');
    expect(initBody.country).toBe('USA');
    // learn_app & deliver_app are JSON strings (id+name) from /hq/applications/
    expect(initBody.learn_app).toContain('learn-app-id-32hex');
    expect(initBody.deliver_app).toContain('deliver-app-id-32hex');

    // 0.10.82: NO finalize/ POST happens inside createOpportunity. The
    // wizard's finalize step requires payment units to exist first; PUs
    // are a separate atom (createPaymentUnit/s) and the orchestrator
    // runs them after this atom returns. Activation is a third atom.
    expect(posts.find((p) => p.url.endsWith('/finalize/'))).toBeUndefined();
  });

  it('rejects mismatched hq_server_url across learn_app and deliver_app', async () => {
    const request = makeRequestContext([], []);
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.createOpportunity({
        organization_slug: 'pm-org',
        program_id: 'p',
        name: 'X',
        short_description: 's',
        description: 'd',
        target_organization_slug: 'pm-org',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
        total_budget: 1,
        learn_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'k', cc_domain: 'd', cc_app_id: 'la', description: 'L', passing_score: 80 },
        deliver_app: { hq_server_url: 'https://india.commcarehq.org', api_key: 'k', cc_domain: 'd', cc_app_id: 'da' },
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('rejects mismatched api_key across learn_app and deliver_app', async () => {
    const request = makeRequestContext([], []);
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.createOpportunity({
        organization_slug: 'pm-org',
        program_id: 'p',
        name: 'X',
        short_description: 's',
        description: 'd',
        target_organization_slug: 'pm-org',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
        total_budget: 1,
        learn_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'key-A', cc_domain: 'd', cc_app_id: 'la', description: 'L', passing_score: 80 },
        deliver_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'key-B', cc_domain: 'd', cc_app_id: 'da' },
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('throws when hq_server_url cannot be resolved against the form options', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        // GET /opportunity/init/ → form WITHOUT a matching hq_server option
        { status: 200, body: '<select name="hq_server"><option value=""></option></select>' + csrfInput },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.createOpportunity({
        organization_slug: 'ai-demo-space',
        program_id: 'p',
        name: 'X',
        short_description: 's',
        description: 'd',
        target_organization_slug: 'ai-demo-space',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
        total_budget: 1,
        learn_app: { hq_server_url: 'https://nonsense.example.com', api_key: 'k', cc_domain: 'd', cc_app_id: 'la', description: 'L', passing_score: 80 },
        deliver_app: { hq_server_url: 'https://nonsense.example.com', api_key: 'k', cc_domain: 'd', cc_app_id: 'da' },
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('propagates HttpError when init POST returns 5xx', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: oppInitForm },
        { status: 200, body: mkKeyDropdown([{ value: '42', text: 'abcd...0000' }]) },
        { status: 200, body: mkAppDropdown([{ id: 'learn-app-id-32hex', name: 'Learn App' }]) },
        { status: 200, body: mkAppDropdown([{ id: 'deliver-app-id-32hex', name: 'Deliver App' }]) },
        { status: 200, body: oppInitForm }, // refetch CSRF
        { status: 200, body: programEditHtml }, // getProgram for currency/country
        { status: 500, body: 'Server Error' }, // POST /opportunity/init/ → 500
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.createOpportunity({
        organization_slug: 'ai-demo-space',
        program_id: 'p',
        name: 'X',
        short_description: 's',
        description: 'd',
        target_organization_slug: 'ai-demo-space',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
        total_budget: 1,
        learn_app: {
          hq_server_url: 'https://www.commcarehq.org',
          api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
          cc_domain: 'd',
          cc_app_id: 'learn-app-id-32hex',
          description: 'L',
          passing_score: 80,
        },
        deliver_app: {
          hq_server_url: 'https://www.commcarehq.org',
          api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
          cc_domain: 'd',
          cc_app_id: 'deliver-app-id-32hex',
        },
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('throws ConnectValidationError when init POST returns 200 with errorlist', async () => {
    const captured: CapturedRequest[] = [];
    const errorListHtml =
      '<form><ul class="errorlist"><li>Name is required.</li></ul></form>';
    const request = makeRequestContext(
      [
        { status: 200, body: oppInitForm },
        { status: 200, body: mkKeyDropdown([{ value: '42', text: 'abcd...0000' }]) },
        { status: 200, body: mkAppDropdown([{ id: 'learn-app-id-32hex', name: 'Learn App' }]) },
        { status: 200, body: mkAppDropdown([{ id: 'deliver-app-id-32hex', name: 'Deliver App' }]) },
        { status: 200, body: oppInitForm },
        { status: 200, body: programEditHtml }, // getProgram for currency/country
        { status: 200, body: errorListHtml },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.createOpportunity({
        organization_slug: 'ai-demo-space',
        program_id: 'p',
        name: '',
        short_description: 's',
        description: 'd',
        target_organization_slug: 'ai-demo-space',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
        total_budget: 1,
        learn_app: {
          hq_server_url: 'https://www.commcarehq.org',
          api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
          cc_domain: 'd',
          cc_app_id: 'learn-app-id-32hex',
          description: 'L',
          passing_score: 80,
        },
        deliver_app: {
          hq_server_url: 'https://www.commcarehq.org',
          api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
          cc_domain: 'd',
          cc_app_id: 'deliver-app-id-32hex',
        },
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  // 0.10.82: dropped the inline finalize step from createOpportunity, so the
  // legacy "throws when finalize sees no payment units" test no longer
  // applies. Finalize is now an out-of-band concern handled by separate
  // atoms (createPaymentUnit/s + activateOpportunity).

  it('extracts the new opp UUID from the live /payment_units/create redirect', async () => {
    // 0.10.82: live POST /opportunity/init/ 302-redirects to
    // /a/<org>/opportunity/<uuid>/payment_units/create (the wizard's
    // step-2 page). Verify the regex picks up the UUID from that shape.
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: oppInitForm },
        { status: 200, body: mkKeyDropdown([{ value: '42', text: 'abcd...0000' }]) },
        { status: 200, body: mkAppDropdown([{ id: 'learn-app-id-32hex', name: 'Learn App' }]) },
        { status: 200, body: mkAppDropdown([{ id: 'deliver-app-id-32hex', name: 'Deliver App' }]) },
        { status: 200, body: oppInitForm },
        { status: 200, body: programEditHtml },
        // 302 to the live wizard step-2 path
        {
          status: 302,
          body: '',
          headers: {
            location:
              '/a/ai-demo-space/opportunity/12345678-1234-1234-1234-123456789012/payment_units/create',
          },
        },
        { status: 200, body: oppEditForm },
        { status: 200, body: oppDetailEmpty },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.createOpportunity({
      organization_slug: 'ai-demo-space',
      program_id: 'p',
      name: 'X',
      short_description: 's',
      description: 'd',
      target_organization_slug: 'ai-demo-space',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
      total_budget: 100,
      learn_app: {
        hq_server_url: 'https://www.commcarehq.org',
        api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
        cc_domain: 'd',
        cc_app_id: 'learn-app-id-32hex',
        description: 'L',
        passing_score: 80,
      },
      deliver_app: {
        hq_server_url: 'https://www.commcarehq.org',
        api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
        cc_domain: 'd',
        cc_app_id: 'deliver-app-id-32hex',
      },
    });
    expect(out.id).toBe('12345678-1234-1234-1234-123456789012');
  });

  it('resolveHqAppValue throws ConnectValidationError when app id is not in HQ options', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: oppInitForm },
        { status: 200, body: mkKeyDropdown([{ value: '42', text: 'abcd...0000' }]) },
        // Learn-app HTMX returns DIFFERENT app ids
        {
          status: 200,
          body: mkAppDropdown([{ id: 'some-other-app', name: 'Other App' }]),
        },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.createOpportunity({
        organization_slug: 'ai-demo-space',
        program_id: 'p',
        name: 'X',
        short_description: 's',
        description: 'd',
        target_organization_slug: 'ai-demo-space',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
        total_budget: 100,
        learn_app: {
          hq_server_url: 'https://www.commcarehq.org',
          api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
          cc_domain: 'd',
          cc_app_id: 'expected-learn-id', // NOT in the dropdown
          description: 'L',
          passing_score: 80,
        },
        deliver_app: {
          hq_server_url: 'https://www.commcarehq.org',
          api_key: 'abcdefghijklmnopqrstuvwxyz1234567890_0000',
          cc_domain: 'd',
          cc_app_id: 'expected-deliver-id',
        },
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });
});

// ─── createPaymentUnit(s) ──────────────────────────────────────────────────

describe('PlaywrightBackend.createPaymentUnit', () => {
  // Fixture-derived: the real payment_unit/create form has these checkboxes
  // for required_deliver_units (values 3339, 3340, 3341, 3342).
  const puCreateForm = fix('opportunity-dea88661-1cd6-486b-ab25-48584bf61a8e-payment_unit-create.html');

  it('POSTs to /payment_unit/create with multi-valued required_deliver_units', async () => {
    const captured: CapturedRequest[] = [];
    // Mock payment_unit_table response with one matching PU
    // 7-column payment_unit_table fixture (verified against live Connect HTML
    // 2026-05-05): id, name, start_date, end_date, max_total ("Total Deliveries"
    // column), max_daily ("Max daily" column), delivery_units count.
    // This layout does NOT render `amount` — see `parsePaymentUnitTable` jsdoc.
    const puTableHtml = `
      <table>
        ${puTableThead}
        <tbody>
          <tr class="even"><td>42</td><td>Visit</td><td>2026-05-01</td><td>2026-12-31</td><td>50</td><td>10</td><td>2</td></tr>
        </tbody>
      </table>
    `;
    const request = makeRequestContext(
      [
        { status: 200, body: puCreateForm },           // GET form
        { status: 200, body: '' },                     // POST sync_deliver_units (precondition, 0.11.12)
        { status: 200, body: puCreateForm },           // GET form refresh after sync
        { status: 302, body: '', headers: { location: '/a/m/opportunity/dea88661.../payment_unit_table/' } }, // POST → redirect
        { status: 200, body: puTableHtml },             // GET payment_unit_table
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.createPaymentUnit({
      organization_slug: 'march-demo',
      opportunity_id: 'dea88661-1cd6-486b-ab25-48584bf61a8e',
      name: 'Visit',
      description: 'A visit',
      amount: 500,
      max_total: 50,
      max_daily: 10,
      required_deliver_units: [3339, 3340],
    });
    expect(out.id).toBe(42);
    expect(out.name).toBe('Visit');
    expect(out.required_deliver_units).toEqual([3339, 3340]);
    // Parser-corrected values round-trip from the table (max_total/max_daily)
    // and from args (amount, since it isn't rendered in the table).
    expect(out.amount).toBe(500);
    expect(out.max_total).toBe(50);
    expect(out.max_daily).toBe(10);

    // Filter to the create POST (the sync_deliver_units precondition POST also captures).
    const post = captured.find(
      (c) => c.method === 'POST' && c.url.endsWith('/payment_unit/create'),
    )!;
    expect(post.url).toBe('/a/march-demo/opportunity/dea88661-1cd6-486b-ab25-48584bf61a8e/payment_unit/create');
    // URLSearchParams body — repeated names for multi-value
    const body = post.body as string;
    expect(body).toContain('name=Visit');
    expect(body).toContain('amount=500');
    expect(body).toContain('max_total=50');
    expect(body).toContain('max_daily=10');
    expect(body).toContain('required_deliver_units=3339');
    expect(body).toContain('required_deliver_units=3340');
    expect(post.headers!['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('regression (0.10.68): maps display-id deliver units to form-value PKs via listDeliverUnits', async () => {
    // Pre-0.10.47 had this mapping; 0.10.64 dropped it (silent-fail regression
    // when callers pass display ids from listDeliverUnits — Connect 302s with
    // a Django messages cookie of "Invalid Data" and never persists the PU).
    // Restored 0.10.68 with a probe: if the input is already a known checkbox
    // value, pass through; otherwise, look up name → form-value via the
    // deliver_unit_table.
    const captured: CapturedRequest[] = [];
    const puTableHtml = `
      <table>
        ${puTableThead}
        <tbody>
          <tr class="even"><td>42</td><td>VendorVisit</td><td>2026-05-01</td><td>2026-12-31</td><td>50</td><td>10</td><td>1</td></tr>
        </tbody>
      </table>
    `;
    // The puCreateForm fixture has checkboxes with values 3339-3342 and labels
    // "Optional Delivery", "Optional Delivery 2", etc. The deliver_unit_table
    // displays display ids 1, 2, ... For this test we simulate a caller
    // passing display ids 1, 2 and verify they get mapped to 3339, 3340.
    const deliverUnitTableHtml = `
      <table>
        <tbody>
          <tr class="even"><td>1</td><td>opt_del</td><td>Optional Delivery</td></tr>
          <tr class="odd"><td>2</td><td>opt_del_2</td><td>Optional Delivery 2</td></tr>
        </tbody>
      </table>
    `;
    const request = makeRequestContext(
      [
        { status: 200, body: puCreateForm },           // GET PU create form
        { status: 200, body: '' },                     // POST sync_deliver_units (precondition, 0.11.12)
        { status: 200, body: puCreateForm },           // GET form refresh after sync
        { status: 200, body: deliverUnitTableHtml },   // listDeliverUnits (mapping lookup)
        { status: 302, body: '' },                     // POST → success
        { status: 200, body: puTableHtml },            // listPaymentUnits
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.createPaymentUnit({
      organization_slug: 'march-demo',
      opportunity_id: 'dea88661-1cd6-486b-ab25-48584bf61a8e',
      name: 'VendorVisit',
      description: 'A visit',
      amount: 500,
      max_total: 50,
      max_daily: 10,
      required_deliver_units: [1, 2], // display ids — must be mapped to 3339, 3340
    });
    expect(out.id).toBe(42);

    // Filter to the create POST (the sync_deliver_units precondition POST also captures).
    const post = captured.find(
      (c) => c.method === 'POST' && c.url.endsWith('/payment_unit/create'),
    )!;
    const body = post.body as string;
    // Should send the mapped PKs, NOT the display ids
    expect(body).toContain('required_deliver_units=3339');
    expect(body).toContain('required_deliver_units=3340');
    expect(body).not.toContain('required_deliver_units=1&');
    expect(body).not.toContain('required_deliver_units=2&');
  });

  it('regression (0.10.68): rejects unknown deliver_unit_id with structured error', async () => {
    const captured: CapturedRequest[] = [];
    const deliverUnitTableHtml = `
      <table>
        <tbody>
          <tr class="even"><td>1</td><td>opt_del</td><td>Optional Delivery</td></tr>
        </tbody>
      </table>
    `;
    const request = makeRequestContext(
      [
        { status: 200, body: puCreateForm },
        { status: 200, body: '' },                     // POST sync_deliver_units (precondition, 0.11.12)
        { status: 200, body: puCreateForm },           // GET form refresh after sync
        { status: 200, body: deliverUnitTableHtml },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.createPaymentUnit({
        organization_slug: 'march-demo',
        opportunity_id: 'dea88661-1cd6-486b-ab25-48584bf61a8e',
        name: 'X',
        amount: 1,
        max_total: 1,
        max_daily: 1,
        required_deliver_units: [9999], // not in the form, not a known display id
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('regression (0.11.12): fires sync_deliver_units precondition + form refresh when DUs requested', async () => {
    // Connect's create-PU form leaves the deliver-unit checkbox list empty
    // until an HTMX-driven Sync Deliver Units button is fired. This precondition
    // POST runs before the form is scraped so DU checkboxes are populated. See
    // mcp/connect/backends/playwright.ts § Sync-deliver-units precondition.
    const captured: CapturedRequest[] = [];
    const puTableHtml = `<table>${puTableThead}<tbody><tr class="even"><td>1</td><td>X</td><td></td><td></td><td>50</td><td>10</td><td>1</td></tr></tbody></table>`;
    const request = makeRequestContext(
      [
        { status: 200, body: puCreateForm }, // GET form (initial)
        { status: 200, body: '' },           // POST sync_deliver_units (precondition)
        { status: 200, body: puCreateForm }, // GET form (refresh)
        { status: 302, body: '' },           // POST → redirect
        { status: 200, body: puTableHtml },  // GET payment_unit_table
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await backend.createPaymentUnit({
      organization_slug: 'march-demo',
      opportunity_id: 'dea88661-1cd6-486b-ab25-48584bf61a8e',
      name: 'X',
      amount: 500,
      max_total: 50,
      max_daily: 10,
      required_deliver_units: [3339],
    });
    // Confirm the sync POST fired before the create POST. The fixture's hx-post
    // attribute encodes opp_int_id=1237.
    const syncPost = captured.find(
      (c) => c.method === 'POST' && c.url.endsWith('/sync_deliver_units/'),
    );
    expect(syncPost).toBeDefined();
    expect(syncPost!.url).toBe('/a/march-demo/opportunity/1237/sync_deliver_units/');
    expect(syncPost!.headers!['HX-Request']).toBe('true');
    // And the form was re-fetched after sync (GETs to /payment_unit/create
    // appear at indices 0 and 2 in the captured stream).
    const formGets = captured.filter(
      (c) => c.method === 'GET' && c.url.endsWith('/payment_unit/create'),
    );
    expect(formGets).toHaveLength(2);
  });

  it('regression (0.11.12): skips sync_deliver_units precondition when no DUs requested', async () => {
    // The sync-DUs precondition only fires when required/optional_deliver_units
    // are non-empty. PUs created without DU assignment skip the precondition
    // (one less HTTP call).
    const captured: CapturedRequest[] = [];
    const puTableHtml = `<table>${puTableThead}<tbody><tr class="even"><td>1</td><td>NoDUs</td><td></td><td></td><td>1</td><td>1</td><td>0</td></tr></tbody></table>`;
    const request = makeRequestContext(
      [
        { status: 200, body: puCreateForm }, // GET form
        { status: 302, body: '' },           // POST → redirect
        { status: 200, body: puTableHtml },  // GET payment_unit_table
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await backend.createPaymentUnit({
      organization_slug: 'march-demo',
      opportunity_id: 'dea88661-1cd6-486b-ab25-48584bf61a8e',
      name: 'NoDUs',
      amount: 10,
      max_total: 1,
      max_daily: 1,
    });
    const syncPost = captured.find(
      (c) => c.method === 'POST' && c.url.endsWith('/sync_deliver_units/'),
    );
    expect(syncPost).toBeUndefined();
  });

  it('createPaymentUnits loops over the input list', async () => {
    const captured: CapturedRequest[] = [];
    const puTableHtml1 = `<table>${puTableThead}<tbody><tr class="even"><td>1</td><td>PU-1</td><td></td><td></td><td>1</td><td>1</td><td>0</td></tr></tbody></table>`;
    const puTableHtml2 = `<table>${puTableThead}<tbody><tr class="even"><td>1</td><td>PU-1</td><td></td><td></td><td>1</td><td>1</td><td>0</td></tr><tr class="odd"><td>2</td><td>PU-2</td><td></td><td></td><td>1</td><td>1</td><td>0</td></tr></tbody></table>`;
    const request = makeRequestContext(
      [
        { status: 200, body: puCreateForm },
        { status: 302, body: '' },
        { status: 200, body: puTableHtml1 },
        { status: 200, body: puCreateForm },
        { status: 302, body: '' },
        { status: 200, body: puTableHtml2 },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.createPaymentUnits({
      organization_slug: 'm',
      opportunity_id: 'dea88661-1cd6-486b-ab25-48584bf61a8e',
      payment_units: [
        { name: 'PU-1', amount: 100, max_total: 1, max_daily: 1 },
        { name: 'PU-2', amount: 200, max_total: 1, max_daily: 1 },
      ],
    });
    expect(out.payment_units).toHaveLength(2);
    expect(out.payment_units[0].name).toBe('PU-1');
    expect(out.payment_units[1].name).toBe('PU-2');
    expect(captured.filter((c) => c.method === 'POST')).toHaveLength(2);
  });
});

// ─── activateOpportunity ───────────────────────────────────────────────────

describe('PlaywrightBackend.activateOpportunity', () => {
  it('re-POSTs the edit form with active=on', async () => {
    const editFormHtml =
      csrfInput +
      '<input name="name" value="Test Opp">' +
      '<input name="short_description" value="short">' +
      '<textarea name="description">desc</textarea>' +
      '<select name="delivery_type"><option value="" selected>--</option></select>' +
      '<input name="end_date" value="2026-12-31">' +
      '<select name="currency"><option value="USD" selected>USD</option></select>' +
      '<select name="country"><option value="USA" selected>USA</option></select>';
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        // GET /opportunity/<id>/edit (postEditForm fetches first)
        { status: 200, body: editFormHtml },
        // POST /opportunity/<id>/edit (active=on)
        { status: 302, body: '' },
        // postEditForm hydrates by calling getOpportunity (edit + detail)
        { status: 200, body: editFormHtml },
        { status: 200, body: '<a href="/a/o/apps/d1/abc">app1</a><a href="/a/o/apps/d2/def">app2</a>' },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.activateOpportunity({
      organization_slug: 'ai-demo-space',
      opportunity_id: 'opp-uuid-1234',
    });
    expect(out.active).toBe(true);
    expect(out.opportunity_id).toBe('opp-uuid-1234');
    // The first POST is the edit-form submit
    const editPost = captured.find((c) => c.method === 'POST')!;
    expect(editPost.url).toContain('/opportunity/opp-uuid-1234/edit');
    const body = editPost.body as Record<string, string>;
    expect(body.active).toBe('on');
  });
});

// ─── sendLloInvite ─────────────────────────────────────────────────────────

describe('PlaywrightBackend.sendLloInvite', () => {
  it('POSTs to /program/<uuid>/invite (no trailing slash) with organization=<llo>', async () => {
    const captured: CapturedRequest[] = [];
    // Need a programs list that lets parseInvitesList find the new app.
    // The Playwright listInvites parser keys off <tr data-invite-id="...">.
    const invitesListHtml =
      programsListHtml +
      '<tr data-invite-id="11111111-2222-3333-4444-555555555555" data-org="llo-org" data-status="invited"><td data-org>llo-org</td></tr>';
    const request = makeRequestContext(
      [
        { status: 200, body: programsListHtml }, // GET /a/<org>/program/  (csrf fetch)
        { status: 302, body: '' },               // POST /a/<org>/program/<id>/invite
        { status: 200, body: invitesListHtml },  // GET /a/<org>/program/  (listInvites)
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.sendLloInvite({
      organization_slug: 'ai-demo-space',
      program_id: '3472fe95-d6d3-42c2-824a-55c5c7dff552',
      organization: 'llo-org',
    });
    expect(out.organization).toBe('llo-org');
    expect(out.status).toBe('invited');
    expect(out.program).toBe('3472fe95-d6d3-42c2-824a-55c5c7dff552');

    const post = captured.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(
      '/a/ai-demo-space/program/3472fe95-d6d3-42c2-824a-55c5c7dff552/invite',
    );
    const body = post.body as Record<string, string>;
    expect(body.organization).toBe('llo-org');
    expect(post.headers!['X-CSRFToken']).toBeDefined();
    expect(post.headers!['Referer']).toContain('/a/ai-demo-space/program/');
  });

  it('throws ConnectValidationError on errorlist response', async () => {
    const captured: CapturedRequest[] = [];
    const errHtml =
      '<form><ul class="errorlist"><li>That workspace is already invited.</li></ul></form>';
    const request = makeRequestContext(
      [
        { status: 200, body: programsListHtml },
        { status: 200, body: errHtml },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.sendLloInvite({
        organization_slug: 'ai-demo-space',
        program_id: 'p',
        organization: 'llo-org',
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });
});

// ─── acceptProgramApplication ──────────────────────────────────────────────

describe('PlaywrightBackend.acceptProgramApplication', () => {
  it('looks up the LLO org slug from the application list, then POSTs to /a/<llo>/program/.../accept/', async () => {
    const captured: CapturedRequest[] = [];
    const invitesListHtml =
      '<tr data-invite-id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" data-org="llo-org" data-status="invited"><td data-org>llo-org</td></tr>';
    const request = makeRequestContext(
      [
        // 1) listInvites → GET /a/<pm_org>/program/
        { status: 200, body: invitesListHtml },
        // 2) seed CSRF — GET /a/<llo_org>/opportunity/
        { status: 200, body: csrfInput },
        // 3) POST /a/<llo>/program/<id>/application/<app>/accept/
        { status: 302, body: '' },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.acceptProgramApplication({
      organization_slug: 'pm-org',
      program_id: 'prog-uuid',
      application_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(out.status).toBe('accepted');
    expect(out.organization).toBe('llo-org');
    const acceptPost = captured.find(
      (c) => c.method === 'POST' && c.url.includes('/accept/'),
    )!;
    expect(acceptPost.url).toBe(
      '/a/llo-org/program/prog-uuid/application/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/accept/',
    );
  });

  it('throws when the application_id is not found', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        // listInvites returns nothing matching
        { status: 200, body: '<table></table>' },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.acceptProgramApplication({
        organization_slug: 'pm-org',
        program_id: 'prog-uuid',
        application_id: 'missing-app',
      }),
    ).rejects.toThrow(/application missing-app not found/);
  });
});

// ─── sendFlwInvite ─────────────────────────────────────────────────────────

describe('PlaywrightBackend.sendFlwInvite', () => {
  it('POSTs to /opportunity/<uuid>/user_invite/ with users joined by newline', async () => {
    const captured: CapturedRequest[] = [];
    const formHtml = csrfInput + '<textarea name="users"></textarea>';
    const request = makeRequestContext(
      [
        { status: 200, body: formHtml }, // GET form
        { status: 302, body: '' },        // POST success
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.sendFlwInvite({
      organization_slug: 'ai-demo-space',
      opportunity_id: 'opp-uuid-1234',
      phone_numbers: [TEST_PHONE, TEST_PHONE_2],
    });
    expect(out.status).toBe('queued');
    expect(out.invited_count).toBe(2);
    expect(out.phone_numbers).toEqual([TEST_PHONE, TEST_PHONE_2]);
    const post = captured.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/a/ai-demo-space/opportunity/opp-uuid-1234/user_invite/');
    const body = post.body as Record<string, string>;
    expect(body.users).toBe(`${TEST_PHONE}\n${TEST_PHONE_2}`);
  });

  it('throws ConnectValidationError when opportunity is inactive', async () => {
    const captured: CapturedRequest[] = [];
    const errHtml =
      '<form><ul class="errorlist nonfield"><li>Opportunity must be active to invite users.</li></ul></form>';
    const request = makeRequestContext(
      [
        { status: 200, body: csrfInput },
        { status: 200, body: errHtml },
      ],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.sendFlwInvite({
        organization_slug: 'ai-demo-space',
        opportunity_id: 'opp-uuid',
        phone_numbers: [TEST_PHONE],
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });
});

describe('PlaywrightBackend.deleteUnacceptedFlwInvites', () => {
  it('POSTs to /opportunity/<uuid>/delete_invites/ with repeated user_invite_ids form fields', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{ status: 200, body: '', headers: { 'HX-Redirect': '/a/ai-demo-space/opportunity/opp-uuid-1234/workers/' } }],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.deleteUnacceptedFlwInvites({
      organization_slug: 'ai-demo-space',
      opportunity_id: 'opp-uuid-1234',
      user_invite_ids: [101, 102, 103],
    });
    expect(out).toEqual({ requested: 3 });
    expect(captured).toHaveLength(1);
    const post = captured[0];
    expect(post.method).toBe('POST');
    expect(post.url).toBe('/a/ai-demo-space/opportunity/opp-uuid-1234/delete_invites/');
    // Body should be URL-encoded with repeated keys (Django getlist).
    expect(post.body).toBe('user_invite_ids=101&user_invite_ids=102&user_invite_ids=103');
    expect(post.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('returns requested:0 and makes no HTTP call when invite list is empty', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext([], captured);
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.deleteUnacceptedFlwInvites({
      organization_slug: 'ai-demo-space',
      opportunity_id: 'opp-uuid-1234',
      user_invite_ids: [],
    });
    expect(out).toEqual({ requested: 0 });
    expect(captured).toHaveLength(0);
  });

  it('throws HttpError on 400 (empty list rejected by server)', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{ status: 400, body: 'Bad Request' }],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      backend.deleteUnacceptedFlwInvites({
        organization_slug: 'ai-demo-space',
        opportunity_id: 'opp-uuid-1234',
        user_invite_ids: [101],
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('accepts 302 status as success (Django redirect)', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{ status: 302, body: '' }],
      captured,
    );
    const backend = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const out = await backend.deleteUnacceptedFlwInvites({
      organization_slug: 'ai-demo-space',
      opportunity_id: 'opp-uuid-1234',
      user_invite_ids: [101],
    });
    expect(out).toEqual({ requested: 1 });
  });
});

// ─── Composite fallback wiring ─────────────────────────────────────────────

describe('CompositeBackend REST→Playwright 404 fallback', () => {
  /** Build a stub ConnectClient with one mock method that the test cares about. */
  function makeMock<K extends keyof ConnectClient>(
    method: K,
    impl: ConnectClient[K],
  ): ConnectClient {
    const c = new Proxy({} as ConnectClient, {
      get: (_t, prop) => {
        if (prop === method) return impl;
        return () => {
          throw new Error(`Unexpected call to ${String(prop)}`);
        };
      },
    });
    return c;
  }

  it('createProgram: REST 404 → Playwright fallback fires', async () => {
    let pwCalled = false;
    const rest = makeMock('createProgram', async () => {
      throw new HttpError(404, 'POST /api/programs/', '<html>404</html>', 'text/html');
    });
    const playwright = makeMock('createProgram', async () => {
      pwCalled = true;
      return {
        id: 'prog-uuid',
        name: 'Fallback',
        description: '',
        delivery_type: 0,
        budget: 0,
        currency: 'USD',
        country: 'USA',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
        organization_slug: 'pm-org',
      };
    });
    const c = new CompositeBackend({ rest, playwright });
    const out = await c.createProgram({
      organization_slug: 'pm-org',
      name: 'Fallback',
      description: '',
      delivery_type: 13,
      budget: 0,
      currency: 'USD',
      country: 'USA',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    });
    expect(pwCalled).toBe(true);
    expect(out.id).toBe('prog-uuid');
  });

  it('createProgram: REST 5xx propagates (no fallback)', async () => {
    const rest = makeMock('createProgram', async () => {
      throw new HttpError(500, 'POST /api/programs/', 'Server Error', 'text/html');
    });
    const playwright = makeMock('createProgram', async () => {
      throw new Error('should not be called on 5xx');
    });
    const c = new CompositeBackend({ rest, playwright });
    await expect(
      c.createProgram({
        organization_slug: 'p',
        name: 'X',
        description: '',
        delivery_type: 13,
        budget: 0,
        currency: 'USD',
        country: 'USA',
        start_date: '2026-05-01',
        end_date: '2026-12-31',
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('sendFlwInvite: REST 400 (validation) propagates (no fallback)', async () => {
    const rest = makeMock('sendFlwInvite', async () => {
      throw new ConnectValidationError(['Opportunity must be active.']);
    });
    const playwright = makeMock('sendFlwInvite', async () => {
      throw new Error('should not be called on validation error');
    });
    const c = new CompositeBackend({ rest, playwright });
    await expect(
      c.sendFlwInvite({
        organization_slug: 'o',
        opportunity_id: 'opp',
        phone_numbers: ['+1'],
      }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('createOpportunity: REST 404 → Playwright fallback fires (no longer throws guarded error)', async () => {
    let pwCalled = false;
    const rest = makeMock('createOpportunity', async () => {
      throw new HttpError(404, 'POST /api/programs/.../opportunities/', '<html>404</html>', 'text/html');
    });
    const playwright = makeMock('createOpportunity', async () => {
      pwCalled = true;
      return {
        id: 'opp-uuid-1234',
        program_id: 'prog-uuid',
        name: 'X',
        short_description: 'short',
        description: 'desc',
        organization_slug: 'pm-org',
        managed: true,
        active: false,
        start_date: '2026-05-01',
        end_date: '2026-12-31',
        total_budget: 100000,
      };
    });
    const c = new CompositeBackend({ rest, playwright });
    const out = await c.createOpportunity({
      organization_slug: 'pm-org',
      program_id: 'prog-uuid',
      name: 'X',
      short_description: 'short',
      description: 'desc',
      target_organization_slug: 'pm-org',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
      total_budget: 100000,
      learn_app: { hq_server_url: 'h', api_key: 'k', cc_domain: 'd', cc_app_id: 'la', description: 'L', passing_score: 80 },
      deliver_app: { hq_server_url: 'h', api_key: 'k', cc_domain: 'd', cc_app_id: 'da' },
    });
    expect(pwCalled).toBe(true);
    expect(out.id).toBe('opp-uuid-1234');
  });

  it('all eight write atoms route through tryRestThenPlaywright (REST returns first)', async () => {
    const callOrder: string[] = [];
    const r: Partial<ConnectClient> = {
      createProgram: async () => { callOrder.push('rest:createProgram'); throw new HttpError(404, '', ''); },
      createOpportunity: async () => { callOrder.push('rest:createOpportunity'); throw new HttpError(404, '', ''); },
      createPaymentUnit: async () => { callOrder.push('rest:createPaymentUnit'); throw new HttpError(404, '', ''); },
      createPaymentUnits: async () => { callOrder.push('rest:createPaymentUnits'); throw new HttpError(404, '', ''); },
      activateOpportunity: async () => { callOrder.push('rest:activateOpportunity'); throw new HttpError(404, '', ''); },
      sendLloInvite: async () => { callOrder.push('rest:sendLloInvite'); throw new HttpError(404, '', ''); },
      acceptProgramApplication: async () => { callOrder.push('rest:acceptProgramApplication'); throw new HttpError(404, '', ''); },
      sendFlwInvite: async () => { callOrder.push('rest:sendFlwInvite'); throw new HttpError(404, '', ''); },
    };
    const p: Partial<ConnectClient> = {
      createProgram: async () => { callOrder.push('pw:createProgram'); return {} as never; },
      createOpportunity: async () => { callOrder.push('pw:createOpportunity'); return {} as never; },
      createPaymentUnit: async () => { callOrder.push('pw:createPaymentUnit'); return {} as never; },
      createPaymentUnits: async () => { callOrder.push('pw:createPaymentUnits'); return {} as never; },
      activateOpportunity: async () => { callOrder.push('pw:activateOpportunity'); return {} as never; },
      sendLloInvite: async () => { callOrder.push('pw:sendLloInvite'); return {} as never; },
      acceptProgramApplication: async () => { callOrder.push('pw:acceptProgramApplication'); return {} as never; },
      sendFlwInvite: async () => { callOrder.push('pw:sendFlwInvite'); return {} as never; },
    };
    const c = new CompositeBackend({ rest: r as ConnectClient, playwright: p as ConnectClient });

    // Call each in turn (no need to assert returns — we're verifying call order)
    await c.createProgram({} as never);
    await c.createOpportunity({} as never);
    await c.createPaymentUnit({} as never);
    await c.createPaymentUnits({} as never);
    await c.activateOpportunity({} as never);
    await c.sendLloInvite({} as never);
    await c.acceptProgramApplication({} as never);
    await c.sendFlwInvite({} as never);

    expect(callOrder).toEqual([
      'rest:createProgram', 'pw:createProgram',
      'rest:createOpportunity', 'pw:createOpportunity',
      'rest:createPaymentUnit', 'pw:createPaymentUnit',
      'rest:createPaymentUnits', 'pw:createPaymentUnits',
      'rest:activateOpportunity', 'pw:activateOpportunity',
      'rest:sendLloInvite', 'pw:sendLloInvite',
      'rest:acceptProgramApplication', 'pw:acceptProgramApplication',
      'rest:sendFlwInvite', 'pw:sendFlwInvite',
    ]);
  });
});
