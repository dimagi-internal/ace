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

/**
 * `writer` — the co-creation role (Jonathan, 2026-08-14: ACE opportunities are
 * co-created with partners, so feedback arrives as revisions, not only as
 * comments). Verified live against the ACE Shared Drive on 2026-08-14: Drive
 * returned `{"id":"anyoneWithLink","type":"anyone","role":"writer"}` — this
 * tenant does not cap anyone-with-link at commenter.
 */
describe('drive_set_anyone_with_link writer role', () => {
  beforeEach(() => {
    fakeDrive.permissions.create.mockReset();
    fakeDrive.permissions.create.mockResolvedValue({ data: { id: 'perm-w' } });
  });

  it('grants writer when asked — the role a co-creating partner needs to edit', async () => {
    const r = await handleSetAnyoneWithLink({ fileId: 'file-4', role: 'writer' }, fakeDrive as any);
    expect(fakeDrive.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-4',
        supportsAllDrives: true,
        requestBody: { role: 'writer', type: 'anyone' },
      }),
    );
    expect(r.role).toBe('writer');
    expect(r.sharing).toContain('writer');
  });

  it('never sets a notification flag — anyone-with-link has no grantee to email', async () => {
    await handleSetAnyoneWithLink({ fileId: 'file-5', role: 'writer' }, fakeDrive as any);
    const call = fakeDrive.permissions.create.mock.calls[0][0];
    expect(call).not.toHaveProperty('sendNotificationEmail');
  });
});
