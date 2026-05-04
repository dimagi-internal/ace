import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateFolder } from '../../../mcp/google-drive-server.js';

const fakeDrive = {
  files: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),  // for assertParentOnSharedDrive
  },
};

describe('drive_create_folder findOrCreate mode', () => {
  beforeEach(() => {
    fakeDrive.files.list.mockReset();
    fakeDrive.files.create.mockReset();
    fakeDrive.files.get.mockReset();
    // Default: parent passes the Shared-Drive guard
    fakeDrive.files.get.mockResolvedValue({
      data: { id: 'parent-1', name: 'parent', driveId: 'shared-drive', mimeType: 'application/vnd.google-apps.folder' },
    });
  });

  it('reuses existing folder when one with the same name exists under the parent', async () => {
    fakeDrive.files.list.mockResolvedValue({
      data: { files: [{ id: 'existing-folder-id', name: 'verdicts' }] },
    });
    const r = await handleCreateFolder({ name: 'verdicts', parentFolderId: 'parent-1', findOrCreate: true }, fakeDrive as any);
    expect(r.id).toBe('existing-folder-id');
    expect(fakeDrive.files.create).not.toHaveBeenCalled();
  });

  it('creates a new folder when none exists with that name', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'new-folder-id', name: 'verdicts', webViewLink: 'https://x/y' },
    });
    const r = await handleCreateFolder({ name: 'verdicts', parentFolderId: 'parent-1', findOrCreate: true }, fakeDrive as any);
    expect(r.id).toBe('new-folder-id');
    expect(fakeDrive.files.create).toHaveBeenCalledOnce();
  });

  it('always creates a new folder when findOrCreate=false', async () => {
    fakeDrive.files.list.mockResolvedValue({
      data: { files: [{ id: 'existing-folder-id', name: 'verdicts' }] },
    });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'second-folder-id', name: 'verdicts', webViewLink: 'https://x/z' },
    });
    const r = await handleCreateFolder({ name: 'verdicts', parentFolderId: 'parent-1', findOrCreate: false }, fakeDrive as any);
    expect(r.id).toBe('second-folder-id');
  });

  it('defaults findOrCreate to true when not specified', async () => {
    fakeDrive.files.list.mockResolvedValue({
      data: { files: [{ id: 'existing-folder-id', name: 'verdicts' }] },
    });
    const r = await handleCreateFolder({ name: 'verdicts', parentFolderId: 'parent-1' }, fakeDrive as any);
    expect(r.id).toBe('existing-folder-id');
    expect(fakeDrive.files.create).not.toHaveBeenCalled();
  });
});
