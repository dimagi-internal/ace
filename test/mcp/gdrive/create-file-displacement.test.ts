import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleCreateFile,
  handleCreateDocFromMarkdown,
  __resetSharedDriveProbeCacheForTests,
} from '../../../mcp/google-drive-server.js';

/**
 * ace#2338 — a find-or-update reuse REPLACES another writer's content, and
 * `reused: true` was the entire signal it returned.
 *
 * Measured instance: `spark-facilitator/20260909-1211` Phase 8. An independent
 * `solicitation-create-eval` verdict (9.17, `pass`) was overwritten by the
 * producer's own self-eval of the same solicitation (8.86), because the
 * producer had polled the phase folder for ~65 minutes, concluded the
 * dispatched grader had stalled, and ran the rubric inline as a fallback. Both
 * wrote the same filename into the same folder.
 *
 * These tests fail against the pre-fix tree: `displaced` did not exist, and
 * `expectAbsent` was neither a parameter nor a behaviour.
 */

const EXISTING = {
  id: '1i6kTt6EuRtdvjRMfA0vGTc5Qg3g4C1xNKecwMLxDzB0',
  name: 'solicitation-create-eval_verdict.yaml',
  webViewLink: 'https://docs.google.com/document/d/1i6kTt6E/edit',
  version: '7',
  modifiedTime: new Date(Date.now() - 180_000).toISOString(),
  lastModifyingUser: { displayName: 'ACE SA', emailAddress: 'ace-sa@x.iam.gserviceaccount.com' },
};

const fakeDrive = {
  files: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
  },
};

beforeEach(() => {
  __resetSharedDriveProbeCacheForTests();
  fakeDrive.files.list.mockReset();
  fakeDrive.files.create.mockReset();
  fakeDrive.files.update.mockReset();
  fakeDrive.files.get.mockReset();
  fakeDrive.files.get.mockResolvedValue({
    data: {
      id: 'parent-1',
      name: '8-solicitation-management',
      driveId: 'shared-drive',
      mimeType: 'application/vnd.google-apps.folder',
    },
  });
});

describe('drive_create_file — a reuse reports what it displaced (ace#2338)', () => {
  it('returns displaced{} naming the revision, age and principal it overwrote', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: EXISTING.id } });

    const r = await handleCreateFile(
      {
        name: EXISTING.name,
        content: 'overall: 8.86\nverdict: pass\n',
        parentFolderId: 'parent-1',
      },
      fakeDrive as any,
    );

    expect(r.reused).toBe(true);
    expect(r.displaced).toBeDefined();
    expect(r.displaced!.revisionVersion).toBe('7');
    expect(r.displaced!.modifiedTime).toBe(EXISTING.modifiedTime);
    // ~180s ago: the number that distinguishes "my own retry" from "a grader
    // finished while I was writing my fallback".
    expect(r.displaced!.ageSeconds).toBeGreaterThanOrEqual(179);
    expect(r.displaced!.ageSeconds).toBeLessThanOrEqual(182);
    expect(r.displaced!.lastModifiedBy).toBe('ace-sa@x.iam.gserviceaccount.com');
    expect(r.displaced!.note).toMatch(/REPLACED/);
  });

  it('asks the lookup for the fields the report needs', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: EXISTING.id } });

    await handleCreateFile(
      { name: EXISTING.name, content: 'x', parentFolderId: 'parent-1' },
      fakeDrive as any,
    );

    const q = fakeDrive.files.list.mock.calls[0][0];
    expect(q.fields).toContain('version');
    expect(q.fields).toContain('modifiedTime');
    expect(q.fields).toContain('lastModifyingUser');
  });

  it('costs ZERO extra Drive calls — the fields ride on the existing lookup', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: EXISTING.id } });

    await handleCreateFile(
      { name: EXISTING.name, content: 'x', parentFolderId: 'parent-1' },
      fakeDrive as any,
    );

    // One list (the find-or-update lookup) and one get (the Shared-Drive
    // parent guard, which predates this change). No metadata round-trip was
    // added to the hot path of every ACE write.
    expect(fakeDrive.files.list).toHaveBeenCalledTimes(1);
    expect(fakeDrive.files.get).toHaveBeenCalledTimes(1);
    expect(fakeDrive.files.update).toHaveBeenCalledTimes(1);
  });

  it('reports no displacement on a genuine first write', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'new-doc', name: EXISTING.name, webViewLink: 'https://x/new' },
    });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'new-doc' } });

    const r = await handleCreateFile(
      { name: EXISTING.name, content: 'x', parentFolderId: 'parent-1' },
      fakeDrive as any,
    );

    expect(r.reused).toBe(false);
    expect(r.displaced).toBeUndefined();
  });

  it('reports the displacement on the lost-race adopt path too (ace#1417 + ace#2338)', async () => {
    // We create, then the reconcile pass finds an older sibling another writer
    // created in the window: we adopt theirs and trash ours. That adoption
    // overwrites THEIR content, so it displaces exactly as a reuse does.
    const theirs = {
      ...EXISTING,
      id: 'theirs',
      createdTime: '2026-09-09T12:00:00.000Z',
      version: '4',
    };
    fakeDrive.files.list
      .mockResolvedValueOnce({ data: { files: [] } })                       // pre-create lookup
      .mockResolvedValueOnce({                                              // reconcile listing
        data: { files: [theirs, { id: 'ours', createdTime: '2026-09-09T12:10:00.000Z' }] },
      });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'ours', name: EXISTING.name, webViewLink: 'https://x/ours' },
    });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'ok' } });
    fakeDrive.files.get.mockImplementation(async (a: any) =>
      a.fileId === 'theirs'
        ? { data: { id: 'theirs', name: EXISTING.name, webViewLink: 'https://x/theirs' } }
        : {
            data: {
              id: 'parent-1', name: 'p', driveId: 'shared-drive',
              mimeType: 'application/vnd.google-apps.folder',
            },
          },
    );

    const r = await handleCreateFile(
      { name: EXISTING.name, content: 'x', parentFolderId: 'parent-1' },
      fakeDrive as any,
    );

    expect(r.id).toBe('theirs');
    expect(r.reused).toBe(true);
    expect(r.displaced?.revisionVersion).toBe('4');
  });
});

describe('drive_create_file — expectAbsent refuses instead of overwriting (ace#2338)', () => {
  it('throws naming the existing file, and writes NOTHING', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });

    await expect(
      handleCreateFile(
        {
          name: EXISTING.name,
          content: 'overall: 8.86\n',
          parentFolderId: 'parent-1',
          expectAbsent: true,
        },
        fakeDrive as any,
      ),
    ).rejects.toThrow(/ALREADY EXISTS/);

    // The whole point: the independent verdict survives.
    expect(fakeDrive.files.update).not.toHaveBeenCalled();
    expect(fakeDrive.files.create).not.toHaveBeenCalled();
  });

  it('carries the id and revision so the caller can read what beat it', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });
    const err = await handleCreateFile(
      { name: EXISTING.name, content: 'x', parentFolderId: 'parent-1', expectAbsent: true },
      fakeDrive as any,
    ).catch((e) => e);
    expect(err.message).toContain(EXISTING.id);
    expect(err.message).toContain('revision=7');
  });

  it('proceeds normally when the name really is free', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'new-doc', name: EXISTING.name, webViewLink: 'https://x/new' },
    });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'new-doc' } });

    const r = await handleCreateFile(
      { name: EXISTING.name, content: 'x', parentFolderId: 'parent-1', expectAbsent: true },
      fakeDrive as any,
    );
    expect(r.id).toBe('new-doc');
    expect(r.reused).toBe(false);
  });

  it('still fires with findOrCreate:false — it is an assertion about the NAME', async () => {
    // findOrCreate:false would otherwise create a silent second sibling that
    // the name-matching verify_phase_artifacts fence counts twice (ace#1324).
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });
    await expect(
      handleCreateFile(
        {
          name: EXISTING.name, content: 'x', parentFolderId: 'parent-1',
          findOrCreate: false, expectAbsent: true,
        },
        fakeDrive as any,
      ),
    ).rejects.toThrow(/ALREADY EXISTS/);
    expect(fakeDrive.files.create).not.toHaveBeenCalled();
  });
});

describe('the default path is unchanged — legitimate re-writes must not break', () => {
  it('findOrCreate still overwrites and returns the same id', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: EXISTING.id } });

    const r = await handleCreateFile(
      { name: EXISTING.name, content: 'second draft', parentFolderId: 'parent-1' },
      fakeDrive as any,
    );

    expect(r.id).toBe(EXISTING.id);
    expect(r.reused).toBe(true);
    expect(fakeDrive.files.update).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: EXISTING.id,
        media: { mimeType: 'text/plain; charset=utf-8', body: 'second draft' },
      }),
    );
  });

  it('findOrCreate:false without expectAbsent still skips the lookup entirely', async () => {
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'sibling', name: EXISTING.name, webViewLink: 'https://x/s' },
    });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'sibling' } });

    const r = await handleCreateFile(
      { name: EXISTING.name, content: 'x', parentFolderId: 'parent-1', findOrCreate: false },
      fakeDrive as any,
    );
    expect(r.id).toBe('sibling');
    expect(fakeDrive.files.list).not.toHaveBeenCalled();
  });
});

describe('drive_create_doc_from_markdown — same contract (ace#2338)', () => {
  it('reports the displacement on reuse', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: EXISTING.id } });

    const r = await handleCreateDocFromMarkdown(
      { name: EXISTING.name, markdown: '# new', parentFolderId: 'parent-1' },
      fakeDrive as any,
    );

    expect(r.reused).toBe(true);
    expect(r.displaced?.revisionVersion).toBe('7');
    expect(r.displaced?.lastModifiedBy).toBe('ace-sa@x.iam.gserviceaccount.com');
  });

  it('refuses under expectAbsent without writing', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [EXISTING] } });
    await expect(
      handleCreateDocFromMarkdown(
        { name: EXISTING.name, markdown: '# new', parentFolderId: 'parent-1', expectAbsent: true },
        fakeDrive as any,
      ),
    ).rejects.toThrow(/drive_create_doc_from_markdown.*ALREADY EXISTS/s);
    expect(fakeDrive.files.update).not.toHaveBeenCalled();
    expect(fakeDrive.files.create).not.toHaveBeenCalled();
  });

  it('reports nothing displaced on a fresh create', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'new-md', name: EXISTING.name, webViewLink: 'https://x/md' },
    });

    const r = await handleCreateDocFromMarkdown(
      { name: EXISTING.name, markdown: '# new', parentFolderId: 'parent-1' },
      fakeDrive as any,
    );
    expect(r.reused).toBe(false);
    expect(r.displaced).toBeUndefined();
  });
});
