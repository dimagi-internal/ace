/**
 * ace#2918 — the gdrive server could grant Drive access but never list or
 * withdraw it, so an anyone-with-link grant was a one-way door (tekzal/
 * 20261013-2314: a superseded Work Order linking a Dimagi-internal PDD could
 * only be renamed + trashed, grant intact). These pin `drive_list_permissions`
 * and `drive_revoke_access`, including the ace#1112-shape rails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleListPermissions,
  handleRevokeAccess,
  __resetAceDriveIdCacheForTests,
} from '../../../mcp/google-drive-server.js';
import { assertRevocablePermission, DestructiveGuardError } from '../../../lib/destructive-guards.js';
import { DRIVE_WRITE_TARGETS } from '../../../lib/drive-tenancy-guard.js';

const ACE_DRIVE = '0AIUhETtpTlpcUk9PVA';
const SA = 'ace-sa@project.iam.gserviceaccount.com';

const ANYONE = { id: 'anyoneWithLink', type: 'anyone', role: 'writer', permissionDetails: [{ inherited: false }] };
const REVIEWER = { id: 'p-rev', type: 'user', role: 'commenter', emailAddress: 'Reviewer@Partner.org', permissionDetails: [{ inherited: false }] };
const ORGANIZER = { id: 'p-org', type: 'user', role: 'organizer', emailAddress: 'admin@dimagi.com', permissionDetails: [{ inherited: true, inheritedFrom: ACE_DRIVE }] };
const SELF = { id: 'p-sa', type: 'user', role: 'writer', emailAddress: SA, permissionDetails: [{ inherited: false }] };

let perms: any[];

const fakeDrive = {
  files: { get: vi.fn() },
  about: { get: vi.fn() },
  permissions: { list: vi.fn(), delete: vi.fn() },
};

beforeEach(() => {
  __resetAceDriveIdCacheForTests();
  delete process.env.ACE_DRIVE_ROOT_FOLDER_ID;
  perms = [ANYONE, REVIEWER, ORGANIZER, SELF].map((p) => ({ ...p }));
  fakeDrive.files.get.mockReset().mockResolvedValue({
    data: { id: 'wo-1', name: 'Work Order', mimeType: 'application/vnd.google-apps.document', driveId: ACE_DRIVE },
  });
  fakeDrive.about.get.mockReset().mockResolvedValue({ data: { user: { emailAddress: SA } } });
  fakeDrive.permissions.list.mockReset().mockImplementation(async () => ({ data: { permissions: perms.map((p) => ({ ...p })) } }));
  fakeDrive.permissions.delete.mockReset().mockImplementation(async ({ permissionId }: any) => {
    perms = perms.filter((p) => p.id !== permissionId);
    return { data: {} };
  });
});

describe('drive_list_permissions', () => {
  it('lists every permission and flags anyone-with-link', async () => {
    const r = await handleListPermissions({ fileId: 'wo-1' }, fakeDrive as any, { sleep: async () => {} });
    expect(r.total).toBe(4);
    expect(r.anyone_with_link).toBe(true);
    expect(r.permissions.find((p) => p.id === 'p-org')).toMatchObject({ inherited: true, inherited_from: ACE_DRIVE });
    expect(fakeDrive.permissions.list.mock.calls[0][0]).toMatchObject({ fileId: 'wo-1', supportsAllDrives: true });
  });

  it('follows pagination', async () => {
    fakeDrive.permissions.list
      .mockResolvedValueOnce({ data: { permissions: [ANYONE], nextPageToken: 't2' } })
      .mockResolvedValueOnce({ data: { permissions: [REVIEWER] } });
    const r = await handleListPermissions({ fileId: 'wo-1' }, fakeDrive as any, { sleep: async () => {} });
    expect(r.total).toBe(2);
    expect(fakeDrive.permissions.list.mock.calls[1][0].pageToken).toBe('t2');
  });
});

describe('drive_revoke_access', () => {
  it('removes the anyone-with-link grant and confirms by read-back', async () => {
    const r = await handleRevokeAccess({ fileId: 'wo-1', type: 'anyone' }, fakeDrive as any);
    expect(fakeDrive.permissions.delete).toHaveBeenCalledWith({
      fileId: 'wo-1',
      permissionId: 'anyoneWithLink',
      supportsAllDrives: true,
    });
    expect(r.removed.map((p) => p.id)).toEqual(['anyoneWithLink']);
    expect(r.anyone_with_link).toBe(false);
    expect(r.remaining.map((p) => p.id)).toEqual(['p-rev', 'p-org', 'p-sa']);
  });

  it('removes a user grant by email, case-insensitively', async () => {
    const r = await handleRevokeAccess({ fileId: 'wo-1', type: 'user', email: 'reviewer@partner.ORG' }, fakeDrive as any);
    expect(r.removed.map((p) => p.id)).toEqual(['p-rev']);
  });

  it('refuses with no_matching_permission when the email has no grant — and changes nothing', async () => {
    await expect(
      handleRevokeAccess({ fileId: 'wo-1', type: 'user', email: 'nobody@partner.org' }, fakeDrive as any),
    ).rejects.toThrow(/no_matching_permission.*nobody@partner\.org/);
    expect(fakeDrive.permissions.delete).not.toHaveBeenCalled();
  });

  it('refuses an organizer, ACE itself, and an inherited grant', async () => {
    await expect(handleRevokeAccess({ fileId: 'wo-1', permissionId: 'p-org' }, fakeDrive as any)).rejects.toThrow(DestructiveGuardError);
    await expect(handleRevokeAccess({ fileId: 'wo-1', permissionId: 'p-sa' }, fakeDrive as any)).rejects.toThrow(/ACE's own access/);
    expect(fakeDrive.permissions.delete).not.toHaveBeenCalled();
  });

  it('refuses a file that is not on ACE\'s Shared Drive', async () => {
    fakeDrive.files.get.mockResolvedValue({ data: { id: 'x', name: 'foreign', mimeType: 'application/pdf', driveId: null } });
    await expect(handleRevokeAccess({ fileId: 'x', type: 'anyone' }, fakeDrive as any)).rejects.toThrow(/not on ACE's Shared Drive/);
    expect(fakeDrive.permissions.list).not.toHaveBeenCalled();
  });

  it('refuses a shortcut id rather than following it past the tenancy guard', async () => {
    fakeDrive.files.get.mockResolvedValue({
      data: { id: 'sc', mimeType: 'application/vnd.google-apps.shortcut', driveId: ACE_DRIVE },
    });
    await expect(handleRevokeAccess({ fileId: 'sc', type: 'anyone' }, fakeDrive as any)).rejects.toThrow(/shortcut_not_revocable/);
  });

  it('throws revoke_not_confirmed when the grant survives the delete', async () => {
    fakeDrive.permissions.delete.mockResolvedValue({ data: {} }); // no-op delete
    await expect(handleRevokeAccess({ fileId: 'wo-1', type: 'anyone' }, fakeDrive as any)).rejects.toThrow(/revoke_not_confirmed/);
  });

  it('rejects an ambiguous or incomplete selector', async () => {
    await expect(handleRevokeAccess({ fileId: 'wo-1' }, fakeDrive as any)).rejects.toThrow(/invalid_selector/);
    await expect(handleRevokeAccess({ fileId: 'wo-1', permissionId: 'p', type: 'anyone' }, fakeDrive as any)).rejects.toThrow(/invalid_selector/);
    await expect(handleRevokeAccess({ fileId: 'wo-1', type: 'user' }, fakeDrive as any)).rejects.toThrow(/invalid_selector/);
  });

  it('is a tenancy-guarded Drive write; listing is a read and is not', () => {
    expect(DRIVE_WRITE_TARGETS.drive_revoke_access).toEqual(['fileId']);
    expect(DRIVE_WRITE_TARGETS.drive_list_permissions).toBeUndefined();
  });
});

describe('assertRevocablePermission', () => {
  it('allows a direct share', () => {
    expect(() => assertRevocablePermission(ANYONE, SA)).not.toThrow();
    expect(() => assertRevocablePermission(REVIEWER, SA)).not.toThrow();
  });
  it('refuses owner / fileOrganizer', () => {
    expect(() => assertRevocablePermission({ id: 'o', role: 'owner' })).toThrow(/custody/);
    expect(() => assertRevocablePermission({ id: 'f', role: 'fileOrganizer' })).toThrow(/custody/);
  });
  it('refuses an inherited grant and names the folder', () => {
    expect(() =>
      assertRevocablePermission({ id: 'i', role: 'reader', permissionDetails: [{ inherited: true, inheritedFrom: 'fold-1' }] }),
    ).toThrow(/Revoke it on fold-1/);
  });
});
