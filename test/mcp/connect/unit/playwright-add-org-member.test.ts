/**
 * Unit tests for PlaywrightBackend.addOrgMember (the connect_add_org_member
 * atom). Endpoint contract probed against commcare-connect
 * organization/views.py::add_members_form + forms.py::MembershipForm:
 *   POST /a/<org>/organization/member   form: {csrfmiddlewaretoken, email, role}
 * The view ALWAYS 302-redirects (success AND validation failure), so the
 * backend verifies by reading back /organization/member_table and grepping
 * the email. These tests assert the URL/body/headers and that the read-back
 * gate distinguishes success from Connect's silent rejection.
 *
 * Mock harness mirrors playwright-fallbacks.test.ts — scripted FIFO responses
 * + a captured-request log.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { CompositeBackend } from '../../../../mcp/connect/backends/composite.js';
import { ConnectValidationError, HttpError } from '../../../../mcp/connect/errors.js';

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

function makeRequestContext(scripted: ScriptedResponse[], captured: CapturedRequest[]): APIRequestContext {
  let i = 0;
  const respond = (next: ScriptedResponse): APIResponse =>
    ({
      status: () => next.status,
      headers: () => ({ 'content-type': next.contentType ?? 'text/html; charset=utf-8', ...(next.headers ?? {}) }),
      text: async () => next.body,
    }) as unknown as APIResponse;
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
    captured.push({ method: 'POST', url, body: (init?.data as string) ?? init?.form, headers: init?.headers });
    const next = scripted[i++];
    if (!next) throw new Error(`No scripted response for POST #${i}: ${url}`);
    return respond(next);
  };
  return { get, post } as unknown as APIRequestContext;
}

const baseUrl = 'https://connect.dimagi.com';
const csrfToken = 'cookie-csrf';
const FRESH_CSRF = 'fresh-form-csrf-9999';
const homeHtml = `<form action="/a/ai-demo-space/organization/member" method="post"><input type="hidden" name="csrfmiddlewaretoken" value="${FRESH_CSRF}"></form>`;
const memberTableWith = (email: string) =>
  `<table><tbody><tr><td>1</td><td>${email}</td><td>member</td></tr></tbody></table>`;
const memberTableWithout = `<table><tbody><tr><td>1</td><td>someone-else@dimagi.com</td><td>admin</td></tr></tbody></table>`;

describe('PlaywrightBackend.addOrgMember', () => {
  it('GETs the org home for CSRF, POSTs {email,role}, verifies via member-table read-back', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: homeHtml }, // GET /a/<org>/organization/
        { status: 302, body: '' }, // POST /a/<org>/organization/member
        { status: 200, body: memberTableWith('jdoe@dimagi.com') }, // GET member_table
      ],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'jdoe@dimagi.com', role: 'admin' });

    expect(res).toEqual({
      organization_slug: 'ai-demo-space',
      email: 'jdoe@dimagi.com',
      role: 'admin',
      status: 'invited',
    });
    // GET home, POST member, GET member_table
    expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /a/ai-demo-space/organization/',
      'POST /a/ai-demo-space/organization/member',
      'GET /a/ai-demo-space/organization/member_table?page_size=100',
    ]);
    const post = captured[1];
    expect(post.body).toEqual({ csrfmiddlewaretoken: FRESH_CSRF, email: 'jdoe@dimagi.com', role: 'admin' });
    expect(post.headers?.['X-CSRFToken']).toBe(FRESH_CSRF);
  });

  it('defaults role to "member" when omitted', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: homeHtml },
        { status: 302, body: '' },
        { status: 200, body: memberTableWith('me@dimagi.com') },
      ],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'me@dimagi.com' });
    expect(res.role).toBe('member');
    expect((captured[1].body as Record<string, string>).role).toBe('member');
  });

  it('throws ConnectValidationError when the email is absent from the read-back (silent rejection)', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: homeHtml },
        { status: 302, body: '' }, // Connect 302s even on validation failure
        { status: 200, body: memberTableWithout }, // email NOT present
      ],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'ghost@dimagi.com' }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('throws HttpError on a 403 POST (ACE not an org admin)', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: homeHtml },
        { status: 403, body: 'Forbidden' }, // @org_admin_required rejected
      ],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      be.addOrgMember({ organization_slug: 'not-my-org', email: 'jdoe@dimagi.com' }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('CompositeBackend routes addOrgMember straight to the Playwright backend', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        { status: 200, body: homeHtml },
        { status: 302, body: '' },
        { status: 200, body: memberTableWith('me@dimagi.com') },
      ],
      captured,
    );
    const playwright = new PlaywrightBackend({ baseUrl, csrfToken, request });
    // rest backend is unused for this atom; pass the playwright as both to keep the harness simple.
    const composite = new CompositeBackend({ rest: playwright as never, playwright });
    const res = await composite.addOrgMember({ organization_slug: 'ai-demo-space', email: 'me@dimagi.com' });
    expect(res.status).toBe('invited');
    expect(captured[0].url).toBe('/a/ai-demo-space/organization/');
  });
});
