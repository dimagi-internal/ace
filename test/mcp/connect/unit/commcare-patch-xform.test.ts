/**
 * Unit tests for `CommCareBackend.patchXform` — the HTTP plumbing that
 * powers the `commcare_patch_xform` MCP atom. The atom is currently
 * consumed only by `app-multimedia-coverage` (manual post-Phase-3 step
 * for jr://-reference patching).
 *
 * Historical note: this file used to also cover `applyUserScorePatch`,
 * `applyAssessmentRemovalPatch`, and `assertPostPatchMarkersSurvive` —
 * helpers that backed the now-removed `commcare-form-patch` skill.
 * Removed 2026-05-22 after voidcraft-labs/nova-plugin#7 was closed and
 * the wrapper-hypothesis test (leep-paint-collection run 20260522-1241,
 * Phase 6 `app-screenshot-capture` Learn-launch on an unpatched CCZ)
 * confirmed Nova's maintainer's account: wrappers are required, not
 * harmful. See PR removing `skills/commcare-form-patch/` for restore
 * pointers if ever needed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CommCareBackend,
} from '../../../../mcp/connect/backends/commcare.js';

// ── CommCareBackend.patchXform — HTTP plumbing ─────────────────────

interface FakeResponse {
  status: () => number;
  text: () => Promise<string>;
}

function fakeRequest(opts: {
  postStatus: number;
  postBody: string;
  cookieCsrf?: string;
  onPost?: (url: string, init: { data?: string; headers?: Record<string, string> }) => void;
}) {
  const calls: Array<{ method: 'get' | 'post'; url: string; init?: unknown }> = [];
  return {
    calls,
    request: {
      get: vi.fn(async (url: string) => {
        calls.push({ method: 'get', url });
        return { status: () => 200, text: async () => '', headers: () => ({}) } as FakeResponse;
      }),
      post: vi.fn(async (url: string, init: { data?: string; headers?: Record<string, string> }) => {
        calls.push({ method: 'post', url, init });
        opts.onPost?.(url, init);
        return {
          status: () => opts.postStatus,
          text: async () => opts.postBody,
          headers: () => ({}),
        } as FakeResponse;
      }),
      storageState: vi.fn(async () => ({
        cookies: opts.cookieCsrf
          ? [{ name: 'csrftoken', value: opts.cookieCsrf, domain: 'www.commcarehq.org' }]
          : [],
      })),
    },
  };
}

/**
 * Wrap a fakeRequest in a stub `PlaywrightSession` so the new
 * session-aware CommCareBackend constructor accepts it. `getContext()`
 * returns just enough of a BrowserContext for the backend's lookups
 * (a `request` plus a no-op cookies()/close() set); `invalidate()` is a
 * no-op since unit tests never trigger the retry path.
 */
function fakeSession(request: unknown) {
  return {
    getContext: async () => ({ request }),
    invalidate: async () => {},
  } as never;
}

describe('CommCareBackend.patchXform', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = {
    domain: 'connect-ace-prod',
    app_id: '4e20ddf5beca42278c4d2c20383eb943',
    form_unique_id: '6f3d3ad3ed9d44e5b4107c0a1210dd10',
    new_xform_xml: '<h:html xmlns:h="x"><patched/></h:html>',
    sha1: 'a'.repeat(40),
  };

  // Live response shape (verified 2026-05-03 against connect-ace-prod):
  //   {"corrections": {}, "update": {"app-version": <int>}}
  const okBody = JSON.stringify({ corrections: {}, update: { 'app-version': 8 } });

  it('POSTs to the correct URL with form-encoded xform + sha1 + csrf', async () => {
    let capturedUrl = '';
    let capturedInit: { data?: string; headers?: Record<string, string> } | undefined;
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
      cookieCsrf: 'tok123',
      onPost: (url, init) => {
        capturedUrl = url;
        capturedInit = init;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.patchXform(args);

    expect(capturedUrl).toBe(
      `${baseUrl}/a/${args.domain}/apps/edit_form_attr/${args.app_id}/${args.form_unique_id}/xform/`,
    );
    expect(capturedInit?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(capturedInit?.headers?.['X-CSRFToken']).toBe('tok123');
    expect(capturedInit?.headers?.Referer).toContain(`/apps/view/${args.app_id}/`);

    // Body parses back as URLSearchParams; xml round-trips intact, and sha1 set.
    const params = new URLSearchParams(capturedInit?.data ?? '');
    expect(params.get('xform')).toBe(args.new_xform_xml);
    expect(params.get('sha1')).toBe(args.sha1);

    expect(out).toEqual({ status: 200, app_version: 8 });
  });

  it('omits sha1 from the body when caller did not pass one', async () => {
    let capturedInit: { data?: string } | undefined;
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
      onPost: (_url, init) => {
        capturedInit = init;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    const { sha1, ...noSha } = args;
    void sha1; // intentionally unused
    await backend.patchXform(noSha);

    const params = new URLSearchParams(capturedInit?.data ?? '');
    expect(params.has('sha1')).toBe(false);
    expect(params.get('xform')).toBe(args.new_xform_xml);
  });

  it('GETs the apps/view/<app_id>/ refresh page before the POST (csrf+cookie warm)', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.patchXform(args);
    expect(fake.calls[0]).toEqual({
      method: 'get',
      url: `${baseUrl}/a/${args.domain}/apps/view/${args.app_id}/`,
    });
    expect(fake.calls[1].method).toBe('post');
  });

  it('surfaces non-empty corrections from the response body', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: JSON.stringify({
        corrections: { 'my-form': 'normalized whitespace' },
        update: { 'app-version': 9 },
      }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.patchXform(args);
    expect(out.corrections).toEqual({ 'my-form': 'normalized whitespace' });
    expect(out.app_version).toBe(9);
  });

  it('throws XformConflictError on 409 with a JSON body that includes the live sha1 (when caller passed sha1)', async () => {
    const fake = fakeRequest({
      postStatus: 409,
      postBody: JSON.stringify({ message: 'sha1 mismatch', sha1: 'c'.repeat(40) }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.patchXform(args)).rejects.toMatchObject({
      name: 'XformConflictError',
      liveSha1: 'c'.repeat(40),
      attemptedSha1: 'a'.repeat(40),
    });
  });

  it('does NOT classify 409 as conflict when caller did not pass sha1 (server-side conflict not actionable)', async () => {
    const fake = fakeRequest({
      postStatus: 409,
      postBody: JSON.stringify({ message: 'whatever', sha1: 'c'.repeat(40) }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const { sha1, ...noSha } = args;
    void sha1;
    await expect(backend.patchXform(noSha)).rejects.toThrow(/returned 409/);
  });

  it('throws a generic Error on non-200 / non-409 status', async () => {
    const fake = fakeRequest({
      postStatus: 500,
      postBody: '<html>Internal Server Error</html>',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.patchXform(args)).rejects.toThrow(/returned 500/);
  });

  it('throws when 200 returns a non-JSON body (endpoint contract change)', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: '<html>OK?</html>',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.patchXform(args)).rejects.toThrow(/not JSON/);
  });

  it('throws when 200 JSON body has no update.app-version (incomplete CCHQ response)', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: JSON.stringify({ corrections: {} }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.patchXform(args)).rejects.toThrow(/no update.app-version/);
  });
});
