import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parsePendingInviteTable } from '../../lib/connect-member-table.js';

/**
 * ace#2503 — Connect's add-member form now records a PENDING invite
 * (`/a/<org>/organization/pending_invites_table`), not a membership. The
 * fixtures are reconstructed from commcare-connect's PendingInviteTable +
 * base_table.html templates (see each fixture's header comment).
 */
const FIXTURES = join(__dirname, '..', 'fixtures', 'connect-html');
const rowsHtml = readFileSync(join(FIXTURES, 'pending_invites_table-rows.html'), 'utf8');
const emptyHtml = readFileSync(join(FIXTURES, 'pending_invites_table-empty.html'), 'utf8');

describe('parsePendingInviteTable', () => {
  it('parses one row per pending invite with the stored role and dates', () => {
    expect(parsePendingInviteTable(rowsHtml)).toEqual([
      { email: 'stewari@dimagi.com', role: 'admin', invited_on: '26-Sep-2026 13:19', expires_on: '03-Oct-2026 13:19' },
      { email: 'smazumdar@dimagi.com', role: 'admin', invited_on: '26-Sep-2026 13:19', expires_on: '03-Oct-2026 13:19' },
      { email: 'aking@dimagi.com', role: 'viewer', invited_on: '26-Sep-2026 13:19', expires_on: '03-Oct-2026 13:19' },
      { email: 'mtheis@dimagi.com', role: 'member', invited_on: '26-Sep-2026 13:18', expires_on: '03-Oct-2026 13:18' },
    ]);
  });

  it('parses "No pending invites." as [] — the out-of-table messages block naming an email is not an invite', () => {
    expect(emptyHtml).toContain('ghost@dimagi.com'); // control: the email IS in the markup
    expect(parsePendingInviteTable(emptyHtml)).toEqual([]);
  });

  it('does not count the success message in a populated table as an extra row', () => {
    // stewari@ appears twice in the markup (message + row) but is one invite.
    expect(parsePendingInviteTable(rowsHtml).filter((r) => r.email === 'stewari@dimagi.com')).toHaveLength(1);
  });
});
