import { describe, it, expect } from 'vitest';
import { parseOrgMemberTable } from '../../lib/connect-member-table.js';

/**
 * Shape mirrors commcare-connect `organization/tables.py::OrgMemberTable`:
 *   sequence = ("select", "index", "user", "role")
 *   role rendered as <div class=' underline underline-offset-4'>{value}</div>
 */
function row(index: number, email: string, role: string): string {
  return `<tr>
    <td><input type="checkbox" name="row_select" value="${index}"></td>
    <td>${index}</td>
    <td>${email}</td>
    <td><div class=" underline underline-offset-4">${role}</div></td>
  </tr>`;
}

const TABLE = (...rows: string[]) => `
  <table>
    <thead><tr><th>select</th><th>#</th><th>member</th><th>Role</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>`;

describe('parseOrgMemberTable', () => {
  it('parses one row per membership with the STORED role', () => {
    const html = TABLE(
      row(1, 'ace@dimagi-ai.com', 'Admin'),
      row(2, 'jjackson@dimagi.com', 'Admin'),
      row(7, 'sfeintuch@dimagi-associate.com', 'Member'),
    );
    expect(parseOrgMemberTable(html)).toEqual([
      { email: 'ace@dimagi-ai.com', role: 'admin' },
      { email: 'jjackson@dimagi.com', role: 'admin' },
      { email: 'sfeintuch@dimagi-associate.com', role: 'member' },
    ]);
  });

  it('reports the role Connect STORED, not one a caller requested', () => {
    // The live regression (ace#911): role=viewer was requested; Connect's
    // clean_email rejected the form as an existing member, so the stored role
    // stayed "Member". The parser must surface member, never viewer.
    const rows = parseOrgMemberTable(TABLE(row(7, 'sfeintuch@dimagi-associate.com', 'Member')));
    expect(rows[0].role).toBe('member');
    expect(rows[0].role).not.toBe('viewer');
  });

  it('does NOT treat an email elsewhere in the page as a membership', () => {
    // This is the false-positive the old `tableHtml.includes(email)` check hit:
    // the address appears in an add-member modal / placeholder, but the person
    // is not in the table at all.
    const html = `
      <div class="modal">
        <input name="email" placeholder="Enter email address" value="newperson@dimagi.com">
        <span>Recently invited: newperson@dimagi.com</span>
      </div>
      ${TABLE(row(1, 'ace@dimagi-ai.com', 'Admin'))}`;
    const emails = parseOrgMemberTable(html).map((r) => r.email);
    expect(emails).toEqual(['ace@dimagi-ai.com']);
    expect(emails).not.toContain('newperson@dimagi.com');
  });

  it('ignores the header row and an empty-state row', () => {
    const html = `
      <table>
        <thead><tr><th>select</th><th>#</th><th>member</th><th>Role</th></tr></thead>
        <tbody><tr><td colspan="4">No members yet</td></tr></tbody>
      </table>`;
    expect(parseOrgMemberTable(html)).toEqual([]);
  });

  it('handles all three Connect roles', () => {
    const html = TABLE(
      row(1, 'a@x.com', 'Admin'),
      row(2, 'm@x.com', 'Member'),
      row(3, 'v@x.com', 'Viewer'),
    );
    expect(parseOrgMemberTable(html).map((r) => r.role)).toEqual(['admin', 'member', 'viewer']);
  });

  it('returns [] for markup with no table', () => {
    expect(parseOrgMemberTable('<html><body><p>nope</p></body></html>')).toEqual([]);
  });
});
