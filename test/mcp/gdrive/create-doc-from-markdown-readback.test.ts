import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  handleCreateDocFromMarkdown,
  markdownHasReadableText,
  __resetSharedDriveProbeCacheForTests,
} from '../../../mcp/google-drive-server.js';

/**
 * ace#2592 — the Phase 6 FAQ of spark-facilitator/20261001-2208 was published
 * as an EMPTY Google Doc and the atom reported success.
 *
 * Mechanism: `handleCreateDocFromMarkdown` built ONE `Readable` for the upload
 * body and handed the same object to every `withTransientRetry` attempt. A
 * Readable is single-use, so after a transient failure the retry uploaded an
 * exhausted stream — 0 bytes — which Drive imports as an empty Doc with a 200.
 * The live call took 96s (first attempt failed, retry "succeeded") and the Doc
 * read back at total_length 0.
 *
 * The fake Drive below CONSUMES the media stream the way the real HTTP client
 * does, so the pre-fix code reproduces the empty upload deterministically.
 */

const FAQ = '# FAQ\n\n**[FLW] Q: What do I read aloud before the photo?**\nThe photo statement on the screen.\n';

async function drain(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  const chunks: Buffer[] = [];
  for await (const c of body as Readable) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8');
}

/** A Drive whose imported Doc text is whatever bytes the LAST upload carried. */
function makeDrive(opts: { failFirstUpload?: boolean; existing?: boolean } = {}) {
  const uploads: string[] = [];
  let docText = '';
  let uploadCalls = 0;
  const upload = async (req: any) => {
    uploadCalls++;
    const bytes = await drain(req.media.body);
    uploads.push(bytes);
    if (opts.failFirstUpload && uploadCalls === 1) {
      throw Object.assign(new Error('Backend Error'), { code: 503 });
    }
    docText = bytes; // Drive imports exactly what it received
    return { data: { id: 'doc-1', name: 'training-faq.md', webViewLink: 'https://x/doc-1' } };
  };
  const drive = {
    files: {
      get: vi.fn().mockResolvedValue({
        data: { id: 'parent-1', driveId: 'sd', mimeType: 'application/vnd.google-apps.folder' },
      }),
      list: vi.fn().mockResolvedValue({
        data: {
          files: opts.existing
            ? [{ id: 'doc-1', name: 'training-faq.md', version: '8', modifiedTime: new Date().toISOString() }]
            : [],
        },
      }),
      update: vi.fn(upload),
      create: vi.fn(upload),
      export: vi.fn(async () => ({ data: docText })),
    },
  };
  return { drive, uploads };
}

const noSleep = { sleep: async () => {} };

beforeEach(() => {
  __resetSharedDriveProbeCacheForTests();
});

describe('drive_create_doc_from_markdown — a retried upload re-sends the whole body (ace#2592)', () => {
  it('find-or-update path: the retry after a 503 uploads the full markdown, not 0 bytes', async () => {
    const { drive, uploads } = makeDrive({ failFirstUpload: true, existing: true });
    const r = await handleCreateDocFromMarkdown(
      { name: 'training-faq.md', markdown: FAQ, parentFolderId: 'parent-1' },
      drive as any,
      noSleep,
    );
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toBe(FAQ);
    expect(uploads[1]).toBe(FAQ); // pre-fix: '' — the exhausted stream
    expect(r.reused).toBe(true);
    expect(r.readBackChars).toBe(FAQ.trim().length);
  });

  it('create path: same guarantee', async () => {
    const { drive, uploads } = makeDrive({ failFirstUpload: true, existing: false });
    const r = await handleCreateDocFromMarkdown(
      { name: 'training-faq.md', markdown: FAQ, parentFolderId: 'parent-1' },
      drive as any,
      noSleep,
    );
    expect(uploads.map((u) => u.length)).toEqual([FAQ.length, FAQ.length]);
    expect(r.reused).toBe(false);
  });

  it('control: no transient failure → exactly one upload, read back non-empty', async () => {
    const { drive, uploads } = makeDrive({ existing: true });
    const r = await handleCreateDocFromMarkdown(
      { name: 'training-faq.md', markdown: FAQ, parentFolderId: 'parent-1' },
      drive as any,
      noSleep,
    );
    expect(uploads).toEqual([FAQ]);
    expect(r.readBackChars).toBeGreaterThan(0);
  });
});

describe('drive_create_doc_from_markdown — an empty import is refused, not reported (ace#2592)', () => {
  function driveExporting(...reads: string[]) {
    const queue = [...reads];
    return {
      files: {
        get: vi.fn().mockResolvedValue({
          data: { id: 'parent-1', driveId: 'sd', mimeType: 'application/vnd.google-apps.folder' },
        }),
        list: vi.fn().mockResolvedValue({ data: { files: [{ id: 'doc-1', name: 'training-faq.md' }] } }),
        update: vi.fn().mockResolvedValue({ data: { id: 'doc-1' } }),
        create: vi.fn(),
        export: vi.fn(async () => ({ data: queue.length > 1 ? queue.shift() : queue[0] })),
      },
    };
  }

  it('non-empty markdown + Doc reads back empty twice → DOC_IMPORT_EMPTY', async () => {
    const drive = driveExporting('', '\n');
    await expect(
      handleCreateDocFromMarkdown(
        { name: 'training-faq.md', markdown: FAQ, parentFolderId: 'parent-1' },
        drive as any,
        noSleep,
      ),
    ).rejects.toThrow(/DOC_IMPORT_EMPTY.*training-faq\.md.*doc-1/s);
    expect(drive.files.export).toHaveBeenCalledTimes(2);
  });

  it('control: an empty first read followed by text (read raced the import) succeeds', async () => {
    const drive = driveExporting('', 'FAQ\nWhat do I read aloud?');
    const r = await handleCreateDocFromMarkdown(
      { name: 'training-faq.md', markdown: FAQ, parentFolderId: 'parent-1' },
      drive as any,
      noSleep,
    );
    expect(r.readBackChars).toBeGreaterThan(0);
  });

  it('control: markup-only markdown may legitimately import empty — no refusal', async () => {
    const drive = driveExporting('');
    const r = await handleCreateDocFromMarkdown(
      { name: 'rule.md', markdown: '---\n\n', parentFolderId: 'parent-1' },
      drive as any,
      noSleep,
    );
    expect(r.readBackChars).toBe(0);
    expect(drive.files.export).toHaveBeenCalledTimes(1);
  });
});

describe('markdownHasReadableText', () => {
  it('needs a letter or digit, in any script', () => {
    expect(markdownHasReadableText('# FAQ')).toBe(true);
    expect(markdownHasReadableText('| 1 |')).toBe(true);
    expect(markdownHasReadableText('## Maswali')).toBe(true);
    expect(markdownHasReadableText('—')).toBe(false);
    expect(markdownHasReadableText('---\n***\n')).toBe(false);
    expect(markdownHasReadableText('')).toBe(false);
  });
});
