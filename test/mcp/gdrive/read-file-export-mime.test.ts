/**
 * dimagi-internal/ace#1321 — `drive_read_file` exported every Google Doc as
 * `text/plain`, which strips the structure the reading skill matches on.
 *
 * #1061 made `idea-to-pdd` write the PDD as a NATIVE Google Doc and added
 * `idea-to-pdd-qa` check 7 to enforce it. But the suite's other seven checks
 * match markdown — `^## ` headings via `extractSection`, `^|` pipe tables via
 * `countTableDataRows`. Measured on the PDD from
 * bednet-check-2-visit/20260814-0856 (1l5EaLpHTMYBEKppqbxBmmm1dkqOZxa1zkVuoRAC63Ek):
 *
 *   text/plain     44,912 chars →   0 `^## ` headings,   0 `^|` table lines
 *   text/markdown  46,220 chars →  18 `^## ` headings, 139 `^|` table lines
 *
 * So check 7 and checks 1/3/4/5/6/8 could not both pass on the same artifact,
 * and Phase 1 QA failed on every run — with hints naming sections that are
 * plainly in the document and absent only from the export.
 *
 * The parameter is OPT-IN and the default stays `text/plain` on purpose:
 * `update_yaml_file` parses YAML gdocs out of the plain-text export, and a
 * markdown export would mangle them. Opt-in keeps that blast radius at zero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleReadFile, handleReadFileToDisk } from '../../../mcp/google-drive-server.js';

function makeFakeDrive() {
  const getQueue: Array<() => any> = [];
  const exportQueue: Array<(args: any) => any> = [];
  return {
    exportArgs: [] as any[],
    queueGet(fn: () => any) { getQueue.push(fn); },
    queueExport(fn: (args: any) => any) { exportQueue.push(fn); },
    files: {
      get: vi.fn(async () => {
        const fn = getQueue.shift();
        if (!fn) throw new Error('files.get called more times than queued');
        return fn();
      }),
      export: vi.fn(async function (this: any, args: any) {
        const fn = exportQueue.shift();
        if (!fn) throw new Error('files.export called more times than queued');
        return fn(args);
      }),
    },
  };
}

const sleep = () => Promise.resolve();

function queueDoc(fake: ReturnType<typeof makeFakeDrive>, body: string) {
  fake.queueGet(() => ({
    data: { mimeType: 'application/vnd.google-apps.document', name: 'PDD', version: '3' },
  }));
  fake.queueExport((args: any) => {
    fake.exportArgs.push(args);
    return { data: body };
  });
}

describe('drive_read_file exportMimeType (#1321)', () => {
  let fake: ReturnType<typeof makeFakeDrive>;
  beforeEach(() => { fake = makeFakeDrive(); });

  it('still exports text/plain by default — update_yaml_file depends on it', async () => {
    queueDoc(fake, 'flat text');
    await handleReadFile({ fileId: 'f' }, fake as any, { sleep });
    expect(fake.exportArgs[0].mimeType).toBe('text/plain');
  });

  it('exports text/markdown when asked, preserving headings and pipe tables', async () => {
    const md = '## Archetype\n\natomic-visit\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    queueDoc(fake, md);
    const r = await handleReadFile(
      { fileId: 'f', exportMimeType: 'text/markdown' },
      fake as any,
      { sleep },
    );
    expect(fake.exportArgs[0].mimeType).toBe('text/markdown');
    expect(r.content).toMatch(/^## Archetype$/m);
    expect(r.content.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(3);
  });

  it('honours exportMimeType on the writeToPath path too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1321-'));
    const out = path.join(dir, 'pdd.md');
    queueDoc(fake, '## Problem Statement\n');
    const r = await handleReadFileToDisk(
      { fileId: 'f', writeToPath: out, exportMimeType: 'text/markdown' },
      fake as any,
      { sleep },
    );
    expect(fake.exportArgs[0].mimeType).toBe('text/markdown');
    expect(fs.readFileSync(out, 'utf8')).toMatch(/^## Problem Statement$/m);
    expect(r.path).toBe(out);
  });

  it('refuses exportMimeType on a file that is not a Google Doc, rather than ignoring it', async () => {
    fake.queueGet(() => ({ data: { mimeType: 'text/markdown', name: 'a.md', version: '1' } }));
    fake.queueGet(() => ({ data: '## already markdown\n' }));
    await expect(
      handleReadFile({ fileId: 'f', exportMimeType: 'text/markdown' }, fake as any, { sleep }),
    ).rejects.toThrow(/export_mime_not_applicable/);
  });
});
