import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assertCreateFileMimeType,
  CREATE_FILE_MIME_TYPE,
  handleCreateFile,
  handleUploadBinary,
  __resetSharedDriveProbeCacheForTests,
} from '../../../mcp/google-drive-server.js';

//
// ace#1991 — `drive_create_file` ALWAYS creates a Google Doc.
//
// Six skills told their executor to write a `.source.md` companion "via
// drive_create_file with mimeType: 'text/markdown' ... NOT
// drive_create_doc_from_markdown — rendering the source copy converts it to a
// Doc as well and destroys the very bytes this step exists to preserve."
//
// There was no `mimeType` parameter, so the MCP schema dropped the key, and
// the handler converts unconditionally. The instruction reached the exact
// outcome it forbade, through the atom it named as the safe one. Measured on
// poverty-graduation/20260905-0924: both writes landed as
// application/vnd.google-apps.document; the round-trip was 58,470 bytes
// against 57,178 sent.
//
// The fix keeps ONE outcome per atom and makes the mistake loud, because
// `drive_upload_binary` already does the byte-preserving write — and
// `skills/_training-template.md` has prescribed it since 2026-09-01.
//
// The SKILL-side preventer lives with the contract it enforces, in
// `test/lib/source-persisted-artifacts.test.ts`: `PLAIN_WRITE_MARKERS` no
// longer accepts `drive_create_file`, and a new check refuses a `.source.md`
// instruction that names only a converting atom. This file covers the ATOM.
//

describe('assertCreateFileMimeType (ace#1991)', () => {
  const ctx = { name: 'idea-to-pdd.source.md', parentFolderId: 'folder-1' };

  it('accepts an omitted mimeType — every existing caller is untouched', () => {
    expect(() => assertCreateFileMimeType(undefined, ctx)).not.toThrow();
  });

  it('accepts the one mimeType this atom actually produces', () => {
    expect(() => assertCreateFileMimeType(CREATE_FILE_MIME_TYPE, ctx)).not.toThrow();
    expect(CREATE_FILE_MIME_TYPE).toBe('application/vnd.google-apps.document');
  });

  it('REFUSES text/markdown rather than dropping it — the whole defect', () => {
    expect(() => assertCreateFileMimeType('text/markdown', ctx)).toThrow(
      /cannot create 'text\/markdown'/,
    );
  });

  it('names drive_upload_binary in the refusal, as a call the caller can paste', () => {
    let message = '';
    try {
      assertCreateFileMimeType('text/markdown', { ...ctx, localFilePath: '/tmp/pdd.md' });
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toContain('drive_upload_binary({');
    expect(message).toContain("name: 'idea-to-pdd.source.md'");
    expect(message).toContain("localFilePath: '/tmp/pdd.md'");
    expect(message).toContain("mimeType: 'text/markdown'");
    expect(message).toContain("parentFolderId: 'folder-1'");
  });

  it('says WHY, so the caller does not simply try another text type', () => {
    let message = '';
    try {
      assertCreateFileMimeType('text/csv', ctx);
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toContain('does not ');
    expect(message).toMatch(/preserve bytes/);
    // The name is the reason nobody reached for it; say so at the error.
    expect(message).toContain('Despite the name');
  });

  it('refuses every non-Doc type, not just text/markdown', () => {
    for (const mt of ['text/plain', 'text/csv', 'application/json', 'application/pdf']) {
      expect(() => assertCreateFileMimeType(mt, ctx)).toThrow();
    }
  });
});

describe('handleCreateFile still creates a Google Doc, unconditionally', () => {
  const fakeDrive = {
    files: { list: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn() },
  };

  beforeEach(() => {
    __resetSharedDriveProbeCacheForTests();
    for (const fn of Object.values(fakeDrive.files)) (fn as any).mockReset();
    fakeDrive.files.get.mockResolvedValue({
      data: { id: 'parent-1', name: 'p', driveId: 'sd', mimeType: 'application/vnd.google-apps.folder' },
    });
  });

  it('posts the Doc mimeType — the behaviour the refusal is honest about', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    fakeDrive.files.create.mockResolvedValue({ data: { id: 'doc-1', name: 'x.source.md' } });
    fakeDrive.files.update.mockResolvedValue({ data: { id: 'doc-1' } });

    await handleCreateFile(
      { name: 'x.source.md', content: '# Heading\n\n**bold**', parentFolderId: 'parent-1', findOrCreate: false },
      fakeDrive as any,
    );

    expect(fakeDrive.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ mimeType: CREATE_FILE_MIME_TYPE }),
      }),
    );
  });
});

describe('handleUploadBinary is the byte-preserving path for text (ace#1991)', () => {
  const fakeDrive = {
    files: { list: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn() },
    permissions: { create: vi.fn() },
  };

  beforeEach(() => {
    __resetSharedDriveProbeCacheForTests();
    for (const fn of Object.values(fakeDrive.files)) (fn as any).mockReset();
    fakeDrive.permissions.create.mockReset();
    fakeDrive.files.get.mockResolvedValue({
      data: { id: 'parent-1', name: 'p', driveId: 'sd', mimeType: 'application/vnd.google-apps.folder' },
    });
  });

  it('lands a .source.md as text/markdown, not as a Google Doc', async () => {
    fakeDrive.files.list.mockResolvedValue({ data: { files: [] } });
    fakeDrive.files.create.mockResolvedValue({
      data: { id: 'md-1', name: 'idea-to-pdd.source.md', mimeType: 'text/markdown', size: '19' },
    });

    const r = await handleUploadBinary(
      {
        name: 'idea-to-pdd.source.md',
        buffer: Buffer.from('# Heading\n\n**bold**'),
        mimeType: 'text/markdown',
        parentFolderId: 'parent-1',
      },
      fakeDrive as any,
    );

    expect(r.mimeType).toBe('text/markdown');
    const call = fakeDrive.files.create.mock.calls[0][0];
    expect(call.requestBody.mimeType).toBe('text/markdown');
    expect(call.media.mimeType).toBe('text/markdown');
  });
});
