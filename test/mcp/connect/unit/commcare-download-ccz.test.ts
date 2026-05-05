/**
 * Unit tests for `CommCareBackend.downloadCcz` URL composition,
 * specifically the new `include_multimedia?: boolean` flag (F1).
 *
 * Background: CCHQ's `/a/<domain>/apps/api/download_ccz/` endpoint
 * defaults to a **lite manifest-only** response — multimedia binaries
 * are referenced by jr:// path + remote URL but NOT inlined into the
 * CCZ archive. Passing `?include_multimedia=true` returns the full,
 * self-contained CCZ with binaries under `commcare/multimedia/...`.
 *
 * The `app-multimedia-coverage` SKILL's verify step (10) needs the
 * full response to confirm a freshly-uploaded asset is bundled in
 * the released CCZ. Without the flag the verify silently false-
 * negatives every successful run.
 *
 * Mirrors the unit-test plumbing pattern from commcare-patch-xform.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend } from '../../../../mcp/connect/backends/commcare.js';

interface FakeResponse {
  status: () => number;
  body: () => Promise<Buffer>;
  text: () => Promise<string>;
  headers: () => Record<string, string>;
}

function fakeRequest(opts: {
  getStatus: number;
  getBody: Buffer;
  onGet?: (url: string) => void;
}) {
  const calls: Array<{ method: 'get'; url: string }> = [];
  return {
    calls,
    request: {
      get: vi.fn(async (url: string) => {
        calls.push({ method: 'get', url });
        opts.onGet?.(url);
        return {
          status: () => opts.getStatus,
          body: async () => opts.getBody,
          text: async () => opts.getBody.toString('utf8'),
          headers: () => ({}),
        } as FakeResponse;
      }),
      storageState: vi.fn(async () => ({ cookies: [] })),
    },
  };
}

function fakeSession(request: unknown) {
  return {
    getContext: async () => ({ request }),
    invalidate: async () => {},
  } as never;
}

describe('CommCareBackend.downloadCcz — include_multimedia flag', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = {
    domain: 'connect-ace-prod',
    app_id: '4e20ddf5beca42278c4d2c20383eb943',
  };
  // Minimal valid empty zip ("PK\x05\x06" + 18 zero bytes = empty central
  // directory). fflate.unzipSync accepts this without throwing.
  const emptyZip = Buffer.from([
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  it('appends include_multimedia=true to the GET URL when the flag is true', async () => {
    let capturedUrl = '';
    const fake = fakeRequest({
      getStatus: 200,
      getBody: emptyZip,
      onGet: (url) => {
        capturedUrl = url;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.downloadCcz({ ...args, include_multimedia: true });

    const u = new URL(capturedUrl);
    expect(u.searchParams.get('include_multimedia')).toBe('true');
    // Default no-build-id path still asks for latest=release.
    expect(u.searchParams.get('latest')).toBe('release');
    expect(u.searchParams.get('app_id')).toBe(args.app_id);
  });

  it('does NOT include include_multimedia when the flag is omitted (preserves lite default)', async () => {
    let capturedUrl = '';
    const fake = fakeRequest({
      getStatus: 200,
      getBody: emptyZip,
      onGet: (url) => {
        capturedUrl = url;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.downloadCcz({ ...args });

    const u = new URL(capturedUrl);
    expect(u.searchParams.has('include_multimedia')).toBe(false);
  });

  it('does NOT include include_multimedia when the flag is explicitly false', async () => {
    let capturedUrl = '';
    const fake = fakeRequest({
      getStatus: 200,
      getBody: emptyZip,
      onGet: (url) => {
        capturedUrl = url;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.downloadCcz({ ...args, include_multimedia: false });

    const u = new URL(capturedUrl);
    expect(u.searchParams.has('include_multimedia')).toBe(false);
  });

  it('threads include_multimedia alongside an explicit build_id', async () => {
    let capturedUrl = '';
    const fake = fakeRequest({
      getStatus: 200,
      getBody: emptyZip,
      onGet: (url) => {
        capturedUrl = url;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.downloadCcz({
      ...args,
      build_id: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
      include_multimedia: true,
    });

    const u = new URL(capturedUrl);
    expect(u.searchParams.get('include_multimedia')).toBe('true');
    // download_ccz uses app_id slot for the build_id when one is provided
    expect(u.searchParams.get('app_id')).toBe('b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1');
    expect(u.searchParams.has('latest')).toBe(false);
  });
});
