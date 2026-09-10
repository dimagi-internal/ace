import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOcsMembersTable, ocsMembersTablePath } from '../../lib/ocs-team-members';

//
// dimagi-internal/ace#2344 — OCS moved the member list into the
// `members/table/` htmx partial; both ACE parsers kept slicing the old page and
// read a four-member team (ACE included) as "Team Members table: []", then told
// a reviewer she had no access. The fixture is the LIVE partial for that team,
// anonymised (2026-09-10): four accepted members, no pending invitations.
//

const FIXTURE = readFileSync(
  join(__dirname, '..', 'fixtures', 'ocs', 'members-table.partial.html'),
  'utf8',
);

// A pending-invitation row in the same table shape (member_row_name.html +
// member_status.html + member_row_actions.html's invitation branch).
const INVITE_ROW = `
<tr id="record-invitation-abc">
  <td><div class="flex items-center gap-2"><span class="min-w-0">
    <span class="block font-semibold truncate">newcomer@partner.example</span>
    <span class="block text-neutral-500 text-xs truncate">newcomer@partner.example</span>
  </span></div></td>
  <td><div class="flex flex-wrap gap-1">
    <span class="badge badge-ghost badge-sm whitespace-nowrap">Chatbot Admin</span>
    <span class="badge badge-ghost badge-sm whitespace-nowrap">Chat Viewer</span>
  </div></td>
  <td><div><span class="badge badge-warning badge-sm whitespace-nowrap">Invited</span>
    <span class="block text-neutral-500 text-xs mt-1">Invited 3 hours ago</span></div></td>
  <td><div class="flex gap-1 justify-end">
    <form hx-post="/a/connect-ace/team/invite/abc-123/" hx-target="this"><button>Resend</button></form>
    <form hx-post="/a/connect-ace/team/invite/cancel/abc-123/" hx-target="closest tr"><button>Cancel</button></form>
  </div></td>
</tr>`;

describe('parseOcsMembersTable', () => {
  it('reads every accepted member off the live partial, with groups and membership ids', () => {
    const rb = parseOcsMembersTable(FIXTURE, 'nobody@example.org');
    expect(rb.parsed).toBe(true);
    expect(rb.rows.map((r) => [r.email, r.kind, r.membershipId])).toEqual([
      ['agent@example.org', 'member', '1695'],
      ['owner@example.org', 'member', '1693'],
      ['reviewer@partner.example', 'member', '1737'],
      ['staff@example.org', 'member', '1754'],
    ]);
    expect(rb.isMember).toBe(false);
  });

  it('finds the reviewer that the old page-slicing parser reported absent (#2344)', () => {
    const rb = parseOcsMembersTable(FIXTURE, 'SFeintuch@partner.example'.replace('SFeintuch', 'reviewer'));
    expect(rb.isMember).toBe(true);
    expect(rb.member).toEqual({
      id: '1737',
      label: 'reviewer@partner.example <reviewer@partner.example>',
      groups: ['Chatbot Admin'],
    });
    expect(rb.pending).toBeUndefined();
  });

  it('matches the email case-insensitively', () => {
    expect(parseOcsMembersTable(FIXTURE, 'REVIEWER@PARTNER.EXAMPLE').isMember).toBe(true);
  });

  it('carries every role badge, not just the first', () => {
    const agent = parseOcsMembersTable(FIXTURE, 'agent@example.org');
    expect(agent.member?.groups).toContain('Chatbot Admin');
    expect(agent.member?.groups).toContain('Team Admin');
    expect(agent.member?.groups.length).toBeGreaterThan(5);
  });

  it('reads a pending invitation row as pending, with its groups and cancel URL', () => {
    const rb = parseOcsMembersTable(FIXTURE.replace('</tbody>', `${INVITE_ROW}</tbody>`), 'newcomer@partner.example');
    expect(rb.isMember).toBe(false);
    expect(rb.pending).toEqual({
      email: 'newcomer@partner.example',
      invited: 'Invited 3 hours ago',
      groups: ['Chatbot Admin', 'Chat Viewer'],
      cancelUrl: '/a/connect-ace/team/invite/cancel/abc-123/',
    });
    expect(rb.rows).toHaveLength(5);
  });

  it('reports an unparseable page as INCONCLUSIVE, never as "not a member"', () => {
    // The old team page: no rows at all. This is exactly the read that produced #2344.
    const rb = parseOcsMembersTable('<html><body><h2>Members &amp; access</h2></body></html>', 'reviewer@partner.example');
    expect(rb.parsed).toBe(false);
    expect(rb.rows).toEqual([]);
    expect(rb.raw.join('\n')).toContain('INCONCLUSIVE');
  });

  it('names the partial every consumer must fetch', () => {
    expect(ocsMembersTablePath('connect-ace')).toBe('/a/connect-ace/team/members/table/');
  });
});
