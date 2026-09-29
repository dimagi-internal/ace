/**
 * Unit tests for PlaywrightBackend.removeOrgMember (connect_remove_org_member),
 * the inverse of addOrgMember — used to revoke the interim shared-org grants
 * `/ace:release --allow-shared connect` records. Endpoints from commcare-connect
 * organization/views.py:
 *   remove_members  POST /a/<org>/organization/member/remove   form membership_ids=<pk>
 *   revoke_invite   POST /a/<org>/organization/invite/<pk>/revoke
 * The member pk is the member table's `row_checkbox_<pk>`; the invite pk is its
 * revoke button's URL. Fixtures are the LIVE markup captured for ace#1064 /
 * ace#2503 — not hand-tidied.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import { ConnectValidationError } from '../../../../mcp/connect/errors.js';
import { parseOrgMemberTable, parsePendingInviteTable } from '../../../../lib/connect-member-table.js';

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
const FRESH_CSRF = 'fresh-form-csrf-9999';
const homeHtml = `<form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="${FRESH_CSRF}"></form>`;
const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'connect-html');
const pendingRows = readFileSync(join(FIXTURES, 'pending_invites_table-rows.html'), 'utf8');
const pendingEmpty = readFileSync(join(FIXTURES, 'pending_invites_table-empty.html'), 'utf8');

/** Live member-table row shape (ace#1064): `<td >`, checkbox id row_checkbox_<pk>. */
const memberRow = (pk: number, email: string, role: string) => `<tr class="odd" class="group">
    <td >
      <input type="checkbox" name="row_select" value="${pk}" x-model="selected" @click.stop="" class="checkbox" id="row_checkbox_${pk}" />
    </td>
    <td >
      1
    </td>
    <td >
      ${email}
    </td>
    <td >
      <div class=' underline underline-offset-4'>${role}</div>
    </td>
  </tr>`;
const memberTable = (...rows: string[]) => `<table><tbody>${rows.join('')}</tbody></table>`;
const ok = (body: string): ScriptedResponse => ({ status: 200, body });
const ORG = 'ace-nm-org';

describe('member-table row ids', () => {
  it('reads the membership pk from the select checkbox', () => {
    expect(parseOrgMemberTable(memberTable(memberRow(812, 'anne@sparkmicrogrants.org', 'Viewer')))).toEqual([
      { email: 'anne@sparkmicrogrants.org', role: 'viewer', id: '812' },
    ]);
  });
  it('reads the invite pk from the live pending table revoke button', () => {
    const rows = parsePendingInviteTable(pendingRows);
    expect(rows.map((r) => [r.email, r.id])).toEqual([
      ['stewari@dimagi.com', '41'],
      [rows[1].email, '40'],
      [rows[2].email, '39'],
      [rows[3].email, '38'],
    ]);
  });
});

describe('PlaywrightBackend.removeOrgMember', () => {
  it('removes a membership by its pk and proves it by read-back', async () => {
    const captured: CapturedRequest[] = [];
    const member = memberTable(memberRow(812, 'anne@sparkmicrogrants.org', 'Viewer'), memberRow(3, 'ace@dimagi-ai.com', 'Admin'));
    const request = makeRequestContext(
      [ok(member), ok(pendingEmpty), ok(homeHtml), { status: 302, body: '' }, ok(memberTable(memberRow(3, 'ace@dimagi-ai.com', 'Admin'))), ok(pendingEmpty)],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken: 'c', request });
    const res = await be.removeOrgMember({ organization_slug: ORG, email: 'Anne@SparkMicrogrants.org' });
    expect(res).toEqual({ organization_slug: ORG, email: 'Anne@SparkMicrogrants.org', status: 'removed', role: 'viewer' });
    const post = captured[3];
    expect(`${post.method} ${post.url}`).toBe(`POST /a/${ORG}/organization/member/remove`);
    expect(post.body).toEqual({ csrfmiddlewaretoken: FRESH_CSRF, membership_ids: '812' });
  });

  it('revokes a pending invite (never accepted) by its invite pk', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext(
      [ok(memberTable()), ok(pendingRows), ok(homeHtml), ok(pendingEmpty), ok(memberTable()), ok(pendingEmpty)],
      captured,
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken: 'c', request });
    const res = await be.removeOrgMember({ organization_slug: ORG, email: 'stewari@dimagi.com' });
    expect(res.status).toBe('invite-revoked');
    expect(res.role).toBe('admin');
    expect(`${captured[3].method} ${captured[3].url}`).toBe(`POST /a/${ORG}/organization/invite/41/revoke`);
  });

  it('posts nothing for someone in neither table', async () => {
    const captured: CapturedRequest[] = [];
    const request = makeRequestContext([ok(memberTable()), ok(pendingEmpty)], captured);
    const be = new PlaywrightBackend({ baseUrl, csrfToken: 'c', request });
    const res = await be.removeOrgMember({ organization_slug: ORG, email: 'nobody@x.org' });
    expect(res.status).toBe('not-present');
    expect(captured.every((c) => c.method === 'GET')).toBe(true);
  });

  it('fails loud when the person is still there afterwards (e.g. removing the caller)', async () => {
    const member = memberTable(memberRow(3, 'ace@dimagi-ai.com', 'Admin'));
    const request = makeRequestContext(
      [ok(member), ok(pendingEmpty), ok(homeHtml), { status: 302, body: '' }, ok(member), ok(pendingEmpty)],
      [],
    );
    const be = new PlaywrightBackend({ baseUrl, csrfToken: 'c', request });
    await expect(be.removeOrgMember({ organization_slug: ORG, email: 'ace@dimagi-ai.com' })).rejects.toBeInstanceOf(ConnectValidationError);
  });
});
