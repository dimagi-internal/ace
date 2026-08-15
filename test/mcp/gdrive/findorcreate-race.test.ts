/**
 * ace#1417 — the wiring, not just the decision rule.
 *
 * Simulates the live race: the pre-create lookup misses (a concurrent writer's
 * file is not there yet), we create, and by the time we re-list the sibling has
 * landed and is older. The handler must adopt it, apply OUR content to it, and
 * trash only the file we made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleCreateFile,
  handleCreateFolder,
  __resetSharedDriveProbeCacheForTests,
} from '../../../mcp/google-drive-server.js';

const fakeDrive = {
  files: { list: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn() },
};

const PARENT = {
  id: 'parent-1', name: 'parent', driveId: 'shared-drive',
  mimeType: 'application/vnd.google-apps.folder',
};

beforeEach(() => {
  __resetSharedDriveProbeCacheForTests();
  for (const f of Object.values(fakeDrive.files)) f.mockReset();
  fakeDrive.files.get.mockResolvedValue({ data: PARENT });
});

describe('drive_create_file loses a race', () => {
  const OURS = '1RgVqiranxNpxlOGGyY-hbRpDWio_mGpCYo0aop5y7s8';
  const THEIRS = '1NrTc7ZRSY5cQKY07_DHYQV-x2VcfEqJ3WTZSZXM6PDE';

  beforeEach(() => {
    fakeDrive.files.list
      .mockResolvedValueOnce({ data: { files: [] } })                       // pre-create: miss
      .mockResolvedValueOnce({                                             // post-create: both
        data: {
          files: [
            { id: OURS, createdTime: '2026-08-14T20:25:33.000Z' },
            { id: THEIRS, createdTime: '2026-08-14T20:19:01.000Z' },
          ],
        },
      });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: OURS, name: 'idea-to-pdd.md', webViewLink: 'https://x/ours' },
    });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'ok' } });
    fakeDrive.files.get
      .mockResolvedValueOnce({ data: PARENT })                             // shared-drive guard
      .mockResolvedValueOnce({
        data: { id: THEIRS, name: 'idea-to-pdd.md', webViewLink: 'https://x/theirs' },
      });
  });

  it('returns the canonical (earlier) file, not the one it just made', async () => {
    const r = await handleCreateFile(
      { name: 'idea-to-pdd.md', content: 'corrected body', parentFolderId: 'parent-1' },
      fakeDrive as never,
    );
    expect(r.id).toBe(THEIRS);
    expect(r.reused).toBe(true);
  });

  it('applies OUR content to the canonical file rather than discarding it', async () => {
    await handleCreateFile(
      { name: 'idea-to-pdd.md', content: 'corrected body', parentFolderId: 'parent-1' },
      fakeDrive as never,
    );
    expect(fakeDrive.files.update).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: THEIRS,
        media: { mimeType: 'text/plain; charset=utf-8', body: 'corrected body' },
      }),
    );
  });

  it('trashes ONLY the file it created', async () => {
    await handleCreateFile(
      { name: 'idea-to-pdd.md', content: 'corrected body', parentFolderId: 'parent-1' },
      fakeDrive as never,
    );
    const trashCalls = fakeDrive.files.update.mock.calls
      .map(([a]) => a)
      .filter((a: { requestBody?: { trashed?: boolean } }) => a.requestBody?.trashed === true);
    expect(trashCalls).toHaveLength(1);
    expect(trashCalls[0].fileId).toBe(OURS);
  });
});

describe('drive_create_file wins a race', () => {
  it('keeps its own file and trashes nothing', async () => {
    fakeDrive.files.list
      .mockResolvedValueOnce({ data: { files: [] } })
      .mockResolvedValueOnce({
        data: {
          files: [
            { id: 'ours', createdTime: '2026-08-14T20:19:01.000Z' },
            { id: 'theirs', createdTime: '2026-08-14T20:25:33.000Z' },
          ],
        },
      });
    fakeDrive.files.create.mockResolvedValue({ data: { id: 'ours', name: 'x.md', webViewLink: 'u' } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'ours' } });

    const r = await handleCreateFile(
      { name: 'x.md', content: 'body', parentFolderId: 'parent-1' },
      fakeDrive as never,
    );
    expect(r.id).toBe('ours');
    const trashed = fakeDrive.files.update.mock.calls
      .map(([a]) => a)
      .filter((a: { requestBody?: { trashed?: boolean } }) => a.requestBody?.trashed === true);
    expect(trashed).toEqual([]);
  });

  it('does not reconcile at all when findOrCreate is false', async () => {
    fakeDrive.files.create.mockResolvedValue({ data: { id: 'n', name: 'x.md', webViewLink: 'u' } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'n' } });

    await handleCreateFile(
      { name: 'x.md', content: 'b', parentFolderId: 'parent-1', findOrCreate: false },
      fakeDrive as never,
    );
    // No lookup before, none after — an explicit sibling is what was asked for.
    expect(fakeDrive.files.list).not.toHaveBeenCalled();
  });
});

describe('drive_create_folder', () => {
  it('adopts the earlier folder and reclaims its own EMPTY duplicate', async () => {
    fakeDrive.files.list
      .mockResolvedValueOnce({ data: { files: [] } })                          // pre-create miss
      .mockResolvedValueOnce({                                                 // post-create
        data: {
          files: [
            { id: 'ours', createdTime: '2026-08-14T20:25:33.000Z' },
            { id: 'theirs', createdTime: '2026-08-14T20:19:01.000Z' },
          ],
        },
      })
      .mockResolvedValueOnce({ data: { files: [] } });                         // our folder is empty
    fakeDrive.files.create.mockResolvedValue({ data: { id: 'ours', name: 'verdicts', webViewLink: 'u' } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'ours' } });
    fakeDrive.files.get
      .mockResolvedValueOnce({ data: PARENT })
      .mockResolvedValueOnce({ data: { id: 'theirs', name: 'verdicts', webViewLink: 'v' } });

    const r = await handleCreateFolder(
      { name: 'verdicts', parentFolderId: 'parent-1' },
      fakeDrive as never,
    );
    expect(r.id).toBe('theirs');
    expect(fakeDrive.files.update).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'ours', requestBody: { trashed: true } }),
    );
  });

  it('does NOT trash a duplicate folder that already has children', async () => {
    // A sibling skill may have written into it in the window; trashing would
    // take those with it.
    fakeDrive.files.list
      .mockResolvedValueOnce({ data: { files: [] } })
      .mockResolvedValueOnce({
        data: {
          files: [
            { id: 'ours', createdTime: '2026-08-14T20:25:33.000Z' },
            { id: 'theirs', createdTime: '2026-08-14T20:19:01.000Z' },
          ],
        },
      })
      .mockResolvedValueOnce({ data: { files: [{ id: 'a-verdict.yaml' }] } });
    fakeDrive.files.create.mockResolvedValue({ data: { id: 'ours', name: 'verdicts', webViewLink: 'u' } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'x' } });
    fakeDrive.files.get
      .mockResolvedValueOnce({ data: PARENT })
      .mockResolvedValueOnce({ data: { id: 'theirs', name: 'verdicts', webViewLink: 'v' } });

    const r = await handleCreateFolder(
      { name: 'verdicts', parentFolderId: 'parent-1' },
      fakeDrive as never,
    );
    expect(r.id).toBe('theirs');
    const trashed = fakeDrive.files.update.mock.calls
      .map(([a]) => a)
      .filter((a: { requestBody?: { trashed?: boolean } }) => a.requestBody?.trashed === true);
    expect(trashed).toEqual([]);
  });
});
