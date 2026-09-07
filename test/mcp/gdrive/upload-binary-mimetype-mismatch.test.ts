/**
 * ace#2102 — the ace#1991 `.source.md` remedy did not survive a RE-RUN.
 *
 * #1991 (PR #2073) found the constraint was caller-side and repointed six
 * producers from `drive_create_file` at `drive_upload_binary`. That is right,
 * and it is right only for a FIRST write into a clean folder. Every re-run of
 * a phase writes into a folder that already holds the previous run's file of
 * that name — and `handleUploadBinary`'s find-or-create reuse replaced its
 * BYTES via a media update, which cannot retype a file. Correct
 * `text/markdown` bytes landed inside a Google Doc, Drive re-ran them through
 * the Docs importer, and the call returned 200. A *create* is not an *update*.
 *
 * Reproduced live on 2026-09-07 against `origin/main` (0.13.1296), through
 * the shipped MCP, in a scratch folder on the ACE Shared Drive:
 *
 *   drive_create_file({name:'probe.source.md', content:'# Heading one\n\n**bold** …'})
 *     -> id 1q8Wde9t…, application/vnd.google-apps.document
 *   drive_upload_binary({name:'probe.source.md', mimeType:'text/markdown', …})
 *     -> {"id":"1q8Wde9t…","mimeType":"application/vnd.google-apps.document",
 *         "size":"1024","reused":true}          <-- success, wrong type
 *   drive_read_file(1q8Wde9t…)
 *     -> "Heading one\r\nbold and a list:\r\n\r\n\r\n* alpha\r\n* beta"
 *        (every `#`, `**` and `-` marker gone; 50 chars for a 52-byte source)
 *
 * And the remedy, same folder, same call:
 *
 *   drive_trash_file(1q8Wde9t…) ; drive_upload_binary(… same args …)
 *     -> {"id":"1OSxL-lI…","mimeType":"text/markdown","size":"52"}
 *   drive_upload_binary(… same name, text/markdown, 53 bytes …)
 *     -> {"id":"1OSxL-lI…","mimeType":"text/markdown","size":"53","reused":true}
 *
 * so a matching-type reuse still preserves the id, and only a MISMATCH needs
 * the swap. Both branches are asserted below.
 *
 * ## Why PR #2073's ratchet could not see this
 *
 * `test/lib/source-persisted-artifacts.test.ts` is a static scan of SKILL
 * prose: it asks whether a `.source.md` instruction names a byte-preserving
 * atom. After #2073 all six producers name `drive_upload_binary`, so it is
 * green — correctly. The defect is entirely inside the atom, on the second
 * call, and no amount of reading the skills can reach it. That is the half
 * this file covers.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleUploadBinary,
  reuseHonoursMimeType,
  normalizeMimeType,
} from '../../../mcp/google-drive-server.js';

const DOC = 'application/vnd.google-apps.document';

function fakeDrive(existing: Array<{ id: string; name: string; mimeType?: string }> = []) {
  return {
    files: {
      get: vi.fn(async () => ({
        data: { id: 'parent', driveId: 'shared-drive-1', mimeType: 'application/vnd.google-apps.folder' },
      })),
      list: vi.fn(async (_args?: any) => ({ data: { files: existing } })),
      create: vi.fn(async (_args?: any) => ({
        data: { id: 'FRESH', name: 'training-faq.source.md', mimeType: 'text/markdown', size: '52' },
      })),
      update: vi.fn(async (_args?: any) => ({
        data: { id: existing[0]?.id, name: existing[0]?.name, mimeType: existing[0]?.mimeType, size: '52' },
      })),
    },
    permissions: { create: vi.fn(async () => ({ data: {} })) },
  };
}

const args = {
  name: 'training-faq.source.md',
  mimeType: 'text/markdown',
  parentFolderId: 'parent',
  buffer: Buffer.from('# Heading one\n'),
};

describe('reuseHonoursMimeType', () => {
  it('refuses the reuse when the existing file is a Google Doc — the whole defect', () => {
    expect(reuseHonoursMimeType(DOC, 'text/markdown')).toBe(false);
  });

  it('allows the reuse when the types match, so #1324 id-preservation survives', () => {
    expect(reuseHonoursMimeType('text/markdown', 'text/markdown')).toBe(true);
  });

  it('ignores charset parameters rather than reading them as a mismatch', () => {
    expect(reuseHonoursMimeType('text/markdown; charset=utf-8', 'text/markdown')).toBe(true);
    expect(reuseHonoursMimeType('TEXT/Markdown', 'text/markdown')).toBe(true);
  });

  it('treats an ABSENT type as a mismatch — an unprovable reuse is what shipped', () => {
    expect(reuseHonoursMimeType(undefined, 'text/markdown')).toBe(false);
    expect(reuseHonoursMimeType('', 'text/markdown')).toBe(false);
  });

  it('normalizes to the essence only', () => {
    expect(normalizeMimeType('  Text/Markdown ; charset=utf-8 ')).toBe('text/markdown');
    expect(normalizeMimeType(null)).toBe('');
  });
});

describe('drive_upload_binary type-mismatched reuse (ace#2102)', () => {
  it('does NOT replace the bytes of a same-name Google Doc', async () => {
    const d = fakeDrive([{ id: 'STALE_DOC', name: 'training-faq.source.md', mimeType: DOC }]);
    await handleUploadBinary(args, d as any);
    // The only update is the bin; no media ever goes into the Doc.
    const mediaUpdates = d.files.update.mock.calls.filter((c: any[]) => (c[0] as any)?.media);
    expect(mediaUpdates).toHaveLength(0);
  });

  it('bins the mismatched file and creates a fresh one at the requested type', async () => {
    const d = fakeDrive([{ id: 'STALE_DOC', name: 'training-faq.source.md', mimeType: DOC }]);
    const r = await handleUploadBinary(args, d as any);
    expect(d.files.update).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'STALE_DOC', requestBody: { trashed: true } }),
    );
    expect(d.files.create).toHaveBeenCalledOnce();
    expect(r.id).toBe('FRESH');
    expect(r.mimeType).toBe('text/markdown');
  });

  it('bins BEFORE it creates, so a failure leaves zero files rather than two', async () => {
    const order: string[] = [];
    const d = fakeDrive([{ id: 'STALE_DOC', name: 'training-faq.source.md', mimeType: DOC }]);
    d.files.update.mockImplementation(async () => {
      order.push('trash');
      return { data: {} } as any;
    });
    d.files.create.mockImplementation(async () => {
      order.push('create');
      return { data: { id: 'FRESH', name: args.name, mimeType: 'text/markdown', size: '52' } } as any;
    });
    await handleUploadBinary(args, d as any);
    expect(order).toEqual(['trash', 'create']);
  });

  it('reports the swap instead of performing it silently', async () => {
    const d = fakeDrive([{ id: 'STALE_DOC', name: 'training-faq.source.md', mimeType: DOC }]);
    const r = await handleUploadBinary(args, d as any);
    expect(r.replacedMismatchedType).toEqual({
      from: DOC,
      to: 'text/markdown',
      trashedFileId: 'STALE_DOC',
    });
    expect(r.reused).toBeFalsy();
  });

  it('asks Drive for the mimeType field — without it the check cannot run', async () => {
    const d = fakeDrive([]);
    await handleUploadBinary(args, d as any);
    expect((d.files.list.mock.calls[0]?.[0] as any).fields).toContain('mimeType');
  });

  it('leaves a MATCHING-type reuse exactly as #1324 built it: same id, no bin, no create', async () => {
    const d = fakeDrive([{ id: 'GOOD_MD', name: 'training-faq.source.md', mimeType: 'text/markdown' }]);
    const r = await handleUploadBinary(args, d as any);
    expect(d.files.create).not.toHaveBeenCalled();
    expect(d.files.update).toHaveBeenCalledOnce();
    expect((d.files.update.mock.calls[0]?.[0] as any).media).toBeTruthy();
    expect(r.id).toBe('GOOD_MD');
    expect(r.reused).toBe(true);
    expect(r.replacedMismatchedType).toBeUndefined();
  });

  it('still swaps for a non-Google mismatch — a PNG slot holding a JPEG', async () => {
    const d = fakeDrive([{ id: 'WRONG_IMG', name: 'screen-01.png', mimeType: 'image/jpeg' }]);
    const r = await handleUploadBinary(
      { ...args, name: 'screen-01.png', mimeType: 'image/png' },
      d as any,
    );
    expect(r.replacedMismatchedType?.from).toBe('image/jpeg');
    expect(d.files.create).toHaveBeenCalledOnce();
  });

  it('applies shareAnyoneWithLink to the NEW file, not the binned one', async () => {
    const d = fakeDrive([{ id: 'STALE_DOC', name: 'training-faq.source.md', mimeType: DOC }]);
    const r = await handleUploadBinary({ ...args, shareAnyoneWithLink: true }, d as any);
    expect(d.permissions.create).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'FRESH' }));
    expect(r.sharing).toBe('anyone-with-link');
  });
});
