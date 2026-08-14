/**
 * `drive_share_with_person` — named-person (`type: user`) sharing.
 *
 * Why the atom exists: ACE opportunities are co-created with partners
 * (Jonathan, 2026-08-14). Before this, `drive_set_anyone_with_link` was the
 * only sharing atom (link-based, `type: anyone`) and the only `type: user`
 * permission call in the whole gdrive server was `drive_transfer_ownership`
 * at `role: owner` — so there was no way to give a named collaborator edit
 * rights on anything.
 *
 * These pin the two contracts that matter:
 *   1. role plumbing — `writer` is the default (the co-creation grant),
 *      `reader`/`commenter` reach the Drive API when asked;
 *   2. **`sendNotificationEmail` defaults to FALSE.** Drive emails the grantee
 *      unless told not to, and ACE's outbound email is gated through
 *      `bin/ace-email` (raw `gog gmail send` is hook-blocked). A Drive-sent
 *      share notification would route around that gate, so silence is the
 *      default and sending is an explicit opt-in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleShareWithPerson } from '../../../mcp/google-drive-server.js';

const fakeDrive = {
  permissions: {
    create: vi.fn(),
  },
};

describe('drive_share_with_person', () => {
  beforeEach(() => {
    fakeDrive.permissions.create.mockReset();
    fakeDrive.permissions.create.mockResolvedValue({ data: { id: 'perm-u1' } });
  });

  it('defaults to writer — the grant that makes co-creation possible', async () => {
    const r = await handleShareWithPerson(
      { fileId: 'file-1', email: 'partner@example.org' },
      fakeDrive as any,
    );
    expect(fakeDrive.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        supportsAllDrives: true,
        requestBody: { role: 'writer', type: 'user', emailAddress: 'partner@example.org' },
      }),
    );
    expect(r.role).toBe('writer');
    expect(r.sharing).toBe('user:partner@example.org (writer)');
  });

  it.each(['reader', 'commenter', 'writer'] as const)('passes role %s through to Drive', async (role) => {
    const r = await handleShareWithPerson(
      { fileId: 'file-2', email: 'partner@example.org', role },
      fakeDrive as any,
    );
    expect(fakeDrive.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { role, type: 'user', emailAddress: 'partner@example.org' },
      }),
    );
    expect(r.role).toBe(role);
  });

  it('defaults sendNotificationEmail to FALSE — never silently emails an external party', async () => {
    const r = await handleShareWithPerson(
      { fileId: 'file-3', email: 'partner@example.org' },
      fakeDrive as any,
    );
    expect(fakeDrive.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({ sendNotificationEmail: false }),
    );
    expect(r.notified).toBe(false);
  });

  it('keeps the notification off when the caller explicitly passes false', async () => {
    await handleShareWithPerson(
      { fileId: 'file-4', email: 'partner@example.org', sendNotificationEmail: false },
      fakeDrive as any,
    );
    expect(fakeDrive.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({ sendNotificationEmail: false }),
    );
  });

  it('passes sendNotificationEmail through when the caller opts in explicitly', async () => {
    const r = await handleShareWithPerson(
      { fileId: 'file-5', email: 'partner@example.org', sendNotificationEmail: true },
      fakeDrive as any,
    );
    expect(fakeDrive.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({ sendNotificationEmail: true }),
    );
    expect(r.notified).toBe(true);
  });

  it('reports the granted person + role back so the caller can log what it actually did', async () => {
    const r = await handleShareWithPerson(
      { fileId: 'file-6', email: 'partner@example.org', role: 'commenter' },
      fakeDrive as any,
    );
    expect(r).toMatchObject({
      fileId: 'file-6',
      permissionId: 'perm-u1',
      email: 'partner@example.org',
      role: 'commenter',
      notified: false,
    });
  });
});
