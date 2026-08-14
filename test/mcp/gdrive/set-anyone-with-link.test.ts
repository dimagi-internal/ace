/**
 * `drive_set_anyone_with_link` role plumbing.
 *
 * The atom hardcoded `role: 'reader'`. A Drive reader CANNOT comment, so even a
 * fully-shared ACE deliverable left an external reviewer with no way to leave
 * feedback in the doc — while `skills/feedback-ledger`'s canonical example uses
 * `channel: gdoc-comments`. (The one external reviewer who ever commented on an
 * ACE deliverable could only do so because she separately held `fileOrganizer`
 * on the shared drive — not a grant we hand a partner.)
 *
 * These pin: reader stays the default (every existing caller — the Slides
 * image-import paths — is unchanged), and `commenter` reaches the Drive API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSetAnyoneWithLink } from '../../../mcp/google-drive-server.js';

const fakeDrive = {
  permissions: {
    create: vi.fn(),
  },
};

describe('drive_set_anyone_with_link role', () => {
  beforeEach(() => {
    fakeDrive.permissions.create.mockReset();
    fakeDrive.permissions.create.mockResolvedValue({ data: { id: 'perm-1' } });
  });

  it('defaults to reader so existing callers are unchanged', async () => {
    const r = await handleSetAnyoneWithLink({ fileId: 'file-1' }, fakeDrive as any);
    expect(fakeDrive.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        supportsAllDrives: true,
        requestBody: { role: 'reader', type: 'anyone' },
      }),
    );
    expect(r.role).toBe('reader');
  });

  it('grants commenter when asked — the role a reviewer needs to leave feedback', async () => {
    const r = await handleSetAnyoneWithLink({ fileId: 'file-2', role: 'commenter' }, fakeDrive as any);
    expect(fakeDrive.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { role: 'commenter', type: 'anyone' },
      }),
    );
    expect(r.role).toBe('commenter');
    expect(r.sharing).toContain('commenter');
  });

  it('reports the granted role back so the caller can log what it actually did', async () => {
    const r = await handleSetAnyoneWithLink({ fileId: 'file-3', role: 'reader' }, fakeDrive as any);
    expect(r).toMatchObject({ fileId: 'file-3', permissionId: 'perm-1', role: 'reader' });
  });
});
