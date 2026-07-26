import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseWorkersTable,
  findInviteByPhone,
  WorkersTableSchemaError,
} from '../../lib/connect-flw-invites.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/connect');
const load = (n: string) => fs.readFileSync(path.join(FIXTURES, n), 'utf8');

// Both fixtures are REAL markup captured 2026-07-25 from
// GET /a/ai-demo-space/opportunity/<id>/workers/ during the #811 A/B:
//   linked   → cb24ac17 (hh-poverty 20260722-1341), demo user accepted
//   unlinked → d99e4422 (LEEP), fresh invite that never reached the device
const LINKED = 'workers-table-linked.html';
const UNLINKED = 'workers-table-unlinked.html';
const DEMO_PHONE = '+74260000101';

describe('parseWorkersTable — linked (accepted) worker', () => {
  it('reports linked:true with name + connect user id split out', () => {
    const rows = parseWorkersTable(load(LINKED));
    const row = findInviteByPhone(rows, DEMO_PHONE);
    expect(row).not.toBeNull();
    expect(row!.linked).toBe(true);
    expect(row!.status).toBe('accepted');
    expect(row!.name).toBe('ACE Test');
    expect(row!.connect_user_id).toMatch(/^[0-9a-f]{16,}$/i);
  });

  it('captures the Learn-completion timestamp', () => {
    const row = findInviteByPhone(parseWorkersTable(load(LINKED)), DEMO_PHONE)!;
    expect(row.completed_learn).toBeTruthy();
  });
});

describe('parseWorkersTable — unlinked (pending) invite', () => {
  it('reports linked:false — the #824/#855 failure mode', () => {
    const rows = parseWorkersTable(load(UNLINKED));
    const row = findInviteByPhone(rows, DEMO_PHONE);
    expect(row).not.toBeNull();
    // This is the whole point: the send returned {status:"queued"} and the
    // access row exists, but no ConnectID user is linked, so Connect's mobile
    // API can never return this opportunity to the worker.
    expect(row!.linked).toBe(false);
    expect(row!.status).toBe('pending');
    expect(row!.name).toBeNull();
    expect(row!.connect_user_id).toBeNull();
  });

  it('still finds the other, older worker on the same opp as linked', () => {
    const rows = parseWorkersTable(load(UNLINKED));
    // The LEEP opp also carries the PREVIOUS demo phone, which is accepted.
    const older = rows.find((r) => r.phone !== DEMO_PHONE.replace(/\D/g, '') && r.linked);
    expect(older).toBeDefined();
    expect(older!.status).toBe('accepted');
  });
});

describe('parseWorkersTable — phone matching', () => {
  it('matches on digits only, so +7426… and 7426… both resolve', () => {
    const rows = parseWorkersTable(load(LINKED));
    expect(findInviteByPhone(rows, '74260000101')).not.toBeNull();
    expect(findInviteByPhone(rows, '+7426 0000 101')).not.toBeNull();
  });

  it('returns null for a phone that is not on the opp', () => {
    const rows = parseWorkersTable(load(LINKED));
    expect(findInviteByPhone(rows, '+15555550123')).toBeNull();
  });
});

describe('parseWorkersTable — fail loud, never guess', () => {
  it('throws when there are no header cells at all', () => {
    expect(() => parseWorkersTable('<div>not a table</div>')).toThrow(WorkersTableSchemaError);
  });

  it('throws when a required column is missing (template reshape)', () => {
    // Headers present but no Phone column → must fail rather than shift fields.
    const html = `
      <table>
        <tr><th></th><th>#</th><th>Status</th><th>Name</th><th>Last Active</th></tr>
        <tr><td></td><td>1</td><td><i class="fa-solid fa-circle-check"></i></td><td>X</td><td>—</td></tr>
      </table>`;
    expect(() => parseWorkersTable(html)).toThrow(/required column "Phone Number" not found/);
  });

  it('returns [] for a workers table with no invites yet (legitimate state)', () => {
    const html = `
      <table>
        <tr><th></th><th>#</th><th>Status</th><th>Name</th><th>Phone Number</th></tr>
      </table>`;
    expect(parseWorkersTable(html)).toEqual([]);
  });

  it('an unrecognized status icon is never treated as linked', () => {
    const html = `
      <table>
        <tr><th></th><th>#</th><th>Status</th><th>Name</th><th>Phone Number</th></tr>
        <tr><td></td><td>1</td><td><i class="fa-solid fa-question"></i></td>
            <td>Someone abcdef0123456789</td><td>+74260000101</td></tr>
      </table>`;
    const row = findInviteByPhone(parseWorkersTable(html), DEMO_PHONE)!;
    expect(row.status).toBe('unknown');
    expect(row.linked).toBe(false);
  });

  it('a name without the accepted icon is NOT linked (name alone is insufficient)', () => {
    // #855 is explicit that a name-column read is not sufficient.
    const html = `
      <table>
        <tr><th></th><th>#</th><th>Status</th><th>Name</th><th>Phone Number</th></tr>
        <tr><td></td><td>1</td><td><i class="fa-regular fa-clock"></i></td>
            <td>Someone abcdef0123456789</td><td>+74260000101</td></tr>
      </table>`;
    const row = findInviteByPhone(parseWorkersTable(html), DEMO_PHONE)!;
    expect(row.status).toBe('pending');
    expect(row.linked).toBe(false);
  });

  it('skips totals/empty rows that carry no phone', () => {
    const html = `
      <table>
        <tr><th></th><th>#</th><th>Status</th><th>Name</th><th>Phone Number</th></tr>
        <tr><td></td><td></td><td></td><td>Total</td><td>—</td></tr>
      </table>`;
    expect(parseWorkersTable(html)).toEqual([]);
  });
});
