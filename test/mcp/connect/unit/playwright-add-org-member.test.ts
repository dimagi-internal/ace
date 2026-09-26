/**
 * Unit tests for PlaywrightBackend.addOrgMember (the connect_add_org_member
 * atom). Endpoint contract probed against commcare-connect
 * organization/views.py::add_members_form + forms.py::OrganizationInviteForm:
 *   POST /a/<org>/organization/member   form: {csrfmiddlewaretoken, email, role}
 * The view ALWAYS 302-redirects (success AND validation failure), so the
 * backend verifies by read-back.
 *
 * Since ace#2503 a successful add is a PENDING INVITE
 * (`OrganizationInvite.send_invite`), which renders in
 * /organization/pending_invites_table — NOT in /organization/member_table until
 * the invitee accepts. So the backend reads BOTH tables before (ace#911: tell
 * "added" from "already there") and after (tell "invited" from "rejected").
 * Every scripted FIFO below is:
 *   GET member_table (pre) → GET pending_invites_table (pre) → GET home →
 *   POST member → GET member_table (post) → GET pending_invites_table (post)
 *
 * Mock harness mirrors playwright-fallbacks.test.ts — scripted FIFO responses
 * + a captured-request log.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const memberTableWith = (email: string, role = 'member') =>
  `<table><tbody><tr><td>1</td><td>${email}</td><td>${role}</td></tr></tbody></table>`;
const memberTableWithout = `<table><tbody><tr><td>1</td><td>someone-else@dimagi.com</td><td>admin</td></tr></tbody></table>`;

const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'connect-html');
/** Pending table with stewari@ (Admin, 26-Sep-2026 13:19), smazumdar@, aking@ (Viewer), mtheis@ (Member). */
const pendingRows = readFileSync(join(FIXTURES, 'pending_invites_table-rows.html'), 'utf8');
/** "No pending invites." — and a messages block naming ghost@ outside the table. */
const pendingEmpty = readFileSync(join(FIXTURES, 'pending_invites_table-empty.html'), 'utf8');

const ok = (body: string): ScriptedResponse => ({ status: 200, body });
const MEMBER = '/a/ai-demo-space/organization/member_table?page_size=100';
const PENDING = '/a/ai-demo-space/organization/pending_invites_table?page_size=100';

describe('PlaywrightBackend.addOrgMember', () => {
  it('ace#2503: reports invited-pending (role read back from the pending row) — the live ace-nm-org case', async () => {
    // Exactly the defect: absent from member_table before AND after, but a
    // pending invite exists after the POST. The old code threw "no Connect
    // account exists" here while Connect had created the invite and emailed it.
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        ok(memberTableWithout), // member pre
        ok(pendingEmpty), // pending pre
        ok(homeHtml),
        { status: 302, body: '' },
        ok(memberTableWithout), // member post — still absent (invite not accepted)
        ok(pendingRows), // pending post — stewari@ is there as Admin
      ],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'stewari@dimagi.com', role: 'admin' });

    expect(res).toEqual({
      organization_slug: 'ai-demo-space',
      email: 'stewari@dimagi.com',
      role: 'admin',
      requested_role: 'admin',
      status: 'invited-pending',
      invited_on: '26-Sep-2026 13:19',
      expires_on: '03-Oct-2026 13:19',
    });
    expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${MEMBER}`,
      `GET ${PENDING}`,
      'GET /a/ai-demo-space/organization/',
      'POST /a/ai-demo-space/organization/member',
      `GET ${MEMBER}`,
      `GET ${PENDING}`,
    ]);
    const post = captured[3];
    expect(post.body).toEqual({ csrfmiddlewaretoken: FRESH_CSRF, email: 'stewari@dimagi.com', role: 'admin' });
    expect(post.headers?.['X-CSRFToken']).toBe(FRESH_CSRF);
  });

  it('reports the STORED pending role, not the requested one', async () => {
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingEmpty), ok(homeHtml), { status: 302, body: '' }, ok(memberTableWithout), ok(pendingRows)],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'aking@dimagi.com', role: 'admin' });
    expect(res.status).toBe('invited-pending');
    expect(res.role).toBe('viewer');
    expect(res.requested_role).toBe('admin');
  });

  it('matches the pending email case-insensitively', async () => {
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingEmpty), ok(homeHtml), { status: 302, body: '' }, ok(memberTableWithout), ok(pendingRows)],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'MTheis@Dimagi.com', role: 'member' });
    expect(res.status).toBe('invited-pending');
  });

  it('defaults role to "member" when omitted', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingEmpty), ok(homeHtml), { status: 302, body: '' }, ok(memberTableWithout), ok(pendingRows)],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'mtheis@dimagi.com' });
    expect(res.role).toBe('member');
    expect((captured[3].body as Record<string, string>).role).toBe('member');
  });

  it('reports already-invited when the pending table held the email BEFORE the POST', async () => {
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingRows), ok(homeHtml), { status: 302, body: '' }, ok(memberTableWithout), ok(pendingRows)],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'smazumdar@dimagi.com', role: 'admin' });
    expect(res.status).toBe('already-invited');
    expect(res.role).toBe('admin');
    expect(res.role_unchanged).toBeUndefined();
  });

  it('already-invited flags a requested role that did not land (reinvite cooldown no-op)', async () => {
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingRows), ok(homeHtml), { status: 302, body: '' }, ok(memberTableWithout), ok(pendingRows)],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'aking@dimagi.com', role: 'admin' });
    expect(res.status).toBe('already-invited');
    expect(res.role).toBe('viewer');
    expect(res.role_unchanged?.requested).toBe('admin');
    expect(res.role_unchanged?.actual).toBe('viewer');
  });

  it('reports invited when the member table gains the email (membership created directly)', async () => {
    const request = makeRequestContext(
      [
        ok(memberTableWithout),
        ok(pendingEmpty),
        ok(homeHtml),
        { status: 302, body: '' },
        ok(memberTableWith('jdoe@dimagi.com', 'admin')),
        ok(pendingEmpty),
      ],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'jdoe@dimagi.com', role: 'admin' });
    expect(res).toEqual({
      organization_slug: 'ai-demo-space',
      email: 'jdoe@dimagi.com',
      role: 'admin',
      requested_role: 'admin',
      status: 'invited',
    });
  });

  it('reports already-member (role untouched) when the member pre-read finds the email', async () => {
    // ace#911: OrganizationInviteForm.clean_email rejects existing members, so
    // the POST is a silent no-op 302.
    const request = makeRequestContext(
      [
        ok(memberTableWith('me@dimagi.com', 'member')),
        ok(pendingEmpty),
        ok(homeHtml),
        { status: 302, body: '' },
        ok(memberTableWith('me@dimagi.com', 'member')),
        ok(pendingEmpty),
      ],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const res = await be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'me@dimagi.com', role: 'admin' });
    expect(res.status).toBe('already-member');
    expect(res.role).toBe('member'); // the STORED role, not the requested one
    expect(res.requested_role).toBe('admin');
    expect(res.role_unchanged?.requested).toBe('admin');
    expect(res.role_unchanged?.actual).toBe('member');
  });

  it('NEGATIVE CONTROL: throws ConnectValidationError when the email is in NEITHER table after the POST', async () => {
    // The empty pending fixture names ghost@ in its messages block, outside
    // any row — that must not count as an invite.
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingEmpty), ok(homeHtml), { status: 302, body: '' }, ok(memberTableWithout), ok(pendingEmpty)],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    const err = await be
      .addOrgMember({ organization_slug: 'ai-demo-space', email: 'ghost@dimagi.com' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectValidationError);
    expect(String((err as Error).message)).toMatch(/neither a membership nor a pending invite/);
  });

  it('NEGATIVE CONTROL: other people\'s pending invites do not satisfy the read-back', async () => {
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingRows), ok(homeHtml), { status: 302, body: '' }, ok(memberTableWithout), ok(pendingRows)],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'ghost@dimagi.com' }),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('throws HttpError when the pending table read fails (fail loud, never read as absence)', async () => {
    const request = makeRequestContext([ok(memberTableWithout), { status: 500, body: 'boom' }], []);
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      be.addOrgMember({ organization_slug: 'ai-demo-space', email: 'jdoe@dimagi.com' }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('throws HttpError on a 403 POST (ACE not an org admin)', async () => {
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingEmpty), ok(homeHtml), { status: 403, body: 'Forbidden' }],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken, request });
    await expect(
      be.addOrgMember({ organization_slug: 'not-my-org', email: 'jdoe@dimagi.com' }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('CompositeBackend routes addOrgMember straight to the Playwright backend', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [ok(memberTableWithout), ok(pendingEmpty), ok(homeHtml), { status: 302, body: '' }, ok(memberTableWithout), ok(pendingRows)],
      captured,
    );
    const playwright = new PlaywrightBackend({ baseUrl, csrfToken, request });
    // rest backend is unused for this atom; pass the playwright as both to keep the harness simple.
    const composite = new CompositeBackend({ rest: playwright as never, playwright });
    const res = await composite.addOrgMember({ organization_slug: 'ai-demo-space', email: 'mtheis@dimagi.com' });
    expect(res.status).toBe('invited-pending');
    expect(captured[0].url).toBe(MEMBER);
    expect(captured[1].url).toBe(PENDING);
    expect(captured[2].url).toBe('/a/ai-demo-space/organization/');
  });
});
