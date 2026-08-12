import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  handleReadFile,
  handleReadFileToDisk,
  DEFAULT_INLINE_MAX_CHARS,
} from '../../../mcp/google-drive-server.js';

// Same fake-drive shape as read-file-retry.test.ts: queued responses, one
// shift per call.
function makeFakeDrive() {
  const getQueue: Array<() => any> = [];
  const exportQueue: Array<() => any> = [];
  return {
    queueGet(fn: () => any) { getQueue.push(fn); },
    queueExport(fn: () => any) { exportQueue.push(fn); },
    files: {
      get: vi.fn(async () => {
        const fn = getQueue.shift();
        if (!fn) throw new Error('files.get called more times than queued');
        return fn();
      }),
      export: vi.fn(async () => {
        const fn = exportQueue.shift();
        if (!fn) throw new Error('files.export called more times than queued');
        return fn();
      }),
    },
  };
}

const sleep = () => Promise.resolve();

/** Queue a text/plain file whose alt:media body is `body`. */
function queueTextFile(fake: ReturnType<typeof makeFakeDrive>, body: string) {
  fake.queueGet(() => ({ data: { mimeType: 'text/plain', name: 'a.txt', version: '7' } }));
  fake.queueGet(() => ({ data: body }));
}

/** Queue a Google Doc whose text/plain export is `body`. */
function queueGoogleDoc(fake: ReturnType<typeof makeFakeDrive>, body: string) {
  fake.queueGet(() => ({
    data: { mimeType: 'application/vnd.google-apps.document', name: 'd.doc', version: '3' },
  }));
  fake.queueExport(() => ({ data: body }));
}

describe('drive_read_file: character-range paging', () => {
  let fake: ReturnType<typeof makeFakeDrive>;

  beforeEach(() => {
    fake = makeFakeDrive();
  });

  it('returns the whole document and range metadata when no range is given', async () => {
    queueTextFile(fake, 'hello world');
    const r = await handleReadFile({ fileId: 'f1' }, fake as any, { sleep });

    expect(r.content).toBe('hello world');
    expect(r.total_length).toBe(11);
    expect(r.offset).toBe(0);
    expect(r.returned_length).toBe(11);
    expect(r.has_more).toBe(false);
    // Back-compat: the pre-paging fields are untouched.
    expect(r.name).toBe('a.txt');
    expect(r.mimeType).toBe('text/plain');
    expect(r.revisionVersion).toBe('7');
  });

  it('slices to `limit` and reports has_more', async () => {
    queueTextFile(fake, 'abcdefghij');
    const r = await handleReadFile({ fileId: 'f1', limit: 4 }, fake as any, { sleep });

    expect(r.content).toBe('abcd');
    expect(r.total_length).toBe(10);
    expect(r.offset).toBe(0);
    expect(r.returned_length).toBe(4);
    expect(r.has_more).toBe(true);
  });

  it('honors `offset` and clears has_more on the final page', async () => {
    queueTextFile(fake, 'abcdefghij');
    const r = await handleReadFile({ fileId: 'f1', offset: 8, limit: 4 }, fake as any, { sleep });

    expect(r.content).toBe('ij');
    expect(r.offset).toBe(8);
    expect(r.returned_length).toBe(2);
    expect(r.has_more).toBe(false);
  });

  it('walks a document end to end with no gaps or overlaps', async () => {
    const body = 'x'.repeat(250) + 'TAIL';
    let offset = 0;
    let assembled = '';
    let guard = 0;

    // Re-queue per page: each call is an independent read of the same file.
    for (;;) {
      if (++guard > 20) throw new Error('paging did not terminate');
      queueTextFile(fake, body);
      const r = await handleReadFile({ fileId: 'f1', offset, limit: 100 }, fake as any, { sleep });
      assembled += r.content;
      expect(r.total_length).toBe(body.length);
      if (!r.has_more) break;
      offset += r.returned_length;
    }

    expect(assembled).toBe(body);
    expect(guard).toBe(3); // 100 + 100 + 54
  });

  it('returns empty content (not an error) when offset is past the end', async () => {
    queueTextFile(fake, 'abc');
    const r = await handleReadFile({ fileId: 'f1', offset: 99, limit: 10 }, fake as any, { sleep });

    expect(r.content).toBe('');
    expect(r.total_length).toBe(3);
    expect(r.returned_length).toBe(0);
    expect(r.has_more).toBe(false);
  });

  it('pages the Google Doc export branch identically', async () => {
    queueGoogleDoc(fake, 'doc body here');
    const r = await handleReadFile({ fileId: 'doc1', offset: 4, limit: 4 }, fake as any, { sleep });

    expect(r.content).toBe('body');
    expect(r.total_length).toBe(13);
    expect(r.has_more).toBe(true);
  });

  it('rejects a negative offset and a non-positive limit', async () => {
    queueTextFile(fake, 'abc');
    await expect(handleReadFile({ fileId: 'f1', offset: -1 }, fake as any, { sleep })).rejects.toThrow(
      /invalid_range/,
    );
    queueTextFile(fake, 'abc');
    await expect(handleReadFile({ fileId: 'f1', limit: 0 }, fake as any, { sleep })).rejects.toThrow(
      /invalid_range/,
    );
  });
});

describe('drive_read_file: oversized-inline refusal', () => {
  let fake: ReturnType<typeof makeFakeDrive>;

  beforeEach(() => {
    fake = makeFakeDrive();
  });

  // The failure this whole change exists to fix: file 1lgXFJ0-wGlSPpRPNRv7pTUriTljXnUZ1
  // returned 68,470 characters and blew the tool-result token budget in three
  // independent sessions with no way to ask for less.
  it('refuses a whole-document read over maxChars with a typed oversized_document error', async () => {
    queueTextFile(fake, 'x'.repeat(68_470));
    await expect(
      handleReadFile({ fileId: 'f1', maxChars: 40_000 }, fake as any, { sleep }),
    ).rejects.toThrow(/oversized_document/);
  });

  it('names both escape hatches, and the actual + allowed sizes', async () => {
    queueTextFile(fake, 'x'.repeat(68_470));
    const err = await handleReadFile({ fileId: 'f1', maxChars: 40_000 }, fake as any, { sleep })
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/writeToPath/);
    expect(msg).toMatch(/offset/);
    expect(msg).toMatch(/limit/);
    expect(msg).toMatch(/68470|68,470/);
    expect(msg).toMatch(/40000|40,000/);
  });

  it('applies the cap to the returned slice, not the whole document', async () => {
    // A slice at or under the cap is fine even though the document is huge.
    queueTextFile(fake, 'x'.repeat(68_470));
    const r = await handleReadFile(
      { fileId: 'f1', limit: 40_000, maxChars: 40_000 },
      fake as any,
      { sleep },
    );
    expect(r.returned_length).toBe(40_000);
    expect(r.has_more).toBe(true);

    // ...and an over-cap slice is refused even though a limit was supplied,
    // so `limit` can't be used to smuggle past the boundary.
    queueTextFile(fake, 'x'.repeat(68_470));
    await expect(
      handleReadFile({ fileId: 'f1', limit: 50_000, maxChars: 40_000 }, fake as any, { sleep }),
    ).rejects.toThrow(/oversized_document/);
  });

  // The five in-process callers (validate_run_state, classify_phase_writeback,
  // verify_phase_products, update_yaml_file, render_decisions_log) never put
  // content into model context, so the cap must be opt-in — enforcing it
  // inside handleReadFile unconditionally would break them on a large
  // run_state.yaml.
  it('does NOT enforce a cap when maxChars is omitted (in-process callers)', async () => {
    queueTextFile(fake, 'x'.repeat(500_000));
    const r = await handleReadFile({ fileId: 'f1' }, fake as any, { sleep });
    expect(r.content.length).toBe(500_000);
    expect(r.has_more).toBe(false);
  });

  it('exports a default cap that is well under the failing size', () => {
    expect(DEFAULT_INLINE_MAX_CHARS).toBeGreaterThan(0);
    expect(DEFAULT_INLINE_MAX_CHARS).toBeLessThan(68_470);
  });

  // The atom's prose states the cap as a literal, because a template-literal
  // description leaks `\`` escapes and un-evaluated `${...}` into the generated
  // docs/atom-schemas.md catalog that skills are told to grep. This test is
  // what keeps the literal honest if the constant ever moves.
  it('the tool description states the same cap the code enforces', () => {
    const src = fs.readFileSync(
      new URL('../../../mcp/google-drive-server.ts', import.meta.url),
      'utf8',
    );
    const formatted = DEFAULT_INLINE_MAX_CHARS.toLocaleString('en-US');
    const registration = src.slice(src.indexOf("'drive_read_file',"));
    const description = registration.slice(0, registration.indexOf('\n  {\n'));

    expect(description).toContain(`above ${formatted} characters`);
    expect(description).not.toContain('${'); // no un-evaluated interpolation
  });
});

describe('drive_read_file: writeToPath (read to disk, not to context)', () => {
  let fake: ReturnType<typeof makeFakeDrive>;
  let tmpDir: string;

  beforeEach(() => {
    fake = makeFakeDrive();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-read-dest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the full document to disk and returns a handle, not content', async () => {
    const body = 'y'.repeat(68_470);
    queueTextFile(fake, body);
    const writeToPath = path.join(tmpDir, 'out.txt');

    const r = await handleReadFileToDisk({ fileId: 'f1', writeToPath }, fake as any, { sleep });

    expect(fs.readFileSync(writeToPath, 'utf8')).toBe(body);
    // Canonicalised: containment resolves symlinks (macOS /var -> /private/var)
    // and callers must use the RETURNED path, not the one they passed.
    expect(r.path).toBe(fs.realpathSync(writeToPath));
    expect(r.total_length).toBe(68_470);
    expect(r.name).toBe('a.txt');
    expect(r.mimeType).toBe('text/plain');
    expect(r.revisionVersion).toBe('7');
    // The whole point: no content field to spend context on.
    expect((r as any).content).toBeUndefined();
  });

  it('creates missing parent directories', async () => {
    queueTextFile(fake, 'body');
    const writeToPath = path.join(tmpDir, 'nested', 'deeper', 'out.txt');

    await handleReadFileToDisk({ fileId: 'f1', writeToPath }, fake as any, { sleep });

    expect(fs.readFileSync(writeToPath, 'utf8')).toBe('body');
  });

  it('writes the Google Doc export branch too', async () => {
    queueGoogleDoc(fake, 'exported doc body');
    const writeToPath = path.join(tmpDir, 'doc.txt');

    const r = await handleReadFileToDisk({ fileId: 'doc1', writeToPath }, fake as any, { sleep });

    expect(fs.readFileSync(writeToPath, 'utf8')).toBe('exported doc body');
    expect(r.total_length).toBe(17);
  });

  // The MCP subprocess's cwd is the plugin cache dir, not the user's project,
  // so a relative writeToPath would silently land somewhere surprising.
  it('refuses a relative writeToPath', async () => {
    queueTextFile(fake, 'body');
    await expect(
      handleReadFileToDisk({ fileId: 'f1', writeToPath: 'out.txt' }, fake as any, { sleep }),
    ).rejects.toThrow(/path_not_absolute/);
  });

  it('still refuses binary mimetypes on the disk path', async () => {
    fake.queueGet(() => ({ data: { mimeType: 'application/pdf', name: 'a.pdf', version: '1' } }));
    await expect(
      handleReadFileToDisk({ fileId: 'f1', writeToPath: path.join(tmpDir, 'a.txt') }, fake as any, { sleep }),
    ).rejects.toThrow(/unsupported_binary_mimetype/);
  });
});

// dimagi-internal/ace#1110 — the containment decision that issue deferred.
// lib/path-containment.ts owns the rules and its own suite; these pin that the
// gdrive sinks actually CALL it. A helper nothing invokes is not a preventer.
describe('path containment is wired into the gdrive write sinks (#1110)', () => {
  const fake = () => ({
    files: {
      get: vi.fn(async () => ({ data: { mimeType: 'text/plain', name: 'a.txt', version: '1' } })),
    },
  });

  it('drive_read_file writeToPath refuses a path outside the allowed roots', async () => {
    await expect(
      handleReadFileToDisk({ fileId: 'f1', writeToPath: '/etc/ace-pwned.txt' }, fake() as any, { sleep }),
    ).rejects.toThrow(/path_outside_allowed_roots/);
  });

  it('drive_read_file writeToPath refuses a protected filename inside a root', async () => {
    await expect(
      handleReadFileToDisk(
        { fileId: 'f1', writeToPath: path.join(os.tmpdir(), '.env') },
        fake() as any,
        { sleep },
      ),
    ).rejects.toThrow(/path_denied/);
  });

  it('names the atom and arg in the refusal so the caller can act', async () => {
    const err = await handleReadFileToDisk(
      { fileId: 'f1', writeToPath: '/etc/x.txt' },
      fake() as any,
      { sleep },
    ).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/drive_read_file/);
    expect((err as Error).message).toMatch(/writeToPath/);
  });

  it('refuses BEFORE spending a Drive round-trip', async () => {
    const f = fake();
    await expect(
      handleReadFileToDisk({ fileId: 'f1', writeToPath: '/etc/x.txt' }, f as any, { sleep }),
    ).rejects.toThrow();
    expect(f.files.get).not.toHaveBeenCalled();
  });
});
