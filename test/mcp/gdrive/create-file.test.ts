import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateFile, __resetSharedDriveProbeCacheForTests } from '../../../mcp/google-drive-server.js';

const fakeDrive = {
  files: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
  },
};

describe('drive_create_file', () => {
  beforeEach(() => {
    __resetSharedDriveProbeCacheForTests();
    fakeDrive.files.list.mockReset();
    fakeDrive.files.create.mockReset();
    fakeDrive.files.update.mockReset();
    fakeDrive.files.get.mockReset();
    // Parent passes the Shared-Drive guard
    fakeDrive.files.get.mockResolvedValue({
      data: { id: 'parent-1', name: 'parent', driveId: 'shared-drive', mimeType: 'application/vnd.google-apps.folder' },
    });
  });

  describe('findOrCreate (default true)', () => {
    it('updates an existing same-name file and returns its id (reused: true)', async () => {
      fakeDrive.files.list.mockResolvedValue({
        data: { files: [{ id: 'existing-doc-id', name: 'summary.md', webViewLink: 'https://x/a' }] },
      });
      fakeDrive.files.update.mockResolvedValue({ data: { id: 'existing-doc-id' } });

      const r = await handleCreateFile(
        { name: 'summary.md', content: 'new content', parentFolderId: 'parent-1' },
        fakeDrive as any,
      );

      expect(r.id).toBe('existing-doc-id');
      expect(r.reused).toBe(true);
      expect(fakeDrive.files.create).not.toHaveBeenCalled();
      // Body was sent as utf-8
      expect(fakeDrive.files.update).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'existing-doc-id',
          media: { mimeType: 'text/plain; charset=utf-8', body: 'new content' },
        }),
      );
    });

    it('creates a new file when none exists with that name (reused: false)', async () => {
      fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
      fakeDrive.files.create.mockResolvedValue({
        data: { id: 'new-doc-id', name: 'summary.md', webViewLink: 'https://x/b' },
      });
      fakeDrive.files.update.mockResolvedValue({ data: { id: 'new-doc-id' } });

      const r = await handleCreateFile(
        { name: 'summary.md', content: 'fresh', parentFolderId: 'parent-1' },
        fakeDrive as any,
      );

      expect(r.id).toBe('new-doc-id');
      expect(r.reused).toBe(false);
      expect(fakeDrive.files.create).toHaveBeenCalledOnce();
    });

    it('defaults findOrCreate to true when not specified', async () => {
      fakeDrive.files.list.mockResolvedValue({
        data: { files: [{ id: 'existing-doc-id', name: 'summary.md' }] },
      });
      fakeDrive.files.update.mockResolvedValue({ data: { id: 'existing-doc-id' } });

      const r = await handleCreateFile(
        { name: 'summary.md', content: 'x', parentFolderId: 'parent-1' },
        fakeDrive as any,
      );
      expect(r.id).toBe('existing-doc-id');
      expect(r.reused).toBe(true);
      expect(fakeDrive.files.create).not.toHaveBeenCalled();
    });

    it('ignores same-name folders (mimeType filter excludes them)', async () => {
      // The list query already filters out folders via the q clause; verify
      // we're querying with the right q so a same-name folder under the parent
      // doesn't masquerade as a "found" file.
      fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
      fakeDrive.files.create.mockResolvedValue({
        data: { id: 'new-doc-id', name: 'reports', webViewLink: 'https://x/c' },
      });
      fakeDrive.files.update.mockResolvedValue({ data: { id: 'new-doc-id' } });

      await handleCreateFile(
        { name: 'reports', content: 'x', parentFolderId: 'parent-1' },
        fakeDrive as any,
      );
      expect(fakeDrive.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: expect.stringContaining("mimeType!='application/vnd.google-apps.folder'"),
        }),
      );
    });
  });

  describe('findOrCreate=false', () => {
    it('always creates a new sibling even when one exists', async () => {
      fakeDrive.files.list.mockResolvedValue({
        data: { files: [{ id: 'existing-doc-id', name: 'summary.md' }] },
      });
      fakeDrive.files.create.mockResolvedValue({
        data: { id: 'second-doc-id', name: 'summary.md', webViewLink: 'https://x/d' },
      });
      fakeDrive.files.update.mockResolvedValue({ data: { id: 'second-doc-id' } });

      const r = await handleCreateFile(
        { name: 'summary.md', content: 'x', parentFolderId: 'parent-1', findOrCreate: false },
        fakeDrive as any,
      );

      expect(r.id).toBe('second-doc-id');
      expect(r.reused).toBe(false);
      expect(fakeDrive.files.create).toHaveBeenCalledOnce();
      // No list call happens when findOrCreate is false (we skip the lookup)
      expect(fakeDrive.files.list).not.toHaveBeenCalled();
    });
  });

  describe('charset=utf-8 (regression: em-dash Internal Error)', () => {
    it('uploads body as text/plain; charset=utf-8 even with non-ASCII content', async () => {
      fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
      fakeDrive.files.create.mockResolvedValue({
        data: { id: 'new-doc-id', name: 'summary.md', webViewLink: 'https://x/e' },
      });
      fakeDrive.files.update.mockResolvedValue({ data: { id: 'new-doc-id' } });

      // Em-dash, smart quotes, accented char — all multi-byte UTF-8
      const body = '— "smart quotes" café';
      await handleCreateFile(
        { name: 'summary.md', content: body, parentFolderId: 'parent-1' },
        fakeDrive as any,
      );

      // The Doc body upload is the second files.update call (or the first if
      // we created fresh — there's only one update either way in this path).
      const updateCall = fakeDrive.files.update.mock.calls[0][0];
      expect(updateCall.media.mimeType).toBe('text/plain; charset=utf-8');
      expect(updateCall.media.body).toBe(body);
    });
  });

  // Background: jjackson/ace#106 finding 13 — `drive_create_file` for small
  // (<=2KB) files hit transient `Internal Error` 5xx's and the surface had
  // no retry. `drive_read_file` already had `withTransientRetry`; this
  // extends the same wrapper to the write paths so a single 503/500 doesn't
  // force callers to roll their own retry. Same backoff as reads (1s/2s/4s,
  // 3 attempts max).
  describe('5xx transient retry (regression: #106 finding 13)', () => {
    function makeRecordingSleep() {
      const delays: number[] = [];
      return {
        sleep: async (ms: number) => {
          delays.push(ms);
        },
        delays,
      };
    }

    it('retries handleCreateFile on transient 5xx and succeeds on the second attempt', async () => {
      const transient = Object.assign(new Error('Internal Error'), { code: 500 });
      // First list attempt fails 500, second succeeds with empty result.
      fakeDrive.files.list
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce({ data: { files: [] } });
      fakeDrive.files.create.mockResolvedValue({
        data: { id: 'new-id', name: 'a.md', webViewLink: 'https://x/a' },
      });
      fakeDrive.files.update.mockResolvedValue({ data: { id: 'new-id' } });

      const { sleep, delays } = makeRecordingSleep();
      const r = await handleCreateFile(
        { name: 'a.md', content: 'body', parentFolderId: 'parent-1' },
        fakeDrive as any,
        { sleep },
      );

      expect(r.id).toBe('new-id');
      expect(fakeDrive.files.list).toHaveBeenCalledTimes(2);
      expect(delays).toEqual([1000]); // one backoff before the second attempt
    });

    it('caps at 3 attempts and rethrows the final 5xx', async () => {
      const transient = Object.assign(new Error('Backend Error'), { code: 503 });
      fakeDrive.files.list.mockRejectedValue(transient);

      const { sleep, delays } = makeRecordingSleep();
      await expect(
        handleCreateFile(
          { name: 'a.md', content: 'body', parentFolderId: 'parent-1' },
          fakeDrive as any,
          { sleep },
        ),
      ).rejects.toThrow(/Backend Error/);
      // 2 sleeps before attempts 2 and 3; no sleep after the final failure.
      expect(delays).toEqual([1000, 2000]);
      expect(fakeDrive.files.list).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry permanent 4xx errors (rethrows immediately)', async () => {
      const permanent = Object.assign(new Error('Forbidden'), { code: 403 });
      fakeDrive.files.list.mockRejectedValue(permanent);

      const { sleep, delays } = makeRecordingSleep();
      await expect(
        handleCreateFile(
          { name: 'a.md', content: 'body', parentFolderId: 'parent-1' },
          fakeDrive as any,
          { sleep },
        ),
      ).rejects.toThrow(/Forbidden/);
      expect(fakeDrive.files.list).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]); // no sleep — not a transient class
    });
  });
});
