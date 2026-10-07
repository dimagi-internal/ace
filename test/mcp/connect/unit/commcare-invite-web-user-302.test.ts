/**
 * dimagi-internal/ace#2769 — `commcare_invite_web_user` threw on HQ's SUCCESS
 * 302.
 *
 * HQ answers a successful invite POST with a 302 to the domain's web-users
 * list (`/a/<domain>/settings/users/web/`). The atom ran the generic
 * `assertNotLoginRedirect`, which throws on ANY non-login 302, so the
 * "prove it rather than trusting the 302" read-back below it was unreachable.
 * Observed live 2026-10-07 on connect-ace-spark: 8 of 8 first-time invites
 * reported `returned 302 to /a/connect-ace-spark/settings/users/web/`, and an
 * identical re-call returned `invite-pending` for every one.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend } from '../../../../mcp/connect/backends/commcare.js';

const BASE = 'https://www.commcarehq.org';
const DOMAIN = 'connect-ace-spark';
const EMAIL = 'reviewer@example.org';
const USERS = `/a/${DOMAIN}/settings/users/web`;

function htmlEscapeJson(v: unknown): string {
  return JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function listPage(invitations: unknown[]): string {
  return `<div data-name="invitations" data-value="${htmlEscapeJson(invitations)}"></div>`;
}

const INVITE_FORM = `
<form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value="tok">
  <input type="email" name="email" value="">
  <select name="role">
    <option value="admin">Admin</option>
    <option value="user-role:abc">App Editor</option>
  </select>
  <button type="submit">Invite</button>
</form>`;

function resp(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status: () => status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    headers: () => headers,
  };
}

/**
 * A fake HQ whose invite POST answers with `postResponse`. The list page
 * shows a pending invitation only AFTER the POST, so the first read-back sees
 * nothing (action: invite) and the post-write read-back proves it landed.
 */
function fakeHq(postResponse: ReturnType<typeof resp>) {
  let posted = false;
  const request = {
    get: vi.fn(async (url: string) => {
      if (url.includes('/json/')) return resp(200, { users: [] });
      if (url.endsWith(`${USERS}/invite/`)) return resp(200, INVITE_FORM);
      if (url.endsWith(`${USERS}/`)) {
        return resp(200, listPage(posted ? [{ email: EMAIL, role: 'App Editor' }] : []));
      }
      throw new Error(`unexpected GET ${url}`);
    }),
    post: vi.fn(async () => {
      posted = true;
      return postResponse;
    }),
    storageState: vi.fn(async () => ({ cookies: [] })),
  };
  const invalidate = vi.fn(async () => {});
  const backend = new CommCareBackend({
    baseUrl: BASE,
    session: { getContext: async () => ({ request }), invalidate },
  } as never);
  return { backend, request, invalidate };
}

describe('commcare_invite_web_user — HQ success 302 (#2769)', () => {
  it("THE REGRESSION: a 302 to the users list is HQ's success, and the read-back decides", async () => {
    const { backend, request } = fakeHq(resp(302, '', { location: `${USERS}/` }));
    const out = await backend.inviteWebUser({ domain: DOMAIN, email: EMAIL });
    expect(out.status).toBe('invited');
    expect(out.role).toBe('App Editor');
    expect(out.detail).toMatch(/pending invitation confirmed/);
    expect(request.post).toHaveBeenCalledTimes(1);
  });

  it('an absolute Location to the users list is the same success', async () => {
    const { backend } = fakeHq(resp(302, '', { location: `${BASE}${USERS}/` }));
    const out = await backend.inviteWebUser({ domain: DOMAIN, email: EMAIL });
    expect(out.status).toBe('invited');
  });

  it('CONTROL: a 302 anywhere else still throws', async () => {
    const { backend } = fakeHq(resp(302, '', { location: `/a/${DOMAIN}/dashboard/` }));
    await expect(backend.inviteWebUser({ domain: DOMAIN, email: EMAIL })).rejects.toThrow(
      /returned 302 to \/a\/connect-ace-spark\/dashboard\//,
    );
  });

  it("CONTROL: another domain's users list is not this domain's success", async () => {
    const { backend } = fakeHq(resp(302, '', { location: '/a/other-domain/settings/users/web/' }));
    await expect(backend.inviteWebUser({ domain: DOMAIN, email: EMAIL })).rejects.toThrow(
      /returned 302/,
    );
  });

  it('CONTROL: a login redirect is still session expiry (re-login + retry), not success', async () => {
    const { backend, invalidate } = fakeHq(resp(302, '', { location: '/accounts/login/?next=/a/x/' }));
    const out = await backend.inviteWebUser({ domain: DOMAIN, email: EMAIL });
    // SessionExpiredError → invalidate + one retry; the retry's first read-back
    // sees the (fake) pending invite and reports it, never `invited`.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('invite-pending');
  });
});
