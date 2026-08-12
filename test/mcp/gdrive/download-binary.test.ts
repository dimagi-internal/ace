import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsNode from 'node:fs';
import osNode from 'node:os';
import pathNode from 'node:path';
import {
  handleDownloadBinary,
  handleDownloadBinaryToDisk,
} from '../../../mcp/google-drive-server.js';

// Background: jjackson/ace#106 finding 4 — drive_read_file used to return
// raw binary as a JSON-corrupted "string" for PDF/docx/xlsx/images/audio.
// drive_download_binary is the companion atom that returns base64-encoded
// bytes for those file types.

const fakeDrive = {
  files: {
    get: vi.fn(),
  },
};

beforeEach(() => {
  fakeDrive.files.get.mockReset();
});

describe('handleDownloadBinary', () => {
  // Helper: produce a fresh ArrayBuffer of exactly N bytes from a Buffer.
  // Node's Buffer.from([...]).buffer points at the shared 8KB pool; the
  // googleapis client returns a fresh ArrayBuffer per response.
  function freshArrayBuffer(bytes: number[]): ArrayBuffer {
    const ab = new ArrayBuffer(bytes.length);
    new Uint8Array(ab).set(bytes);
    return ab;
  }

  it('returns base64-encoded bytes for a PDF', async () => {
    const pdfBytes = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
    // First call: metadata
    fakeDrive.files.get.mockImplementationOnce(async () => ({
      data: { id: 'f1', name: 'doc.pdf', mimeType: 'application/pdf', size: '5' },
    }));
    // Second call: media (arraybuffer)
    fakeDrive.files.get.mockImplementationOnce(async () => ({
      data: freshArrayBuffer(pdfBytes),
    }));

    const r = await handleDownloadBinary({ fileId: 'f1' }, fakeDrive as any);

    expect(r.id).toBe('f1');
    expect(r.name).toBe('doc.pdf');
    expect(r.mimeType).toBe('application/pdf');
    expect(r.size).toBe(5);
    expect(Buffer.from(r.content_base64, 'base64').equals(Buffer.from(pdfBytes))).toBe(true);
  });

  it('refuses native Google Docs (no binary representation)', async () => {
    // mockImplementation (not Once) so both expect() calls re-trigger it.
    fakeDrive.files.get.mockImplementation(async () => ({
      data: { id: 'f1', name: 'pdd', mimeType: 'application/vnd.google-apps.document' },
    }));

    await expect(handleDownloadBinary({ fileId: 'f1' }, fakeDrive as any)).rejects.toThrow(
      /cannot_download_native_google_doc/,
    );
    await expect(handleDownloadBinary({ fileId: 'f1' }, fakeDrive as any)).rejects.toThrow(
      /drive_read_file/,
    );
  });

  it('resolves shortcuts to the target before downloading', async () => {
    const targetBytes = [0x89, 0x50, 0x4e, 0x47]; // PNG magic
    // Metadata: it's a shortcut
    fakeDrive.files.get.mockImplementationOnce(async () => ({
      data: {
        id: 'shortcut-id',
        name: 'logo.lnk',
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutDetails: { targetId: 'target-id' },
      },
    }));
    // Resolve target metadata
    fakeDrive.files.get.mockImplementationOnce(async () => ({
      data: { id: 'target-id', name: 'logo.png', mimeType: 'image/png', size: '4' },
    }));
    // Media download
    fakeDrive.files.get.mockImplementationOnce(async () => ({
      data: freshArrayBuffer(targetBytes),
    }));

    const r = await handleDownloadBinary({ fileId: 'shortcut-id' }, fakeDrive as any);

    expect(r.id).toBe('target-id');
    expect(r.name).toBe('logo.png');
    expect(r.mimeType).toBe('image/png');
    expect(Buffer.from(r.content_base64, 'base64').equals(Buffer.from(targetBytes))).toBe(true);
  });

  it('retries transient 5xx on the metadata call', async () => {
    const transient = Object.assign(new Error('Internal Error'), { code: 500 });
    fakeDrive.files.get
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ data: { id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', size: '2' } })
      .mockResolvedValueOnce({ data: freshArrayBuffer([1, 2]) });

    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };

    const r = await handleDownloadBinary({ fileId: 'f1' }, fakeDrive as any, { sleep });
    expect(r.size).toBe(2);
    expect(delays).toEqual([1000]); // one backoff before the metadata retry
  });
});

// dimagi-internal/ace#1027 — `skills/ocs-agent-setup` § Step 5 and
// `ocs_upload_collection_files`' own schema both documented "drive_download_binary
// to a tmp path first, then pass that as file_path ... keeps the b64 entirely
// out of agent context". The atom took only `{fileId}` and returned
// `content_base64`, so the recipe the docs kept recommending was not
// expressible with the atom they named.
describe('handleDownloadBinaryToDisk (#1027)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'ace-dl-bin-'));
  });

  afterEach(() => {
    fsNode.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeBinaryDrive(bytes: Buffer, mimeType = 'application/pdf') {
    let call = 0;
    return {
      files: {
        get: vi.fn(async () => {
          call++;
          if (call === 1) {
            return { data: { id: 'f1', name: 'a.pdf', mimeType, size: String(bytes.length) } };
          }
          return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        }),
      },
    };
  }

  it('writes the bytes to disk byte-identically and returns no base64', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x01]);
    const writeToPath = pathNode.join(tmpDir, 'out.pdf');

    const r = await handleDownloadBinaryToDisk(
      { fileId: 'f1', writeToPath },
      fakeBinaryDrive(bytes) as any,
    );

    // Byte-for-byte, not utf8-mangled — the whole point of the binary path.
    expect(fsNode.readFileSync(writeToPath).equals(bytes)).toBe(true);
    expect(r.path).toBe(writeToPath);
    expect(r.size).toBe(bytes.length);
    expect((r as any).content_base64).toBeUndefined();
  });

  it('creates missing parent directories', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const writeToPath = pathNode.join(tmpDir, 'nested', 'deep', 'out.bin');

    await handleDownloadBinaryToDisk({ fileId: 'f1', writeToPath }, fakeBinaryDrive(bytes) as any);

    expect(fsNode.readFileSync(writeToPath).equals(bytes)).toBe(true);
  });

  it('refuses a relative writeToPath', async () => {
    await expect(
      handleDownloadBinaryToDisk(
        { fileId: 'f1', writeToPath: 'out.bin' },
        fakeBinaryDrive(Buffer.from([1])) as any,
      ),
    ).rejects.toThrow(/writeToPath_not_absolute/);
  });

  it('refuses an oversized base64 payload and names writeToPath', async () => {
    const bytes = Buffer.alloc(60_000, 0x41); // 60 KB -> 80,000 base64 chars
    await expect(
      handleDownloadBinary({ fileId: 'f1', maxBase64Chars: 40_000 }, fakeBinaryDrive(bytes) as any),
    ).rejects.toThrow(/oversized_binary/);

    const err = await handleDownloadBinary(
      { fileId: 'f1', maxBase64Chars: 40_000 },
      fakeBinaryDrive(bytes) as any,
    ).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/writeToPath/);
    expect((err as Error).message).toMatch(/60000 bytes/);
  });

  it('does NOT cap when maxBase64Chars is omitted (in-process callers)', async () => {
    const bytes = Buffer.alloc(60_000, 0x41);
    const r = await handleDownloadBinary({ fileId: 'f1' }, fakeBinaryDrive(bytes) as any);
    expect(r.content_base64.length).toBeGreaterThan(40_000);
    expect(r.size).toBe(60_000);
  });
});

