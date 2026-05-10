/**
 * Tests for the `drive_create_shortcut` MCP atom (Task 13 of the
 * run-folder-readability plan). Mirrors the find-or-create.test.ts shape:
 * vi.fn-mocked Drive client, exercises the exported `handleCreateShortcut`
 * directly without going through the MCP transport.
 *
 * The orchestrator (Task 28) will use this atom to refresh
 * `<opp>/current/` shortcuts after each phase completes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateShortcut, __resetSharedDriveProbeCacheForTests } from '../../../mcp/google-drive-server.js';

const fakeDrive = {
  files: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
};

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

describe('drive_create_shortcut', () => {
  beforeEach(() => {
    __resetSharedDriveProbeCacheForTests();
    fakeDrive.files.list.mockReset();
    fakeDrive.files.create.mockReset();
    fakeDrive.files.get.mockReset();
    fakeDrive.files.delete.mockReset();
    // Default: parent passes the Shared-Drive guard.
    fakeDrive.files.get.mockResolvedValue({
      data: {
        id: 'parent-1',
        name: 'current',
        driveId: 'shared-drive',
        mimeType: 'application/vnd.google-apps.folder',
      },
    });
    // Default: list returns no existing children.
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    // Default: create returns the newly created shortcut.
    fakeDrive.files.create.mockResolvedValue({
      data: {
        id: 'new-shortcut-id',
        name: 'connect-opp-summary.md',
        webViewLink: 'https://drive.google.com/x',
      },
    });
  });

  it('creates a shortcut pointing at targetId', async () => {
    const r = await handleCreateShortcut(
      {
        name: 'connect-opp-summary.md',
        parentFolderId: 'parent-1',
        targetId: 'target-file-id',
      },
      fakeDrive as any,
    );
    expect(r.id).toBe('new-shortcut-id');
    expect(fakeDrive.files.create).toHaveBeenCalledOnce();
    const createArgs = fakeDrive.files.create.mock.calls[0]![0];
    expect(createArgs.requestBody.name).toBe('connect-opp-summary.md');
    expect(createArgs.requestBody.mimeType).toBe(SHORTCUT_MIME);
    expect(createArgs.requestBody.parents).toEqual(['parent-1']);
    expect(createArgs.requestBody.shortcutDetails).toEqual({ targetId: 'target-file-id' });
    // Default: findOrReplace is false — list/delete should NOT be called.
    expect(fakeDrive.files.delete).not.toHaveBeenCalled();
  });

  it('with findOrReplace=true and an existing same-name entry, deletes the old and creates new', async () => {
    fakeDrive.files.list.mockResolvedValue({
      data: { files: [{ id: 'old-shortcut-id' }] },
    });
    const r = await handleCreateShortcut(
      {
        name: 'connect-opp-summary.md',
        parentFolderId: 'parent-1',
        targetId: 'new-target-id',
        findOrReplace: true,
      },
      fakeDrive as any,
    );
    expect(fakeDrive.files.delete).toHaveBeenCalledWith({
      fileId: 'old-shortcut-id',
      supportsAllDrives: true,
    });
    expect(fakeDrive.files.create).toHaveBeenCalledOnce();
    expect(r.id).toBe('new-shortcut-id');
  });

  it('with findOrReplace=false (default) and an existing entry, creates a new shortcut without deleting', async () => {
    fakeDrive.files.list.mockResolvedValue({
      data: { files: [{ id: 'old-shortcut-id' }] },
    });
    const r = await handleCreateShortcut(
      {
        name: 'connect-opp-summary.md',
        parentFolderId: 'parent-1',
        targetId: 'new-target-id',
      },
      fakeDrive as any,
    );
    expect(fakeDrive.files.delete).not.toHaveBeenCalled();
    expect(fakeDrive.files.create).toHaveBeenCalledOnce();
    expect(r.id).toBe('new-shortcut-id');
  });

  it('rejects when parent is in My Drive (no driveId)', async () => {
    fakeDrive.files.get.mockResolvedValue({
      data: {
        id: 'parent-1',
        name: 'current',
        driveId: null,
        mimeType: 'application/vnd.google-apps.folder',
      },
    });
    await expect(
      handleCreateShortcut(
        { name: 'foo.md', parentFolderId: 'parent-1', targetId: 'target-id' },
        fakeDrive as any,
      ),
    ).rejects.toThrow(/My Drive/);
    expect(fakeDrive.files.create).not.toHaveBeenCalled();
  });
});
