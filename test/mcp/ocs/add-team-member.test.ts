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
//
// Since 2026-09-10 (ace#2344) membership is read off the htmx PARTIAL
// `/a/<team>/team/members/table/`; the team page carries only the invite form.
// Every flow therefore reads: GET page → GET partial → …, and every fresh
// read-back is GET page → GET partial again.

const teamPage = () => `
<html><body>
<div id="members-section">
  <form hx-post="/a/dimagi/team/invite/">
    <input type="hidden" name="csrfmiddlewaretoken" value="page-csrf">
    <label><input type="checkbox" name="groups" value="7"> Chatbot Admin</label>
    <label><input type="checkbox" name="groups" value="9"> Chat Viewer</label>
  </form>
  <div hx-get="/a/dimagi/team/members/table/" hx-trigger="load"></div>
</div>
</body></html>`;

const badge = (label: string) => `<span class="badge badge-ghost badge-sm">${label}</span>`;

const memberRow = (id: string, name: string, email: string, groups: string[]) => `
<tr id="record-member-${id}">
  <td><div><span class="min-w-0"><span class="block font-semibold truncate">${name}</span>
    <span class="block text-neutral-500 text-xs truncate">${email}</span></span></div></td>
  <td><div>${groups.map(badge).join('')}</div></td>
  <td><div><span class="badge badge-success badge-sm">Active</span></div></td>
  <td><div><a class="btn" href="/a/dimagi/team/members/${id}/">edit</a>
    <form method="post" action="/a/dimagi/team/members/${id}/remove/"><button>x</button></form></div></td>
</tr>`;

const pendingRow = (email: string, groups: string[]) => `
<tr id="record-invitation-88">
  <td><div><span class="min-w-0"><span class="block font-semibold truncate">${email}</span>
    <span class="block text-neutral-500 text-xs truncate">${email}</span></span></div></td>
  <td><div>${groups.map(badge).join('')}</div></td>
  <td><div><span class="badge badge-warning badge-sm">Invited</span>
    <span class="block text-neutral-500 text-xs mt-1">Invited 2 hours ago</span></div></td>
  <td><div><form hx-post="/a/dimagi/team/invite/88/"><button>Resend</button></form>
    <form hx-post="/a/dimagi/team/invite/cancel/88/"><button>Cancel</button></form></div></td>
</tr>`;

/** ACE is a member of every team it can open, so a truthful partial always has its row. */
const agentRow = memberRow('41', 'ACE Agent', 'ace@dimagi-ai.com', ['Chatbot Admin', 'Team Admin']);

const membersTable = (...rows: string[]) => `
<p class="text-neutral-500 text-sm mb-2">${rows.length + 1} of ${rows.length + 1}</p>
<table><thead><tr><th>Member</th><th>Roles</th><th>Status</th><th></th></tr></thead>
<tbody>${agentRow}${rows.join('')}</tbody></table>`;

const membershipPage = (checked: string[]) => `
<form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value="member-csrf">
  <label><input type="checkbox" name="groups" value="7" ${checked.includes('7') ? 'checked' : ''}> Chatbot Admin</label>
  <label><input type="checkbox" name="groups" value="9" ${checked.includes('9') ? 'checked' : ''}> Chat Viewer</label>
</form>`;

const JO_MEMBER = memberRow('57', 'Jo Reviewer', 'jo@dimagi.com', ['Chatbot Admin']);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PlaywrightBackend.addTeamMember', () => {
  it('reads membership off the members-table PARTIAL, not the team page', async () => {
    const captured: Captured[] = [];
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable(JO_MEMBER) },
          { status: 200, body: membershipPage(['7']) },
        ],
        captured,
      ),
    );
    await be.addTeamMember({ email: 'jo@dimagi.com' });
    expect(captured.slice(0, 2).map((c) => c.url)).toEqual(['/a/dimagi/team/', '/a/dimagi/team/members/table/']);
    expect((captured[1].options as { extraHeaders?: Record<string, string> }).extraHeaders?.['HX-Request']).toBe('true');
  });

  it('fresh invite: POSTs repeated groups keys and proves via fresh read-back', async () => {
    const captured: Captured[] = [];
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage() }, // GET team page (invite form)
          { status: 200, body: membersTable() }, // GET partial: agent only — jo absent
          { status: 200, body: '' }, // POST invite (htmx swap fragment)
          { status: 200, body: teamPage() }, // fresh GET page
          { status: 200, body: membersTable(pendingRow('jo@dimagi.com', ['Chatbot Admin'])) }, // fresh partial
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
          { status: 200, body: membersTable() },
          { status: 200, body: '' }, // POST "succeeds"
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable() }, // verify: still absent
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
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable(JO_MEMBER) },
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
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable(memberRow('57', 'Jo Reviewer', 'jo@dimagi.com', ['Chat Viewer'])) },
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
        [
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable(pendingRow('jo@dimagi.com', ['Chatbot Admin'])) },
        ],
        [],
      ),
    );
    const res = await be.addTeamMember({ email: 'jo@dimagi.com' });
    expect(res.status).toBe('invite-pending');
  });

  it('pending invite with WRONG groups fails loud without replace_invite', async () => {
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable(pendingRow('jo@dimagi.com', ['Chat Viewer'])) },
        ],
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
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable(pendingRow('jo@dimagi.com', ['Chat Viewer'])) },
          { status: 200, body: '' }, // POST cancel
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable() }, // verify cancel: gone
          { status: 200, body: '' }, // POST fresh invite
          { status: 200, body: teamPage() },
          { status: 200, body: membersTable(pendingRow('jo@dimagi.com', ['Chatbot Admin'])) }, // verify
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
    const be = makeBackend(
      scriptedRequest([{ status: 200, body: teamPage() }, { status: 200, body: membersTable() }], []),
    );
    await expect(
      be.addTeamMember({ email: 'jo@dimagi.com', group_labels: ['Super Admin'] }),
    ).rejects.toThrow(/not offered/);
  });

  // ace#2344 — the regression this file exists to pin: a read that yields NO rows
  // must never be treated as "not a member" and must never lead to an invite.
  it('refuses to act on an empty members read — inconclusive, not absent (ace#2344)', async () => {
    const captured: Captured[] = [];
    const be = makeBackend(
      scriptedRequest(
        [
          { status: 200, body: teamPage() },
          { status: 200, body: '<html><body><h2>Members &amp; access</h2></body></html>' }, // the OLD page shape
        ],
        captured,
      ),
    );
    await expect(be.addTeamMember({ email: 'jo@dimagi.com' })).rejects.toThrow(/wrong read|ace#2344/);
    expect(captured.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
