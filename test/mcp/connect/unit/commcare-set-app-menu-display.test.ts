/**
 * Unit tests for `CommCareBackend.setAppMenuDisplay` — the HTTP plumbing
 * behind the `commcare_set_app_menu_display` MCP atom
 * (dimagi-internal/ace#1082).
 *
 * Contract pinned from dimagi/commcare-hq @ master (2026-07-30):
 * `edit_app_attr` (corehq/apps/app_manager/views/apps.py:747) only reaches
 * `use_grid_menus` / `grid_form_menus` via attr='all' + a JSON body
 * `{"hq": {...}}` (they are easy_attrs at lines 810–811 but NOT in the
 * per-attr allowlist at line 762 — a direct
 * `edit_app_attr/<app_id>/use_grid_menus/` would 400). These tests pin the
 * URL shape, the JSON payload (native booleans, not form-encoded strings),
 * and the same session/CSRF plumbing as commcare-set-menu-display.test.ts.
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

describe('CommCareBackend.setAppMenuDisplay', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = {
    domain: 'connect-ace-prod',
    app_id: '7a512291fb5545a3812ab429e306dbea',
  };
  const okBody = JSON.stringify({ update: { 'app-version': 9 } });

  it('POSTs a JSON {"hq": {...}} body to edit_app_attr/<app_id>/all/ (defaults: grid root + per-module forms)', async () => {
    let capturedUrl = '';
    let capturedInit: { data?: string; headers?: Record<string, string> } | undefined;
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
      cookieCsrf: 'tok456',
      onPost: (url, init) => {
        capturedUrl = url;
        capturedInit = init;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.setAppMenuDisplay(args);

    // attr MUST be 'all' — use_grid_menus is not in the per-attr allowlist
    // (apps.py:762) and a per-attr URL would 400.
    expect(capturedUrl).toBe(
      `${baseUrl}/a/${args.domain}/apps/edit_app_attr/${args.app_id}/all/`,
    );
    expect(capturedInit?.headers?.['Content-Type']).toBe('application/json');
    expect(capturedInit?.headers?.['X-CSRFToken']).toBe('tok456');
    expect(capturedInit?.headers?.Referer).toContain(`/apps/view/${args.app_id}/`);

    // Native JSON types: BooleanProperty must receive true, not "true".
    expect(JSON.parse(capturedInit?.data ?? '{}')).toEqual({
      hq: { use_grid_menus: true, grid_form_menus: 'some' },
    });

    expect(out).toEqual({
      status: 200,
      use_grid_menus: true,
      grid_form_menus: 'some',
      app_version: 9,
    });
  });

  it('honors explicit flag values', async () => {
    let capturedInit: { data?: string } | undefined;
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
      onPost: (_url, init) => {
        capturedInit = init;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.setAppMenuDisplay({
      ...args,
      use_grid_menus: false,
      grid_form_menus: 'all',
    });
    expect(JSON.parse(capturedInit?.data ?? '{}')).toEqual({
      hq: { use_grid_menus: false, grid_form_menus: 'all' },
    });
    expect(out.use_grid_menus).toBe(false);
    expect(out.grid_form_menus).toBe('all');
  });

  it('GETs the apps/view/<app_id>/ refresh page before the POST (csrf+cookie warm)', async () => {
    const fake = fakeRequest({ postStatus: 200, postBody: okBody });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.setAppMenuDisplay(args);
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
    const out = await backend.setAppMenuDisplay(args);
    expect(out).toEqual({ status: 200, use_grid_menus: true, grid_form_menus: 'some' });
  });

  it('throws a generic Error on non-200 status (e.g. the 400 a per-attr URL would get)', async () => {
    const fake = fakeRequest({ postStatus: 400, postBody: '' });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.setAppMenuDisplay(args)).rejects.toThrow(/returned 400/);
  });
});
