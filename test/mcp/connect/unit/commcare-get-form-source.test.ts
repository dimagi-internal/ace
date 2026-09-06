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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CommCareBackend,
  MAX_INLINE_FORM_SOURCE_CHARS,
} from '../../../../mcp/connect/backends/commcare.js';

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
    const patchSideSha1 = createHash('sha1')
      .update(Buffer.from(out.xform_xml as string, 'utf8'))
      .digest('hex');
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

/**
 * ace#1795 — the read side had no disk-handle mode, so a one-attribute XForm
 * patch round-tripped the WHOLE form through model context (~30 KB in on the
 * read, ~30 KB back out on the write) and made the model the transport for
 * bytes it had to reproduce verbatim. `write_to_path` is the read-side mirror
 * of `patch_xform`'s `new_xform_xml_path`; the inline cap is what stops the
 * expensive path staying the silent default.
 *
 * Classification: UNIT-TEST TRUTH. Everything here is downstream of the HTTP
 * response — a disk write, a return shape, a size refusal. Nothing is sent to
 * or matched against a live CCHQ (the GET itself is stubbed, as it already was
 * for the three cases above).
 */
describe('CommCareBackend.getFormSource — write_to_path (ace#1795)', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = {
    domain: 'connect-ace-prod',
    app_id: '4e20ddf5beca42278c4d2c20383eb943',
    form_unique_id: '6f3d3ad3ed9d44e5b4107c0a1210dd10',
  };
  // Entity- and escape-bearing, like the form that actually bit.
  const xml =
    '<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:body>' +
    '<text>Read aloud &#x2014; don&apos;t paraphrase</text>' +
    '<upload ref="/data/photo" mediatype="image/*"/>' +
    '</h:body></h:html>';

  const dirs: string[] = [];
  function scratch(): string {
    const d = mkdtempSync(join(tmpdir(), 'ace-gfs-test-'));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it('POSITIVE: writes the bytes to disk and returns a handle with NO content', async () => {
    const dest = join(scratch(), 'nested', 'form.xml');
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(xml, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    const out = await backend.getFormSource({ ...args, write_to_path: dest });

    expect(out.xform_xml).toBeUndefined(); // the whole point: zero context
    expect(out.xform_xml_written_to).toBe(dest);
    expect(out.total_length).toBe(Buffer.byteLength(xml, 'utf8'));
    // Missing parent dirs are created (app-hq-settings writes into a fresh mktemp -d).
    expect(existsSync(dest)).toBe(true);
    // Byte-identical on disk — this is the transcription-fidelity half.
    expect(readFileSync(dest, 'utf8')).toBe(xml);
  });

  it('POSITIVE: the sha1 handed back is still the patch_xform concurrency token', async () => {
    const dest = join(scratch(), 'form.xml');
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(xml, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    const out = await backend.getFormSource({ ...args, write_to_path: dest });

    const fromDisk = createHash('sha1').update(readFileSync(dest)).digest('hex');
    expect(out.sha1).toBe(fromDisk);
    expect(out.sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('POSITIVE: the inline cap does NOT apply on the disk path', async () => {
    const dest = join(scratch(), 'big.xml');
    const big = 'x'.repeat(MAX_INLINE_FORM_SOURCE_CHARS + 1_000);
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(big, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    const out = await backend.getFormSource({ ...args, write_to_path: dest });
    expect(out.total_length).toBe(big.length);
    expect(readFileSync(dest, 'utf8').length).toBe(big.length);
  });

  it('NEGATIVE: a relative write_to_path is refused (the server cwd is the plugin cache)', async () => {
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(xml, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(
      backend.getFormSource({ ...args, write_to_path: 'form.xml' }),
    ).rejects.toThrow(/write_path_not_absolute/);
  });

  it('NEGATIVE: the refusal names THIS atom, not commcare_download_ccz', async () => {
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(xml, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(
      backend.getFormSource({ ...args, write_to_path: join(tmpdir(), '..', '.env') }),
    ).rejects.toThrow(/commcare_get_form_source/);
  });
});

describe('CommCareBackend.getFormSource — inline cap (ace#1795)', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = {
    domain: 'connect-ace-prod',
    app_id: '4e20ddf5beca42278c4d2c20383eb943',
    form_unique_id: '6f3d3ad3ed9d44e5b4107c0a1210dd10',
  };

  it('NEGATIVE: refuses inline above the cap, pointing at write_to_path', async () => {
    const big = 'x'.repeat(MAX_INLINE_FORM_SOURCE_CHARS + 1);
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(big, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    await expect(backend.getFormSource(args)).rejects.toThrow(/oversized_form_source/);
    await expect(backend.getFormSource(args)).rejects.toThrow(/write_to_path/);
  });

  it('POSITIVE: returns inline at exactly the cap (off-by-one boundary)', async () => {
    const atCap = 'x'.repeat(MAX_INLINE_FORM_SOURCE_CHARS);
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(atCap, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    const out = await backend.getFormSource(args);
    expect(out.xform_xml).toHaveLength(MAX_INLINE_FORM_SOURCE_CHARS);
    expect(out.total_length).toBe(MAX_INLINE_FORM_SOURCE_CHARS);
    expect(out.xform_xml_written_to).toBeUndefined();
  });

  it('POSITIVE: an ordinary ~30 KB ACE form is still returned inline unchanged', async () => {
    // The reported case is 30 KB, well under the cap — the refusal is a
    // backstop, the DESCRIPTION is what steers callers to the cheap path.
    const thirtyKb = 'y'.repeat(30_000);
    const fake = fakeRequest({ getStatus: 200, getBody: Buffer.from(thirtyKb, 'utf8') });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    const out = await backend.getFormSource(args);
    expect(out.xform_xml).toBe(thirtyKb);
  });
});
