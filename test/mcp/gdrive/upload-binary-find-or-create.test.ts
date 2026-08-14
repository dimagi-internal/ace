/**
 * dimagi-internal/ace#1324 — every other Drive *create* atom defaults to
 * find-or-create; `drive_upload_binary` had no such parameter at all, so a
 * corrected re-upload of the same artifact left TWO live files in the phase
 * folder instead of replacing one.
 *
 * Hit live on bednet-check-2-visit/20260814-0856, Phase 2: an upload of
 * `pdd-to-app-journeys.md` returned id `1ec8uHrU…`; a one-word fix and a
 * byte-identical re-call returned `1SIz_Utw…`. Two non-trashed files with the
 * same name under `2-scenarios/`, caught only because the response carried an
 * unexpected id.
 *
 * It matters past the stray file: `verify_phase_artifacts` walks the phase
 * folder and matches by NAME, so both copies satisfy "present" and the fence
 * passes while a name-based read downstream may resolve either one. For a
 * Phase 2 artifact that is Phase 3/6 ground truth, the stale copy is a silent
 * wrong answer.
 *
 * `drive_create_folder`'s own description says it exists to close "the
 * duplicate-`verdicts/` class of bug from parallel skill writes" — the same
 * class, on the one create atom that never got the treatment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUploadBinary } from '../../../mcp/google-drive-server.js';

function fakeDrive(existing: Array<{ id: string; name: string }> = []) {
  return {
    files: {
      // assertParentOnSharedDrive reads the parent's metadata first.
      get: vi.fn(async () => ({ data: { id: 'parent', driveId: 'shared-drive-1', mimeType: 'application/vnd.google-apps.folder' } })),
      list: vi.fn(async (_args?: any) => ({ data: { files: existing } })),
      create: vi.fn(async () => ({ data: { id: 'NEW', name: 'a.md', mimeType: 'text/markdown', size: '3' } })),
      update: vi.fn(async () => ({ data: { id: existing[0]?.id, name: existing[0]?.name, mimeType: 'text/markdown', size: '3' } })),
    },
    permissions: { create: vi.fn(async () => ({ data: {} })) },
  };
}

const args = {
  name: 'pdd-to-app-journeys.md',
  mimeType: 'text/markdown',
  parentFolderId: 'parent',
  buffer: Buffer.from('abc'),
};

describe('drive_upload_binary find-or-create (#1324)', () => {
  let d: ReturnType<typeof fakeDrive>;

  it('replaces the bytes of a same-name sibling instead of minting a duplicate', async () => {
    d = fakeDrive([{ id: 'EXISTING', name: 'pdd-to-app-journeys.md' }]);
    const r = await handleUploadBinary(args, d as any);
    expect(d.files.create).not.toHaveBeenCalled();
    expect(d.files.update).toHaveBeenCalledOnce();
    expect(r.id).toBe('EXISTING');
    expect(r.reused).toBe(true);
  });

  it('creates when nothing with that name is there', async () => {
    d = fakeDrive([]);
    const r = await handleUploadBinary(args, d as any);
    expect(d.files.create).toHaveBeenCalledOnce();
    expect(r.id).toBe('NEW');
    expect(r.reused).toBeFalsy();
  });

  it('findOrCreate:false still forces a new sibling, and skips the lookup entirely', async () => {
    d = fakeDrive([{ id: 'EXISTING', name: 'pdd-to-app-journeys.md' }]);
    const r = await handleUploadBinary({ ...args, findOrCreate: false }, d as any);
    expect(d.files.list).not.toHaveBeenCalled();
    expect(d.files.create).toHaveBeenCalledOnce();
    expect(r.id).toBe('NEW');
  });

  it('never matches a FOLDER of the same name', async () => {
    d = fakeDrive([]);
    await handleUploadBinary(args, d as any);
    const q = (d.files.list.mock.calls[0]?.[0] as any)?.q ?? '';
    expect(q).toMatch(/mimeType!='application\/vnd\.google-apps\.folder'/);
    expect(q).toMatch(/trashed=false/);
  });

  it('still applies shareAnyoneWithLink on the REUSED file', async () => {
    d = fakeDrive([{ id: 'EXISTING', name: 'pdd-to-app-journeys.md' }]);
    const r = await handleUploadBinary({ ...args, shareAnyoneWithLink: true }, d as any);
    expect(d.permissions.create).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'EXISTING' }),
    );
    expect(r.sharing).toBe('anyone-with-link');
  });

  it("escapes a quote in the name so the Drive query can't be broken", async () => {
    d = fakeDrive([]);
    await handleUploadBinary({ ...args, name: "worker's guide.pdf" }, d as any);
    expect((d.files.list.mock.calls[0]?.[0] as any).q).toContain("worker\\'s guide.pdf");
  });
});
