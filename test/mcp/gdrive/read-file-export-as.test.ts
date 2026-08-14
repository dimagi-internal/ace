import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleReadFile, handleReadFileToDisk } from '../../../mcp/google-drive-server.js';

/**
 * `exportAs` is the opt-in markdown export on `drive_read_file`.
 *
 * The invariant these tests lock: the DEFAULT stays `text/plain`. ACE stores
 * run_state.yaml / opp.yaml / decisions.yaml / every *_verdict.yaml as Google
 * Docs, and Drive's markdown exporter escapes markdown-significant characters
 * (`---` → `\---`, `run_id` → `run\_id`), which no YAML parser accepts. A
 * default flip would silently break update_yaml_file + validate_run_state, so
 * the default is asserted here rather than left to prose in the description.
 */
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

function queueGoogleDoc(fake: ReturnType<typeof makeFakeDrive>, body: string) {
  fake.queueGet(() => ({
    data: { mimeType: 'application/vnd.google-apps.document', name: 'd.doc', version: '3' },
  }));
  fake.queueExport(() => ({ data: body }));
}

function queueTextFile(fake: ReturnType<typeof makeFakeDrive>, body: string) {
  fake.queueGet(() => ({ data: { mimeType: 'text/plain', name: 'a.yaml', version: '7' } }));
  fake.queueGet(() => ({ data: body }));
}

describe('drive_read_file: exportAs', () => {
  let fake: ReturnType<typeof makeFakeDrive>;

  beforeEach(() => {
    fake = makeFakeDrive();
  });

  it('defaults to text/plain when exportAs is omitted', async () => {
    queueGoogleDoc(fake, 'run_id: abc\n');
    const r = await handleReadFile({ fileId: 'f1' }, fake as any, { sleep });
    expect(fake.files.export).toHaveBeenCalledWith(
      { fileId: 'f1', mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    expect(r.content).toBe('run_id: abc\n');
  });

  it('exports text/plain when exportAs is explicitly text/plain', async () => {
    queueGoogleDoc(fake, '---\nrun_id: abc\n');
    await handleReadFile({ fileId: 'f1', exportAs: 'text/plain' }, fake as any, { sleep });
    expect(fake.files.export).toHaveBeenCalledWith(
      { fileId: 'f1', mimeType: 'text/plain' },
      { responseType: 'text' },
    );
  });

  it('exports text/markdown when exportAs is text/markdown', async () => {
    queueGoogleDoc(fake, '# Work Order\n\n**Bold** and a [link](https://x)\n');
    const r = await handleReadFile({ fileId: 'f1', exportAs: 'text/markdown' }, fake as any, { sleep });
    expect(fake.files.export).toHaveBeenCalledWith(
      { fileId: 'f1', mimeType: 'text/markdown' },
      { responseType: 'text' },
    );
    expect(r.content).toContain('# Work Order');
  });

  it('composes with offset/limit paging', async () => {
    queueGoogleDoc(fake, '# Heading\nbody');
    const r = await handleReadFile(
      { fileId: 'f1', exportAs: 'text/markdown', offset: 0, limit: 9 },
      fake as any,
      { sleep },
    );
    expect(r.content).toBe('# Heading');
    expect(r.has_more).toBe(true);
  });

  it('ignores exportAs for non-Docs files — stored bytes are returned verbatim', async () => {
    queueTextFile(fake, '---\nrun_id: abc\n');
    const r = await handleReadFile({ fileId: 'f1', exportAs: 'text/markdown' }, fake as any, { sleep });
    expect(fake.files.export).not.toHaveBeenCalled();
    expect(r.content).toBe('---\nrun_id: abc\n');
  });

  it('threads exportAs through writeToPath, defaulting to text/plain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-exportas-'));

    queueGoogleDoc(fake, 'plain text export');
    await handleReadFileToDisk(
      { fileId: 'f1', writeToPath: path.join(dir, 'plain.txt') },
      fake as any,
      { sleep },
    );
    expect(fake.files.export).toHaveBeenLastCalledWith(
      { fileId: 'f1', mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    expect(fs.readFileSync(path.join(dir, 'plain.txt'), 'utf8')).toBe('plain text export');

    queueGoogleDoc(fake, '## Markdown export');
    await handleReadFileToDisk(
      { fileId: 'f1', writeToPath: path.join(dir, 'md.md'), exportAs: 'text/markdown' },
      fake as any,
      { sleep },
    );
    expect(fake.files.export).toHaveBeenLastCalledWith(
      { fileId: 'f1', mimeType: 'text/markdown' },
      { responseType: 'text' },
    );
    expect(fs.readFileSync(path.join(dir, 'md.md'), 'utf8')).toBe('## Markdown export');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
