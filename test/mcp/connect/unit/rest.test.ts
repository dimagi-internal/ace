/**
 * Unit tests for the Connect REST backend (commcare-connect PR #1135 atoms).
 *
 * The backend is JSON-only — the request goes through Playwright's
 * `APIRequestContext` purely to share the authenticated session cookie jar.
 * We mock the request context with a fake that records calls and returns
 * canned JSON responses.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { RestBackend } from '../../../../mcp/connect/backends/rest.js';
import { ConnectValidationError, HttpError } from '../../../../mcp/connect/errors.js';
import { TEST_PHONE, TEST_PHONE_2 } from '../../../fixtures/test-phone.js';

interface CapturedRequest {
  url: string;
  data: unknown;
  headers: Record<string, string>;
}

function makeRequestContext(
  scripted: Array<{ status: number; body: unknown; contentType?: string }>,
  captured: CapturedRequest[],
): APIRequestContext {
  let i = 0;
  const post = async (url: string, init: { data: unknown; headers: Record<string, string> }) => {
    captured.push({ url, data: init.data, headers: init.headers });
    const next = scripted[i++];
    if (!next) throw new Error(`No scripted response for POST #${i}: ${url}`);
    const status = next.status;
    const ct = next.contentType ?? 'application/json';
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return {
      status: () => status,
      headers: () => ({ 'content-type': ct }),
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as APIResponse;
  };
  return { post } as unknown as APIRequestContext;
}

const baseUrl = 'https://connect.dimagi.com';
const csrfToken = 'csrf-abc';

describe('RestBackend.createProgram', () => {
  it('POSTs JSON to /api/programs/ with CSRF + Referer', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 201,
        body: {
          program_id: 'prog-uuid',
          name: 'Test',
          slug: 'test',
          description: 'A program',
          organization: 'pm-org',
          delivery_type: 'nutrition',
          budget: 500000,
          currency: 'USD',
          country: 'United States of America',
          start_date: '2026-05-01',
          end_date: '2026-12-31',
        },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.createProgram({
      organization_slug: 'pm-org',
      name: 'Test',
      description: 'A program',
      delivery_type: 'nutrition',
      budget: 500000,
      currency: 'USD',
      country: 'United States of America',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    });
    expect(out.id).toBe('prog-uuid');
    expect(out.organization_slug).toBe('pm-org');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('/api/programs/');
    expect(captured[0].headers['X-CSRFToken']).toBe(csrfToken);
    expect(captured[0].headers.Referer).toContain('connect.dimagi.com');
    expect(captured[0].headers['Content-Type']).toBe('application/json');
    expect(captured[0].data).toEqual({
      organization: 'pm-org',
      name: 'Test',
      description: 'A program',
      delivery_type: 'nutrition',
      budget: 500000,
      currency: 'USD',
      country: 'United States of America',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    });
  });

  it('throws ConnectValidationError on 400 with field-keyed body', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 400,
        body: { end_date: ['End date must be after start date.'] },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    await expect(backend.createProgram({
      organization_slug: 'pm-org',
      name: 'Test',
      description: 'A program',
      delivery_type: 'nutrition',
      budget: 500000,
      currency: 'USD',
      country: 'United States of America',
      start_date: '2026-12-31',
      end_date: '2026-05-01',
    })).rejects.toMatchObject({
      validationErrors: ['end_date: End date must be after start date.'],
      fieldErrors: { end_date: ['End date must be after start date.'] },
    });
  });

  it('JSON-stringifies nested-object values in 400 error body (not "[object Object]")', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 400,
        body: {
          payment_units: [
            { amount: ['This field is required.'] },
            { name: ['Must be unique.'] },
          ],
        },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    await expect(backend.createProgram({
      organization_slug: 'pm-org',
      name: 'Test',
      description: 'A program',
      delivery_type: 'nutrition',
      budget: 500000,
      currency: 'USD',
      country: 'United States of America',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    })).rejects.toMatchObject({
      fieldErrors: {
        payment_units: [
          '{"amount":["This field is required."]}',
          '{"name":["Must be unique."]}',
        ],
      },
    });
  });

  it('throws HttpError on 5xx', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{ status: 500, body: '<html>boom</html>', contentType: 'text/html' }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    await expect(backend.createProgram({
      organization_slug: 'pm-org',
      name: 'Test',
      description: 'A program',
      delivery_type: 'nutrition',
      budget: 500000,
      currency: 'USD',
      country: 'United States of America',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('RestBackend.createOpportunity', () => {
  it('POSTs to /api/programs/<id>/opportunities/ with structured app payloads', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 201,
        body: {
          id: 1,
          opportunity_id: 'opp-uuid',
          name: 'E2E Opp',
          description: 'desc',
          short_description: 'short',
          organization: 'llo-org',
          managed: true,
          program_id: 'prog-uuid',
          start_date: '2026-05-01',
          end_date: '2026-12-31',
          total_budget: 100000,
          is_test: true,
          learn_app: { cc_domain: 'd', cc_app_id: 'la', name: 'Learn App', learn_modules: [{ id: 1, slug: 'mod-1', name: 'M1', description: '', time_estimate: 10 }] },
          deliver_app: { cc_domain: 'd', cc_app_id: 'da', name: 'Deliver App', deliver_units: [{ id: 5, slug: 'du-1', name: 'DU 1' }] },
          currency: 'USD',
          country: 'United States of America',
          active: false,
        },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.createOpportunity({
      organization_slug: 'pm-org',
      program_id: 'prog-uuid',
      name: 'E2E Opp',
      short_description: 'short',
      description: 'desc',
      target_organization_slug: 'llo-org',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
      total_budget: 100000,
      auto_activate: false, // skip the activate POST so this test stays focused on the create payload shape
      learn_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'k', cc_domain: 'd', cc_app_id: 'la', description: 'Learn', passing_score: 80 },
      deliver_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'k', cc_domain: 'd', cc_app_id: 'da' },
    });
    expect(out.id).toBe('opp-uuid');
    expect(out.managed).toBe(true);
    expect(out.deliver_app?.deliver_units).toEqual([{ id: 5, slug: 'du-1', name: 'DU 1' }]);
    expect(captured[0].url).toBe('/api/programs/prog-uuid/opportunities/');
    const body = captured[0].data as Record<string, unknown>;
    expect(body.organization).toBe('llo-org');
    expect(body.total_budget).toBe(100000);
    expect((body.learn_app as Record<string, unknown>).cc_app_id).toBe('la');
  });

  it('activates only when auto_activate:true is passed (POSTs to /activate/ after create)', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        {
          status: 201,
          body: {
            id: 1, opportunity_id: 'opp-uuid', name: 'Auto Opp', description: 'd',
            short_description: 's', organization: 'llo-org', managed: true,
            program_id: 'prog-uuid', start_date: '2026-05-01', end_date: '2026-12-31',
            total_budget: 100000, is_test: true,
            learn_app: { cc_domain: 'd', cc_app_id: 'la', name: 'L', learn_modules: [] },
            deliver_app: { cc_domain: 'd', cc_app_id: 'da', name: 'D', deliver_units: [] },
            currency: 'USD', country: 'United States of America',
            // Create-response active is `false` — exactly the surface the
            // auto-activate behavior is meant to fix.
            active: false,
          },
        },
        {
          status: 200,
          body: { id: 1, opportunity_id: 'opp-uuid', name: 'Auto Opp', active: true },
        },
      ],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.createOpportunity({
      organization_slug: 'pm-org',
      program_id: 'prog-uuid',
      name: 'Auto Opp',
      short_description: 'short',
      description: 'desc',
      target_organization_slug: 'llo-org',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
      total_budget: 100000,
      learn_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'k', cc_domain: 'd', cc_app_id: 'la', description: 'L', passing_score: 80 },
      deliver_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'k', cc_domain: 'd', cc_app_id: 'da' },
      auto_activate: true, // explicit opt-in — default flipped to false in #584
    });
    expect(captured.length).toBe(2);
    expect(captured[0].url).toBe('/api/programs/prog-uuid/opportunities/');
    expect(captured[1].url).toBe('/api/opportunities/opp-uuid/activate/');
    // Returned opp reflects the truly-active state, not the create response's `active: false`.
    expect(out.active).toBe(true);
  });

  it('does NOT activate when auto_activate is omitted (default-false contract, #584)', async () => {
    // Regression guard for jjackson/ace#584. The activate POST must NOT
    // fire unless the caller explicitly opts in — activation requires a
    // PaymentUnit that does not exist at create time, and a premature
    // activate rolls back the whole create. With auto_activate omitted,
    // createOpportunity returns the draft opp and issues exactly ONE
    // request (the create); the skill activates later via
    // connect_activate_opportunity after the payment unit exists.
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 201,
        body: {
          id: 1, opportunity_id: 'opp-uuid', name: 'Draft Opp', description: 'd',
          short_description: 's', organization: 'llo-org', managed: true,
          program_id: 'prog-uuid', start_date: '2026-05-01', end_date: '2026-12-31',
          total_budget: 100000, is_test: true,
          learn_app: { cc_domain: 'd', cc_app_id: 'la', name: 'L', learn_modules: [] },
          deliver_app: { cc_domain: 'd', cc_app_id: 'da', name: 'D', deliver_units: [] },
          currency: 'USD', country: 'United States of America',
          active: false,
        },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.createOpportunity({
      organization_slug: 'pm-org',
      program_id: 'prog-uuid',
      name: 'Draft Opp',
      short_description: 'short',
      description: 'desc',
      target_organization_slug: 'llo-org',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
      total_budget: 100000,
      learn_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'k', cc_domain: 'd', cc_app_id: 'la', description: 'L', passing_score: 80 },
      deliver_app: { hq_server_url: 'https://www.commcarehq.org', api_key: 'k', cc_domain: 'd', cc_app_id: 'da' },
      // auto_activate omitted — must NOT activate
    });
    expect(captured.length).toBe(1);
    expect(captured[0].url).toBe('/api/programs/prog-uuid/opportunities/');
    // No activate POST fired, so the returned opp keeps the create-response state.
    expect(out.active).toBe(false);
  });
});

describe('RestBackend.createPaymentUnits', () => {
  it('POSTs an atomic batch and returns the created PaymentUnits', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 201,
        body: {
          payment_units: [{
            id: 1,
            payment_unit_id: 1,
            name: 'Visit',
            description: 'A visit',
            amount: 500,
            org_amount: 100,
            max_total: 50,
            max_daily: 10,
            required_deliver_units: [5],
            optional_deliver_units: [],
            start_date: null,
            end_date: null,
          }],
        },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.createPaymentUnits({
      organization_slug: 'pm-org',
      opportunity_id: 'opp-uuid',
      payment_units: [{
        name: 'Visit',
        description: 'A visit',
        amount: 500,
        org_amount: 100,
        max_total: 50,
        max_daily: 10,
        required_deliver_units: [5],
      }],
    });
    expect(out.payment_units).toHaveLength(1);
    expect(out.payment_units[0].id).toBe(1);
    expect(out.payment_units[0].start_date).toBeUndefined();
    expect(captured[0].url).toBe('/api/opportunities/opp-uuid/payment_units/');
  });

  it('createPaymentUnit (singular) wraps in a 1-item list', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 201,
        body: {
          payment_units: [{
            id: 7, name: 'X', description: '', amount: 100, org_amount: 10,
            max_total: 1, max_daily: 1, required_deliver_units: [], optional_deliver_units: [],
            start_date: null, end_date: null,
          }],
        },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.createPaymentUnit({
      organization_slug: 'pm-org',
      opportunity_id: 'opp-uuid',
      name: 'X',
      amount: 100,
      org_amount: 10,
      max_total: 1,
      max_daily: 1,
    });
    expect(out.id).toBe(7);
    const body = captured[0].data as { payment_units: unknown[] };
    expect(body.payment_units).toHaveLength(1);
  });
});

describe('RestBackend.activateOpportunity', () => {
  it('POSTs to /activate/ with empty body and returns active=true', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 200,
        body: { id: 1, opportunity_id: 'opp-uuid', name: 'E2E', active: true },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.activateOpportunity({ organization_slug: 'pm-org', opportunity_id: 'opp-uuid' });
    expect(out.active).toBe(true);
    expect(captured[0].url).toBe('/api/opportunities/opp-uuid/activate/');
    expect(captured[0].data).toEqual({});
  });

  it('surfaces server-side guard rejections (no payment units, already active, ended)', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 400,
        body: { non_field_errors: ['At least one payment unit must exist before activating.'] },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    await expect(backend.activateOpportunity({ organization_slug: 'pm-org', opportunity_id: 'opp-uuid' }))
      .rejects.toMatchObject({
        validationErrors: ['At least one payment unit must exist before activating.'],
      });
  });
});

describe('RestBackend program applications', () => {
  it('sendLloInvite POSTs to /applications/', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 201,
        body: {
          program_application_id: 'app-uuid',
          program: 'prog-uuid',
          organization: 'llo-org',
          status: 'invited',
        },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.sendLloInvite({
      organization_slug: 'pm-org',
      program_id: 'prog-uuid',
      organization: 'llo-org',
    });
    expect(out.program_application_id).toBe('app-uuid');
    expect(out.status).toBe('invited');
    expect(captured[0].url).toBe('/api/programs/prog-uuid/applications/');
    expect(captured[0].data).toEqual({ organization: 'llo-org' });
  });

  it('acceptProgramApplication POSTs to /accept/', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{
        status: 200,
        body: {
          program_application_id: 'app-uuid',
          program: 'prog-uuid',
          organization: 'llo-org',
          status: 'accepted',
        },
      }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.acceptProgramApplication({
      organization_slug: 'pm-org',
      program_id: 'prog-uuid',
      application_id: 'app-uuid',
    });
    expect(out.status).toBe('accepted');
    expect(captured[0].url).toBe('/api/programs/prog-uuid/applications/app-uuid/accept/');
  });
});

describe('RestBackend.sendFlwInvite', () => {
  it('POSTs phone array to /invite_users/ and returns invited_count', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{ status: 202, body: { invited_count: 2, message: 'queued' } }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    const out = await backend.sendFlwInvite({
      organization_slug: 'pm-org',
      opportunity_id: 'opp-uuid',
      phone_numbers: [TEST_PHONE, TEST_PHONE_2],
    });
    expect(out.invited_count).toBe(2);
    expect(out.status).toBe('queued');
    expect(captured[0].url).toBe('/api/opportunities/opp-uuid/invite_users/');
    expect(captured[0].data).toEqual({ phone_numbers: [TEST_PHONE, TEST_PHONE_2] });
  });

  it('rejects when opportunity is inactive', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [{ status: 400, body: { non_field_errors: ['Opportunity must be active to invite users.'] } }],
      captured,
    );
    const backend = new RestBackend({ baseUrl, csrfToken, request });
    await expect(backend.sendFlwInvite({
      organization_slug: 'pm-org',
      opportunity_id: 'opp-uuid',
      phone_numbers: [TEST_PHONE],
    })).rejects.toBeInstanceOf(ConnectValidationError);
  });
});

describe('RestBackend stubs', () => {
  it('listPrograms throws NotImplementedError (composite must route to PLAYWRIGHT)', () => {
    const backend = new RestBackend({ baseUrl, csrfToken, request: {} as APIRequestContext });
    expect(() => backend.listPrograms({ organization_slug: 'x' })).toThrow(/not implemented/);
  });
});
