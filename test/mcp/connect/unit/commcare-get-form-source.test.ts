/**
 * Unit tests for `CommCareBackend.getFormSource` — the HTTP plumbing that
 * powers the `commcare_get_form_source` MCP atom. The atom GETs a form's
 * current XForm XML and returns it alongside the hex SHA-1 of the source
 * bytes — the SAME concurrency token `commcare_patch_xform`'s optional
 * `sha1` arg expects.
 *
 * Mirrors the plumbing pattern from commcare-download-ccz.test.ts (byte-
 * level GET) and commcare-patch-xform.test.ts (session/fake-request stubs).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
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

describe('CommCareBackend.getFormSource', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = {
    domain: 'connect-ace-prod',
    app_id: '4e20ddf5beca42278c4d2c20383eb943',
    form_unique_id: '6f3d3ad3ed9d44e5b4107c0a1210dd10',
  };
  const xml = '<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head/><h:body/></h:html>';

  it('GETs the browse/.../source/ endpoint and returns xml + hex sha1 of the bytes', async () => {
    let capturedUrl = '';
    const fake = fakeRequest({
      getStatus: 200,
      getBody: Buffer.from(xml, 'utf8'),
      onGet: (url) => {
        capturedUrl = url;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.getFormSource(args);

    expect(capturedUrl).toBe(
      `${baseUrl}/a/${args.domain}/apps/browse/${args.app_id}/${args.form_unique_id}/source/`,
    );
    expect(out.xform_xml).toBe(xml);
    // sha1 is the hex digest of the raw source bytes.
    const expectedSha1 = createHash('sha1').update(Buffer.from(xml, 'utf8')).digest('hex');
    expect(out.sha1).toBe(expectedSha1);
    expect(out.sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('produces a sha1 that round-trips into patchXform (token contract)', async () => {
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(xml, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.getFormSource(args);
    // The sha1 patchXform would compute over the same bytes matches.
    const patchSideSha1 = createHash('sha1').update(Buffer.from(out.xform_xml, 'utf8')).digest('hex');
    expect(out.sha1).toBe(patchSideSha1);
  });

  it('throws a generic Error on non-200 status', async () => {
    const fake = fakeRequest({
      getStatus: 404,
      getBody: Buffer.from('<html>Not Found</html>', 'utf8'),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.getFormSource(args)).rejects.toThrow(/returned 404/);
  });
});
