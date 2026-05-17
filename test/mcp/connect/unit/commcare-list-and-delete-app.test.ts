/**
 * Unit tests for `commcare_list_apps` and `commcare_delete_app` — the two
 * HQ atoms added to support `/ace:sweep hq`.
 *
 * Mock pattern mirrors `commcare-make-build.test.ts`: a fake APIRequestContext
 * scripts GET + POST responses; tests assert on URL, body, and headers.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend } from '../../../../mcp/connect/backends/commcare.js';
import { SessionExpiredError } from '../../../../mcp/connect/errors.js';

interface FakeResponse {
  status: () => number;
  text: () => Promise<string>;
  headers: () => Record<string, string>;
}

function makeFakeRequest(opts: {
  /** Response scripts for the first GET (refresh path). */
  getStatus?: number;
  getHeaders?: Record<string, string>;
  /** Response scripts for the first POST (delete) or second GET (list). */
  postStatus?: number;
  postBody?: string;
  postHeaders?: Record<string, string>;
  /** CSRF cookie value to surface via storageState. */
  cookieCsrf?: string;
  /** For list: the JSON body to return on GET. */
  listJsonBody?: string;
  listGetStatus?: number;
}) {
  const calls: Array<{ method: 'GET' | 'POST'; url: string; options?: unknown }> = [];
  return {
    calls,
    request: {
      get: vi.fn(async (url: string, options?: unknown) => {
        calls.push({ method: 'GET', url, options });
        // First GET in delete flow returns the listing-page status; in list
        // flow it returns the JSON body directly.
        if (opts.listJsonBody !== undefined) {
          return {
            status: () => opts.listGetStatus ?? 200,
            text: async () => opts.listJsonBody!,
            headers: () => ({}),
          } as FakeResponse;
        }
        return {
          status: () => opts.getStatus ?? 200,
          text: async () => '',
          headers: () => opts.getHeaders ?? {},
        } as FakeResponse;
      }),
      post: vi.fn(async (url: string, options?: unknown) => {
        calls.push({ method: 'POST', url, options });
        return {
          status: () => opts.postStatus ?? 302,
          text: async () => opts.postBody ?? '',
          headers: () => opts.postHeaders ?? { location: '/a/connect-ace-prod/dashboard/' },
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

function makeBackend(request: unknown): CommCareBackend {
  const session = {
    getContext: async () => ({ request }),
    invalidate: async () => {},
  };
  return new CommCareBackend({ baseUrl: 'https://www.commcarehq.org', session: session as never });
}

describe('CommCareBackend.listApps', () => {
  it('GETs /a/<domain>/api/v0.4/application/ and parses the objects array', async () => {
    const fake = makeFakeRequest({
      listJsonBody: JSON.stringify({
        objects: [
          { id: 'app-1', name: 'Turmeric Learn', doc_type: 'Application' },
          { id: 'app-2', name: 'Turmeric Deliver', doc_type: 'Application' },
        ],
      }),
    });
    const backend = makeBackend(fake.request);
    const out = await backend.listApps({ domain: 'connect-ace-prod' });
    expect(out.apps).toEqual([
      { id: 'app-1', name: 'Turmeric Learn', doc_type: 'Application' },
      { id: 'app-2', name: 'Turmeric Deliver', doc_type: 'Application' },
    ]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe('GET');
    expect(fake.calls[0].url).toContain('/a/connect-ace-prod/api/v0.4/application/');
  });

  it('falls back to _id when id field is absent (CCHQ alternate shape)', async () => {
    const fake = makeFakeRequest({
      listJsonBody: JSON.stringify({
        objects: [{ _id: 'app-3', name: 'Legacy' }],
      }),
    });
    const backend = makeBackend(fake.request);
    const out = await backend.listApps({ domain: 'd' });
    expect(out.apps).toEqual([{ id: 'app-3', name: 'Legacy', doc_type: undefined }]);
  });

  it('filters out entries missing both id and _id', async () => {
    const fake = makeFakeRequest({
      listJsonBody: JSON.stringify({
        objects: [{ name: 'orphan-no-id' }, { id: 'app-4', name: 'ok' }],
      }),
    });
    const backend = makeBackend(fake.request);
    const out = await backend.listApps({ domain: 'd' });
    expect(out.apps).toEqual([{ id: 'app-4', name: 'ok', doc_type: undefined }]);
  });

  it('throws on non-200 status', async () => {
    const fake = makeFakeRequest({ listJsonBody: 'forbidden', listGetStatus: 403 });
    const backend = makeBackend(fake.request);
    await expect(backend.listApps({ domain: 'd' })).rejects.toThrow(/403/);
  });

  it('throws SessionExpiredError on 302 to /login/', async () => {
    // listJsonBody is set so the GET branch fires; need to override status + headers
    const fake = {
      calls: [] as Array<{ method: 'GET'; url: string }>,
      request: {
        get: vi.fn(async (url: string) => {
          fake.calls.push({ method: 'GET' as const, url });
          return {
            status: () => 302,
            text: async () => '',
            headers: () => ({ location: '/accounts/login/?next=/a/d/' }),
          };
        }),
        storageState: vi.fn(async () => ({ cookies: [] })),
      } as never,
    };
    const session = {
      getContext: async () => ({ request: fake.request }),
      invalidate: vi.fn(async () => {}),
    };
    const backend = new CommCareBackend({
      baseUrl: 'https://www.commcarehq.org',
      session: session as never,
    });
    // SessionExpiredError triggers a retry, which will also 302 → throw on second
    // attempt. So the final error surfaces; assert it was eventually a SessionExpired
    // by checking that invalidate was called once.
    await expect(backend.listApps({ domain: 'd' })).rejects.toBeInstanceOf(SessionExpiredError);
    expect(session.invalidate).toHaveBeenCalledOnce();
  });
});

describe('CommCareBackend.deleteApp', () => {
  it('POSTs to /a/<domain>/apps/delete_app/<app_id>/ with CSRF header and returns {deleted:true} on 302 to dashboard', async () => {
    const fake = makeFakeRequest({
      cookieCsrf: 'csrf-xyz',
      postStatus: 302,
      postHeaders: { location: '/a/connect-ace-prod/dashboard/' },
    });
    const backend = makeBackend(fake.request);
    const out = await backend.deleteApp({ domain: 'connect-ace-prod', app_id: 'app-1' });
    expect(out).toEqual({ deleted: true });

    // First call: refresh GET to /a/<domain>/apps/
    expect(fake.calls[0].method).toBe('GET');
    expect(fake.calls[0].url).toBe('https://www.commcarehq.org/a/connect-ace-prod/apps/');

    // Second call: POST to delete_app
    const postCall = fake.calls.find((c) => c.method === 'POST');
    expect(postCall?.url).toBe('https://www.commcarehq.org/a/connect-ace-prod/apps/delete_app/app-1/');
    const opts = postCall?.options as { headers: Record<string, string> };
    expect(opts.headers['X-CSRFToken']).toBe('csrf-xyz');
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('throws SessionExpiredError when delete POST returns 302 to /login/', async () => {
    const fake = makeFakeRequest({
      cookieCsrf: 'csrf-xyz',
      postStatus: 302,
      postHeaders: { location: '/accounts/login/?next=/a/connect-ace-prod/' },
    });
    const session = {
      getContext: async () => ({ request: fake.request }),
      invalidate: vi.fn(async () => {}),
    };
    const backend = new CommCareBackend({
      baseUrl: 'https://www.commcarehq.org',
      session: session as never,
    });
    await expect(
      backend.deleteApp({ domain: 'connect-ace-prod', app_id: 'app-1' }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(session.invalidate).toHaveBeenCalledOnce();
  });

  it('throws on non-302 status (e.g. 403 from permission check)', async () => {
    const fake = makeFakeRequest({
      cookieCsrf: 'csrf-xyz',
      postStatus: 403,
      postBody: 'Forbidden',
    });
    const backend = makeBackend(fake.request);
    await expect(
      backend.deleteApp({ domain: 'connect-ace-prod', app_id: 'app-1' }),
    ).rejects.toThrow(/403/);
  });
});
