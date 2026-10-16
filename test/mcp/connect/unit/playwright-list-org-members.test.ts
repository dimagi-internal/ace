/**
 * Unit tests for PlaywrightBackend.listOrgMembers (connect_list_org_members),
 * the READ-ONLY member + pending-invite read (ace#2986). It is the GET/parse
 * half of addOrgMember with no POST: verifying "is X a viewer of org Y?"
 * through connect_add_org_member invites (and Connect emails) anyone absent.
 *
 * Fixtures: the member rows use the LIVE `org_member_table` markup captured
 * for ace#1064 (`<td >`, `row_checkbox_<pk>`; do not tidy), and the pending
 * table is the live capture used by the add/remove tests (ace#2503).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { CompositeBackend } from '../../../../mcp/connect/backends/composite.js';
import { HttpError } from '../../../../mcp/connect/errors.js';

interface CapturedRequest {
  method: string;
  url: string;
}
interface ScriptedResponse {
  status: number;
  body: string;
}

/**
 * Request context whose every non-GET verb records itself and throws, so a
 * POST (or PUT/PATCH/DELETE/fetch) anywhere in the read path fails the test
 * AND shows up in `captured`.
 */
function makeRequestContext(scripted: ScriptedResponse[], captured: CapturedRequest[]): APIRequestContext {
  let i = 0;
  const get = async (url: string) => {
    captured.push({ method: 'GET', url });
    const next = scripted[i++];
    if (!next) throw new Error(`No scripted response for GET #${i}: ${url}`);
    return {
      status: () => next.status,
      headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => next.body,
    } as unknown as APIResponse;
  };
  const forbidden = (method: string) => async (url: string) => {
    captured.push({ method, url });
    throw new Error(`listOrgMembers must never ${method}: ${url}`);
  };
  return {
    get,
    post: forbidden('POST'),
    put: forbidden('PUT'),
    patch: forbidden('PATCH'),
    delete: forbidden('DELETE'),
    fetch: forbidden('FETCH'),
    head: forbidden('HEAD'),
  } as unknown as APIRequestContext;
}

const baseUrl = 'https://connect.dimagi.com';
const ORG = 'ace-nm-org';
const MEMBER = `/a/${ORG}/organization/member_table?page_size=100`;
const PENDING = `/a/${ORG}/organization/pending_invites_table?page_size=100`;
const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'connect-html');
const pendingRows = readFileSync(join(FIXTURES, 'pending_invites_table-rows.html'), 'utf8');
const pendingEmpty = readFileSync(join(FIXTURES, 'pending_invites_table-empty.html'), 'utf8');

/** Live member-table row shape (ace#1064). */
const memberRow = (pk: number, email: string, role: string, even = false) => `<tr class="${even ? 'even' : 'odd'}" class="group">
    <td >
      <input type="checkbox" name="row_select" value="${pk}" x-model="selected" @click.stop="" class="checkbox" id="row_checkbox_${pk}" />
    </td>
    <td >
      ${pk}
    </td>
    <td >
      ${email}
    </td>
    <td >
      <div class=' underline underline-offset-4'>${role}</div>
    </td>
  </tr>`;
const memberTable = (...rows: string[]) => `
  <table>
    <thead><tr class="group"><th >select</th><th >#</th><th >member</th><th >Role</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>`;
const ok = (body: string): ScriptedResponse => ({ status: 200, body });

describe('PlaywrightBackend.listOrgMembers', () => {
  it('returns both tables with STORED roles, via exactly the two GETs addOrgMember pre-reads', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [
        ok(memberTable(memberRow(3, 'ace@dimagi-ai.com', 'Admin'), memberRow(812, 'sfeintuch@dimagi-associate.com', 'Viewer', true))),
        ok(pendingRows),
      ],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken: 'c', request });
    const res = await be.listOrgMembers({ organization_slug: ORG });

    expect(res.organization_slug).toBe(ORG);
    expect(res.members).toEqual([
      { email: 'ace@dimagi-ai.com', role: 'admin', id: '3' },
      { email: 'sfeintuch@dimagi-associate.com', role: 'viewer', id: '812' },
    ]);
    expect(res.pending_invites).toHaveLength(4);
    expect(res.pending_invites[0]).toMatchObject({
      email: 'stewari@dimagi.com',
      role: 'admin',
      id: '41',
      invited_on: '26-Sep-2026 13:19',
    });
    expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${MEMBER}`, `GET ${PENDING}`]);
  });

  it('makes NO non-GET request: an absent person is reported absent, never invited', async () => {
    // The ace#2986 defect shape: the person being verified is in neither
    // table. connect_add_org_member would POST here and Connect would email
    // them; this read must only report the absence.
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext([ok(memberTable(memberRow(3, 'ace@dimagi-ai.com', 'Admin'))), ok(pendingEmpty)], captured);
    const be = new PlaywrightBackend({ baseUrl, csrfToken: 'c', request });
    const res = await be.listOrgMembers({ organization_slug: ORG });

    expect(res.pending_invites).toEqual([]);
    expect(res.members.some((m) => m.email.toLowerCase() === 'ghost@dimagi.com')).toBe(false);
    expect(captured.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(captured).toHaveLength(2);
  });

  it('fails LOUD on a non-200 read instead of returning empty tables', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext([{ status: 403, body: 'Forbidden' }], captured);
    const be = new PlaywrightBackend({ baseUrl, csrfToken: 'c', request });
    await expect(be.listOrgMembers({ organization_slug: ORG })).rejects.toBeInstanceOf(HttpError);
    expect(captured.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('CompositeBackend routes listOrgMembers straight to the Playwright backend', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext([ok(memberTable(memberRow(3, 'ace@dimagi-ai.com', 'Admin'))), ok(pendingEmpty)], captured);
    const playwright = new PlaywrightBackend({ baseUrl, csrfToken: 'c', request });
    const composite = new CompositeBackend({ rest: playwright as never, playwright });
    const res = await composite.listOrgMembers({ organization_slug: ORG });
    expect(res.members).toEqual([{ email: 'ace@dimagi-ai.com', role: 'admin', id: '3' }]);
    expect(captured.map((c) => c.method)).toEqual(['GET', 'GET']);
  });
});
