/**
 * Unit tests for `CommCareBackend.setMenuDisplay` — the HTTP plumbing that
 * powers the `commcare_set_menu_display` MCP atom. POSTs a module's
 * list-vs-grid `display_style` to CCHQ's `edit_module_attr` view.
 *
 * Session/CSRF plumbing mirrors commcare-patch-xform.test.ts exactly (the
 * POST side is identical: refresh GET on /apps/view/<app_id>/, X-CSRFToken
 * from the csrftoken cookie, form-encoded body).
 */
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend } from '../../../../mcp/connect/backends/commcare.js';

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

function fakeSession(request: unknown) {
  return {
    getContext: async () => ({ request }),
    invalidate: async () => {},
  } as never;
}

describe('CommCareBackend.setMenuDisplay', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = {
    domain: 'connect-ace-prod',
    app_id: '4e20ddf5beca42278c4d2c20383eb943',
    module_unique_id: '6f3d3ad3ed9d44e5b4107c0a1210dd10',
  };
  const okBody = JSON.stringify({ update: { 'app-version': 12 } });

  it('POSTs display_style to edit_module_attr with csrf + form-encoded body (default grid)', async () => {
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
    const out = await backend.setMenuDisplay(args);

    expect(capturedUrl).toBe(
      `${baseUrl}/a/${args.domain}/apps/edit_module_attr/${args.app_id}/${args.module_unique_id}/display_style/`,
    );
    expect(capturedInit?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(capturedInit?.headers?.['X-CSRFToken']).toBe('tok123');
    expect(capturedInit?.headers?.Referer).toContain(`/apps/view/${args.app_id}/`);

    const params = new URLSearchParams(capturedInit?.data ?? '');
    expect(params.get('display_style')).toBe('grid');

    expect(out).toEqual({ status: 200, app_version: 12 });
  });

  it('uses an explicit display_style when provided', async () => {
    let capturedInit: { data?: string } | undefined;
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
      onPost: (_url, init) => {
        capturedInit = init;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.setMenuDisplay({ ...args, display_style: 'list' });

    const params = new URLSearchParams(capturedInit?.data ?? '');
    expect(params.get('display_style')).toBe('list');
  });

  it('GETs the apps/view/<app_id>/ refresh page before the POST (csrf+cookie warm)', async () => {
    const fake = fakeRequest({ postStatus: 200, postBody: okBody });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.setMenuDisplay(args);
    expect(fake.calls[0]).toEqual({
      method: 'get',
      url: `${baseUrl}/a/${args.domain}/apps/view/${args.app_id}/`,
    });
    expect(fake.calls[1].method).toBe('post');
  });

  it('omits app_version when the response body carries none', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: JSON.stringify({ update: {} }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.setMenuDisplay(args);
    expect(out).toEqual({ status: 200 });
  });

  it('tolerates a non-JSON 200 body (returns status, no app_version)', async () => {
    const fake = fakeRequest({ postStatus: 200, postBody: 'OK' });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.setMenuDisplay(args);
    expect(out).toEqual({ status: 200 });
  });

  it('throws a generic Error on non-200 status', async () => {
    const fake = fakeRequest({
      postStatus: 500,
      postBody: '<html>Internal Server Error</html>',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.setMenuDisplay(args)).rejects.toThrow(/returned 500/);
  });
});
