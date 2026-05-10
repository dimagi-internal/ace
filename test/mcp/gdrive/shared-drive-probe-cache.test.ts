/**
 * Tests for the inflight-dedupe + 30s TTL cache on
 * `assertParentOnSharedDrive`. Added 2026-05-10 as part of the perf lens —
 * the orchestrator's pre-flight checklist (PR 0a) encourages parallel
 * `drive_create_*` calls into the same parent (e.g. run-folder bootstrap
 * writes 3-5 files into one `runs/<run-id>/` parent). Without dedupe,
 * each parallel call fires its own redundant `files.get` probe; with it,
 * the first caller wins and concurrent callers await the same promise.
 *
 * The cache is a correctness-preserving optimization: every cached value
 * (`ok: true`) was observed live within the TTL window. `ok: false` is
 * intentionally NOT cached — transient errors must re-probe, and a
 * My-Drive misconfig halts the run anyway so caching it has no benefit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleCreateFile,
  __resetSharedDriveProbeCacheForTests,
} from '../../../mcp/google-drive-server.js';

const sharedFakeDrive = () => ({
  files: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
  },
});

describe('assertParentOnSharedDrive cache', () => {
  let fakeDrive: ReturnType<typeof sharedFakeDrive>;

  beforeEach(() => {
    __resetSharedDriveProbeCacheForTests();
    fakeDrive = sharedFakeDrive();
    fakeDrive.files.get.mockResolvedValue({
      data: { id: 'parent-1', name: 'parent', driveId: 'shared-drive-x', mimeType: 'application/vnd.google-apps.folder' },
    });
    // Default: list returns no existing files; create + update succeed.
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    fakeDrive.files.create.mockResolvedValue({ data: { id: 'new-id', name: 'foo' } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'new-id' } });
  });

  it('dedupes concurrent probes for the same parent (single files.get for N parallel writes)', async () => {
    const writes = Array.from({ length: 5 }, (_, i) =>
      handleCreateFile(
        { name: `file-${i}.md`, content: `body ${i}`, parentFolderId: 'parent-1', findOrCreate: true },
        fakeDrive as any,
      ),
    );
    await Promise.all(writes);
    // Without dedupe: 5 redundant files.get calls. With dedupe: exactly 1.
    expect(fakeDrive.files.get).toHaveBeenCalledTimes(1);
    expect(fakeDrive.files.create).toHaveBeenCalledTimes(5);
  });

  it('hits cache on sequential calls within TTL (single files.get for N sequential writes)', async () => {
    for (let i = 0; i < 4; i++) {
      await handleCreateFile(
        { name: `file-${i}.md`, content: `body ${i}`, parentFolderId: 'parent-1', findOrCreate: true },
        fakeDrive as any,
      );
    }
    expect(fakeDrive.files.get).toHaveBeenCalledTimes(1);
    expect(fakeDrive.files.create).toHaveBeenCalledTimes(4);
  });

  it('probes independently for different parents', async () => {
    fakeDrive.files.get.mockImplementation(async ({ fileId }: any) => ({
      data: { id: fileId, name: `parent-${fileId}`, driveId: 'shared-x', mimeType: 'application/vnd.google-apps.folder' },
    }));
    await handleCreateFile(
      { name: 'a.md', content: 'a', parentFolderId: 'parent-1', findOrCreate: true },
      fakeDrive as any,
    );
    await handleCreateFile(
      { name: 'b.md', content: 'b', parentFolderId: 'parent-2', findOrCreate: true },
      fakeDrive as any,
    );
    // Two distinct parents = two probes; same-parent dedupe doesn't apply across parents.
    expect(fakeDrive.files.get).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache failure results (every call re-probes when probe fails)', async () => {
    // First probe fails (My Drive); second probe also runs because failures
    // aren't cached.
    fakeDrive.files.get.mockResolvedValue({
      data: { id: 'parent-bad', name: 'parent-bad', driveId: null, mimeType: 'application/vnd.google-apps.folder' },
    });
    await expect(
      handleCreateFile(
        { name: 'a.md', content: 'a', parentFolderId: 'parent-bad', findOrCreate: true },
        fakeDrive as any,
      ),
    ).rejects.toThrow(/My Drive/);
    await expect(
      handleCreateFile(
        { name: 'b.md', content: 'b', parentFolderId: 'parent-bad', findOrCreate: true },
        fakeDrive as any,
      ),
    ).rejects.toThrow(/My Drive/);
    // Both calls re-probe — no false cache hit on the (broken) first result.
    expect(fakeDrive.files.get).toHaveBeenCalledTimes(2);
  });
});
