import { describe, it, expect } from 'vitest';
import { parseOrgMemberTable } from '../../lib/connect-member-table.js';

/**
 * Shape mirrors commcare-connect `organization/tables.py::OrgMemberTable`:
 *   sequence = ("select", "index", "user", "role")
 *   role rendered as <div class=' underline underline-offset-4'>{value}</div>
 *
 * CAPTURED FROM LIVE MARKUP, not assumed — `GET /a/<org>/organization/member_table`
 * on 2026-07-30. django-tables2 emits `<td >` (a SPACE before the closing '>')
 * when a column carries no attrs, and `<tr class="even" class="group">` on
 * alternating rows. The original fixture for #911 was hand-written as `<td>` /
 * `<tr>`, which passed every test while the parser matched ZERO live rows.
 * Do not "tidy" the spacing below — it is the regression surface. See ace#1064.
 */
function row(index: number, email: string, role: string, even = false): string {
  return `<tr class="${even ? 'even' : 'odd'}" class="group">
    <td >
      <input type="checkbox" name="row_select" value="${index}" x-model="selected" @click.stop="" class="checkbox" id="row_checkbox_${index}" />
    </td>
    <td >
      ${index}
    </td>
    <td >
      ${email}
    </td>
    <td >
      <div class=' underline underline-offset-4'>${role}</div>
    </td>
  </tr>`;
}

const TABLE = (...rows: string[]) => `
  <table>
    <thead><tr class="group"><th >select</th><th >#</th><th >member</th><th >Role</th></tr></thead>
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

  // ace#1064 — the parser had 100% test coverage and 0% live accuracy.
  // A delimiter character class (`/<t[dh][\s>]/`) consumes only ONE character
  // after the tag name, so `<td >` left a stray '>' at the head of every cell.
  // EMAIL_RE is a substring test and survived it; the role cell is matched by
  // EXACT equality, so `"> member" !== "member"` skipped every row and the whole
  // table parsed as EMPTY. connect_add_org_member then concluded "not a member
  // before, not present after" for everyone and reported the fabricated
  // "no Connect account exists for this email" — which shipped toward a real
  // external reviewer who had been a Member the whole time.
  it('parses cells when the tag has a space before the close (<td >) — ace#1064', () => {
    const verbatim = `
      <tr class="even" class="group">
        <td >
          <input type="checkbox" name="row_select" value="1187" x-model="selected" @click.stop="" class="checkbox" id="row_checkbox_1187" />
        </td>
        <td >
          7
        </td>
        <td >
          sfeintuch@dimagi-associate.com
        </td>
        <td >
          <div class=' underline underline-offset-4'>Member</div>
        </td>
      </tr>`;
    expect(parseOrgMemberTable(verbatim)).toEqual([
      { email: 'sfeintuch@dimagi-associate.com', role: 'member' },
    ]);
  });

  it('never parses a populated member table as empty — ace#1064', () => {
    // The precise failure that mattered: absence is load-bearing (it is read as
    // "this person has no Connect account"), so an all-rows-skipped bug is far
    // worse than a parse error. Guard the invariant directly.
    const html = TABLE(
      row(1, 'mtheis@dimagi.com', 'Admin'),
      row(7, 'sfeintuch@dimagi-associate.com', 'Member', true),
    );
    const rows = parseOrgMemberTable(html);
    expect(rows).not.toHaveLength(0);
    expect(rows.map((r) => r.email)).toContain('sfeintuch@dimagi-associate.com');
  });
});
