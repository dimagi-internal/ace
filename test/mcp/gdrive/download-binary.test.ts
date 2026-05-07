import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDownloadBinary } from '../../../mcp/google-drive-server.js';

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
