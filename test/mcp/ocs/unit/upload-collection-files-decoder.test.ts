/**
 * Unit tests for `decodeUploadCollectionFileSource` — the file-input decoder
 * shared by `ocs_upload_collection_files`. Asserts the exactly-one-source
 * invariant, the file_path read path, and the inline-content b64 decode path.
 *
 * Class-level preventer documented in `docs/learnings/2026-05-19-ocs-upload-b64-context-wedge.md`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeUploadCollectionFileSource } from '../../../../mcp/ocs-server.js';

describe('decodeUploadCollectionFileSource', () => {
  let tmpDir: string;
  let absTextPath: string;
  let absBinPath: string;
  const utf8Sample = '## LEEP PDD\n\nMulti-stage paint-collection survey.';
  const binSample = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x42]);

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ocs-upload-decoder-'));
    absTextPath = join(tmpDir, 'pdd.md');
    absBinPath = join(tmpDir, 'photo.bin');
    await writeFile(absTextPath, utf8Sample, 'utf8');
    await writeFile(absBinPath, binSample);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads file_path bytes verbatim (UTF-8 text)', async () => {
    const decoded = await decodeUploadCollectionFileSource({
      name: 'pdd.md',
      file_path: absTextPath,
      mime_type: 'text/markdown',
    });
    expect(decoded.name).toBe('pdd.md');
    expect(decoded.mime_type).toBe('text/markdown');
    expect(decoded.content.toString('utf8')).toBe(utf8Sample);
  });

  it('reads file_path bytes verbatim (arbitrary binary)', async () => {
    const decoded = await decodeUploadCollectionFileSource({
      name: 'photo.bin',
      file_path: absBinPath,
      mime_type: 'application/octet-stream',
    });
    expect(decoded.content.equals(binSample)).toBe(true);
  });

  it('decodes inline base64 content (legacy mode)', async () => {
    const b64 = Buffer.from('hello world', 'utf8').toString('base64');
    const decoded = await decodeUploadCollectionFileSource({
      name: 'inline.txt',
      content: b64,
      mime_type: 'text/plain',
    });
    expect(decoded.content.toString('utf8')).toBe('hello world');
  });

  it('throws when neither source supplied', async () => {
    await expect(
      decodeUploadCollectionFileSource({
        name: 'orphan.md',
        mime_type: 'text/markdown',
      }),
    ).rejects.toThrow(/missing source/);
  });

  it('throws when both sources supplied', async () => {
    await expect(
      decodeUploadCollectionFileSource({
        name: 'both.md',
        content: Buffer.from('a', 'utf8').toString('base64'),
        file_path: absTextPath,
        mime_type: 'text/markdown',
      }),
    ).rejects.toThrow(/both content and file_path/);
  });

  it('error message names the offending file (debuggability)', async () => {
    await expect(
      decodeUploadCollectionFileSource({
        name: 'pdd-summary-for-leep.md',
        mime_type: 'text/markdown',
      }),
    ).rejects.toThrow(/"pdd-summary-for-leep\.md"/);
  });

  it('propagates ENOENT from the underlying fs read', async () => {
    await expect(
      decodeUploadCollectionFileSource({
        name: 'absent.md',
        file_path: join(tmpDir, 'does-not-exist.md'),
        mime_type: 'text/markdown',
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});
