import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleReadFile } from '../../../mcp/google-drive-server.js';

// Helper: build a fake drive client whose files.get / files.export return
// queued responses (success or thrown error). Each call shifts from the front.
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

// A test sleep that records delays but does not actually wait.
function makeRecordingSleep() {
  const delays: number[] = [];
  const sleep = (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

describe('drive_read_file: retry on transient 5xx', () => {
  let fake: ReturnType<typeof makeFakeDrive>;

  beforeEach(() => {
    fake = makeFakeDrive();
  });

  it('returns content on first-attempt success (no retry)', async () => {
    fake.queueGet(() => ({
      data: { mimeType: 'text/plain', name: 'a.txt', version: '7' },
    }));
    fake.queueGet(() => ({ data: 'hello world' })); // alt:media branch

    const { sleep, delays } = makeRecordingSleep();
    const r = await handleReadFile({ fileId: 'f1' }, fake as any, { sleep });

    expect(r.content).toBe('hello world');
    expect(r.revisionVersion).toBe('7');
    expect(delays).toEqual([]);
    expect(fake.files.get).toHaveBeenCalledTimes(2);
  });

  it('retries up to 3 times on transient 5xx then succeeds', async () => {
    // First metadata get: 503 then 503 then OK
    const transient = () => {
      const e: any = new Error('Backend Error');
      e.code = 503;
      throw e;
    };
    fake.queueGet(transient);
    fake.queueGet(transient);
    fake.queueGet(() => ({
      data: { mimeType: 'text/plain', name: 'a.txt', version: '7' },
    }));
    fake.queueGet(() => ({ data: 'hello' }));

    const { sleep, delays } = makeRecordingSleep();
    const r = await handleReadFile({ fileId: 'f1' }, fake as any, { sleep });

    expect(r.content).toBe('hello');
    // backoff schedule: 1000ms, 2000ms (2 retries before 3rd attempt succeeds)
    expect(delays).toEqual([1000, 2000]);
  });

  it('gives up after 3 attempts on persistent 5xx', async () => {
    const transient = () => {
      const e: any = new Error('Internal Error');
      e.code = 500;
      throw e;
    };
    fake.queueGet(transient);
    fake.queueGet(transient);
    fake.queueGet(transient);

    const { sleep, delays } = makeRecordingSleep();
    await expect(handleReadFile({ fileId: 'f1' }, fake as any, { sleep })).rejects.toThrow(/Internal Error/);
    // 2 sleeps before the 3rd attempt, no sleep after the final failure
    expect(delays).toEqual([1000, 2000]);
  });

  it('does NOT retry on 4xx (caller bug)', async () => {
    fake.queueGet(() => {
      const e: any = new Error('File not found');
      e.code = 404;
      throw e;
    });

    const { sleep, delays } = makeRecordingSleep();
    await expect(handleReadFile({ fileId: 'bogus' }, fake as any, { sleep })).rejects.toThrow(/not found/i);
    expect(delays).toEqual([]);
    expect(fake.files.get).toHaveBeenCalledTimes(1);
  });

  it('retries on the export path too (Google Doc branch)', async () => {
    fake.queueGet(() => ({
      data: { mimeType: 'application/vnd.google-apps.document', name: 'd.doc', version: '3' },
    }));
    fake.queueExport(() => {
      const e: any = new Error('Service Unavailable');
      e.code = 503;
      throw e;
    });
    fake.queueExport(() => ({ data: 'doc body' }));

    const { sleep, delays } = makeRecordingSleep();
    const r = await handleReadFile({ fileId: 'doc1' }, fake as any, { sleep });

    expect(r.content).toBe('doc body');
    expect(delays).toEqual([1000]);
  });

  // Background: jjackson/ace#106 finding 4 — drive_read_file used to return
  // raw binary as a JSON-corrupted "string" for non-text mimetypes (PDF,
  // docx, xlsx, etc.). Now refuses with a typed error pointing at
  // drive_download_binary.
  describe('binary-mimetype rejection (regression: #106 finding 4)', () => {
    const cases: Array<[string, string]> = [
      ['application/pdf', 'PDF'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'XLSX'],
      ['image/png', 'PNG'],
      ['application/zip', 'ZIP/CCZ'],
      ['audio/mpeg', 'audio'],
    ];

    for (const [mimeType, label] of cases) {
      it(`refuses ${label} (mimeType=${mimeType}) with unsupported_binary_mimetype`, async () => {
        fake.queueGet(() => ({ data: { mimeType, name: `f.${label.toLowerCase()}`, version: '1' } }));
        const { sleep } = makeRecordingSleep();
        await expect(handleReadFile({ fileId: 'f1' }, fake as any, { sleep })).rejects.toThrow(
          /unsupported_binary_mimetype/,
        );
      });
    }

    it('error message names drive_download_binary as the right tool', async () => {
      fake.queueGet(() => ({ data: { mimeType: 'application/pdf', name: 'a.pdf', version: '1' } }));
      const { sleep } = makeRecordingSleep();
      await expect(handleReadFile({ fileId: 'f1' }, fake as any, { sleep })).rejects.toThrow(
        /drive_download_binary/,
      );
    });

    it('still accepts text/markdown', async () => {
      fake.queueGet(() => ({ data: { mimeType: 'text/markdown', name: 'a.md', version: '1' } }));
      fake.queueGet(() => ({ data: '# heading\n' }));
      const { sleep } = makeRecordingSleep();
      const r = await handleReadFile({ fileId: 'f1' }, fake as any, { sleep });
      expect(r.mimeType).toBe('text/markdown');
      expect(r.content).toBe('# heading\n');
    });

    it('still accepts application/json', async () => {
      fake.queueGet(() => ({ data: { mimeType: 'application/json', name: 'a.json', version: '1' } }));
      fake.queueGet(() => ({ data: '{"k":"v"}' }));
      const { sleep } = makeRecordingSleep();
      const r = await handleReadFile({ fileId: 'f1' }, fake as any, { sleep });
      expect(r.content).toBe('{"k":"v"}');
    });
  });
});
