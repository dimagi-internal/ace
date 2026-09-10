import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  csrfFromHtml,
  checkboxOptions,
  checkedCheckboxValues,
  sectionById,
  sameGroups,
  parseOcsTeamPage,
} from '../../lib/ocs-team-page.js';

const TEAM_PAGE = `
<html><body>
<h2>Team Members</h2>
<table>
  <tr><td><a href="/a/dimagi/team/members/41/">ACE Agent &lt;ace@dimagi-ai.com&gt;</a></td></tr>
  <tr><td><a href="/a/dimagi/team/members/57/">Jo Reviewer &lt;jo@dimagi.com&gt;</a></td></tr>
</table>
<div id="invitation-form-and-table">
  <form method="post">
    <input type="hidden" name="csrfmiddlewaretoken" value="tok-123">
    <label><input type="checkbox" name="groups" value="7"> Chatbot Admin</label>
    <label><input type="checkbox" name="groups" value="9"> Chat Viewer</label>
  </form>
  <table>
    <tr><td>pending@dimagi.com</td><td>2026-07-20</td><td>Chat Viewer</td>
      <td><form hx-post="/a/dimagi/team/invite/cancel/88/"><button>Cancel</button></form></td></tr>
  </table>
</div>
</body></html>`;

const MEMBERS_TABLE = readFileSync(
  join(__dirname, '..', 'fixtures', 'ocs', 'members-table.partial.html'),
  'utf8',
);

describe('csrfFromHtml', () => {
  it('extracts the Django csrf hidden-input value', () => {
    expect(csrfFromHtml(TEAM_PAGE)).toBe('tok-123');
  });
  it('returns undefined when absent', () => {
    expect(csrfFromHtml('<html></html>')).toBeUndefined();
  });
});

describe('checkboxOptions', () => {
  it('lists value+label pairs for the named checkbox group', () => {
    expect(checkboxOptions(TEAM_PAGE, 'groups')).toEqual([
      { value: '7', label: 'Chatbot Admin' },
      { value: '9', label: 'Chat Viewer' },
    ]);
  });
});

describe('checkedCheckboxValues', () => {
  it('returns only checked values', () => {
    const html = `
      <input type="checkbox" name="groups" value="7" checked> Chatbot Admin
      <input type="checkbox" name="groups" value="9"> Chat Viewer`;
    expect(checkedCheckboxValues(html, 'groups')).toEqual(['7']);
  });
});

describe('sectionById', () => {
  it('slices from the id marker', () => {
    expect(sectionById(TEAM_PAGE, 'invitation-form-and-table')).toContain('pending@dimagi.com');
  });
  it('returns empty string when the id is absent', () => {
    expect(sectionById(TEAM_PAGE, 'nope')).toBe('');
  });
});

describe('sameGroups', () => {
  it('is case-insensitive and order-independent', () => {
    expect(sameGroups(['Chatbot Admin', 'Chat Viewer'], ['chat viewer', 'chatbot admin'])).toBe(true);
    expect(sameGroups(['Chatbot Admin'], ['Chat Viewer'])).toBe(false);
  });
});

describe('parseOcsTeamPage', () => {
  // The member list is no longer on the team page (ace#2344): the OLD page shape
  // above must read as INCONCLUSIVE, never as "not a member".
  it('no longer reads the old page\'s member anchors — the old shape yields no member', () => {
    const rb = parseOcsTeamPage(TEAM_PAGE, 'jo@dimagi.com');
    expect(rb.isMember).toBe(false);
    expect(rb.member).toBeUndefined();
  });

  it('reports a page with no rows as unparsed, not as absence', () => {
    const oldMembersOnly = `<h2>Team Members</h2><table>
      <tr><td><a href="/a/dimagi/team/members/57/">Jo Reviewer &lt;jo@dimagi.com&gt;</a></td></tr>
    </table>`;
    const rb = parseOcsTeamPage(oldMembersOnly, 'jo@dimagi.com');
    expect(rb.parsed).toBe(false);
    expect(rb.isMember).toBe(false);
    expect(rb.raw.join('\n')).toContain('INCONCLUSIVE');
  });

  it('finds an accepted member with membership id + groups on the members-table partial', () => {
    const rb = parseOcsTeamPage(MEMBERS_TABLE, 'reviewer@partner.example');
    expect(rb.parsed).toBe(true);
    expect(rb.isMember).toBe(true);
    expect(rb.member?.id).toBe('1737');
    expect(rb.member?.groups).toEqual(['Chatbot Admin']);
    expect(rb.pending).toBeUndefined();
  });

  it('returns neither for an unknown email, with a non-empty trail', () => {
    const rb = parseOcsTeamPage(MEMBERS_TABLE, 'stranger@dimagi.com');
    expect(rb.parsed).toBe(true);
    expect(rb.isMember).toBe(false);
    expect(rb.pending).toBeUndefined();
    expect(rb.raw.length).toBeGreaterThan(0);
  });
});
