import { describe, it, expect } from 'vitest';
import { PlaywrightBackend } from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';

// ── Scripted RequestFn ──────────────────────────────────────────────────────

interface Captured {
  method: string;
  url: string;
  body?: unknown;
  options?: unknown;
}

function scriptedRequest(
  responses: Array<{ status: number; body?: string }>,
  captured: Captured[],
): RequestFn {
  let i = 0;
  return async (method, url, body, options) => {
    captured.push({ method, url, body, options });
    const next = responses[i++];
    if (!next) throw new Error(`No scripted response for ${method} #${i}: ${url}`);
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      text: async () => next.body ?? '',
    } as never;
  };
}

function makeBackend(request: RequestFn) {
  return new PlaywrightBackend({
    teamSlug: 'dimagi',
    baseUrl: 'https://www.openchatstudio.com',
    csrfToken: 'csrf-xyz',
    request,
  });
}

// ── HTML fixtures (anchored to the OCS team templates the lib parser reads) ─

const inviteForm = `
<div id="invitation-form-and-table">
  <form method="post">
    <input type="hidden" name="csrfmiddlewaretoken" value="page-csrf">
    <label><input type="checkbox" name="groups" value="7"> Chatbot Admin</label>
    <label><input type="checkbox" name="groups" value="9"> Chat Viewer</label>
  </form>
  %PENDING%
</div>`;

function teamPage(opts: { members?: string; pendingRows?: string } = {}) {
  return `
<html><body>
<h2>Team Members</h2>
<table>${opts.members ?? ''}</table>
${inviteForm.replace('%PENDING%', `<table>${opts.pendingRows ?? ''}</table>`)}
</body></html>`;
}

const memberRow = (id: string, label: string) =>
  `<tr><td><a href="/a/dimagi/team/members/${id}/">${label}</a></td></tr>`;
const pendingRow = (email: string, groups: string) =>
  `<tr><td>${email}</td><td>2026-07-20</td><td>${groups}</td>
   <td><form hx-post="/a/dimagi/team/invite/cancel/88/"><button>Cancel</button></form></td></tr>`;

const membershipPage = (checked: string[]) => `
<form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value="member-csrf">
  <label><input type="checkbox" name="groups" value="7" ${checked.includes('7') ? 'checked' : ''}> Chatbot Admin</label>
  <label><input type="checkbox" name="groups" value="9" ${checked.includes('9') ? 'checked' : ''}> Chat Viewer</label>
</form>`;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PlaywrightBackend.addTeamMember', () => {
  it('fresh invite: POSTs repeated groups keys and proves via fresh read-back', async () => {
    const captured: Captured[] = [];
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage() }, // GET team page (no member, no pending)
          { status: 200, body: '' }, // POST invite (htmx swap fragment)
          { status: 200, body: teamPage({ pendingRows: pendingRow('jo@dimagi.com', 'Chatbot Admin') }) }, // verify
        ],
        captured,
      ),
    );
    const res = await be.addTeamMember({ email: 'jo@dimagi.com' });
    expect(res.status).toBe('invited');
    const post = captured.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/a/dimagi/team/invite/');
    // Repeated groups key + default Chatbot Admin group + session csrf.
    expect(String(post?.body)).toContain('email=jo%40dimagi.com');
    expect(String(post?.body)).toContain('groups=7');
    expect(String(post?.body)).toContain('csrfmiddlewaretoken=csrf-xyz');
    expect((post?.options as { rawFormBody?: boolean }).rawFormBody).toBe(true);
  });

  it('fresh invite: throws when the read-back does not show the pending invite', async () => {
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage() },
          { status: 200, body: '' }, // POST "succeeds"
          { status: 200, body: teamPage() }, // verify: still absent
        ],
        [],
      ),
    );
    await expect(be.addTeamMember({ email: 'jo@dimagi.com' })).rejects.toThrow(/not proof|does NOT show/i);
  });

  it('accepted member with the right groups is already-member (no POST)', async () => {
    const captured: Captured[] = [];
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage({ members: memberRow('57', 'Jo &lt;jo@dimagi.com&gt;') }) },
          { status: 200, body: membershipPage(['7']) }, // member edit page: Chatbot Admin checked
        ],
        captured,
      ),
    );
    const res = await be.addTeamMember({ email: 'jo@dimagi.com' });
    expect(res.status).toBe('already-member');
    expect(captured.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('accepted member on the wrong group gets the union POSTed and verified (never strips)', async () => {
    const captured: Captured[] = [];
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage({ members: memberRow('57', 'Jo &lt;jo@dimagi.com&gt;') }) },
          { status: 200, body: membershipPage(['9']) }, // currently only Chat Viewer
          { status: 200, body: '' }, // POST groups union
          { status: 200, body: membershipPage(['7', '9']) }, // verify: both checked
        ],
        captured,
      ),
    );
    const res = await be.addTeamMember({ email: 'jo@dimagi.com' });
    expect(res.status).toBe('groups-reconciled');
    const post = captured.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/a/dimagi/team/members/57/');
    // Union: existing 9 preserved, requested 7 added.
    expect(String(post?.body)).toContain('groups=9');
    expect(String(post?.body)).toContain('groups=7');
  });

  it('pending invite with matching groups is an idempotent skip', async () => {
    const be = makeBackend(
      scriptedRequest(
        [{ status: 200, body: teamPage({ pendingRows: pendingRow('jo@dimagi.com', 'Chatbot Admin') }) }],
        [],
      ),
    );
    const res = await be.addTeamMember({ email: 'jo@dimagi.com' });
    expect(res.status).toBe('invite-pending');
  });

  it('pending invite with WRONG groups fails loud without replace_invite', async () => {
    const be = makeBackend(
      scriptedRequest(
        [{ status: 200, body: teamPage({ pendingRows: pendingRow('jo@dimagi.com', 'Chat Viewer') }) }],
        [],
      ),
    );
    await expect(be.addTeamMember({ email: 'jo@dimagi.com' })).rejects.toThrow(/replace_invite/);
  });

  it('replace_invite cancels the stale invite, verifies the cancel, then re-invites', async () => {
    const captured: Captured[] = [];
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage({ pendingRows: pendingRow('jo@dimagi.com', 'Chat Viewer') }) },
          { status: 200, body: '' }, // POST cancel
          { status: 200, body: teamPage() }, // verify cancel: gone
          { status: 200, body: '' }, // POST fresh invite
          { status: 200, body: teamPage({ pendingRows: pendingRow('jo@dimagi.com', 'Chatbot Admin') }) }, // verify
        ],
        captured,
      ),
    );
    const res = await be.addTeamMember({ email: 'jo@dimagi.com', replace_invite: true });
    expect(res.status).toBe('invited');
    const posts = captured.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posts).toEqual(['/a/dimagi/team/invite/cancel/88/', '/a/dimagi/team/invite/']);
  });

  it('throws when the team page is not reachable (not a Team Admin / expired session)', async () => {
    const be = makeBackend(scriptedRequest([{ status: 302, body: '' }], []));
    await expect(be.addTeamMember({ email: 'jo@dimagi.com' })).rejects.toThrow(/Team Admin|session/);
  });

  it('throws when a requested group is not offered on the team', async () => {
    const be = makeBackend(scriptedRequest([{ status: 200, body: teamPage() }], []));
    await expect(
      be.addTeamMember({ email: 'jo@dimagi.com', group_labels: ['Super Admin'] }),
    ).rejects.toThrow(/not offered/);
  });
});
