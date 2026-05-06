/**
 * Unit tests for `commcare_upload_multimedia` (CCHQ multimedia upload atom).
 *
 * The atom POSTs binary multimedia (PNG, JPEG, MP3, …) into a CCHQ app's
 * multimedia map so that subsequent `make_build` calls bundle it into the
 * generated CCZ. Live contract probed 2026-05-05 — see
 * `scripts/probe-multimedia-upload.ts` for the header gotchas; the most
 * important one here is that CCHQ returns Content-Type `text/html` even
 * though the body is valid JSON, so the parser MUST be tolerant of that.
 *
 * Tests cover:
 *   1. URL routing per media-type prefix (image, audio).
 *   2. Field mapping `ref.m_id → multimedia_id`, `ref.uid → file_hash_md5`
 *      (CCHQ uses md5, NOT sha1 — preserved verbatim from probe).
 *   3. CSRF refresh via the apps/view page + Referer header.
 *   4. 400 with `errors[]` payload surfacing.
 *   5. 302 → /accounts/login/ surfacing as a session-expired error.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommCareBackend } from '../../../../mcp/connect/backends/commcare.js';

interface FakeResponse {
  status: () => number;
  text: () => Promise<string>;
  headers: () => Record<string, string>;
}

function fakeRequest(opts: {
  postStatus: number;
  postBody: string;
  cookieCsrf?: string;
  postContentType?: string;
  onPost?: (url: string, init: { multipart?: unknown; data?: string; headers?: Record<string, string> }) => void;
}) {
  const calls: Array<{ method: 'get' | 'post'; url: string; init?: unknown }> = [];
  return {
    calls,
    request: {
      get: vi.fn(async (url: string) => {
        calls.push({ method: 'get', url });
        return { status: () => 200, text: async () => '', headers: () => ({}) } as FakeResponse;
      }),
      post: vi.fn(async (url: string, init: { multipart?: unknown; data?: string; headers?: Record<string, string> }) => {
        calls.push({ method: 'post', url, init });
        opts.onPost?.(url, init);
        return {
          status: () => opts.postStatus,
          text: async () => opts.postBody,
          headers: () => ({ 'content-type': opts.postContentType ?? 'text/html' }),
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

const SUCCESS_BODY = JSON.stringify({
  ref: {
    path: 'jr://file/commcare/image/x.png',
    uid: 'd'.repeat(32), // md5 hex
    m_id: '9'.repeat(32),
    url: '/hq/multimedia/file/CommCareImage/' + '9'.repeat(32) + '/',
    updated: false,
    media_type: 'Image',
  },
  errors: [],
});

const baseUrl = 'https://test.cchq';
const APP_ID = 'a'.repeat(32);

describe('CommCareBackend.uploadMultimedia', () => {
  it('POSTs to /multimedia/uploaded/image/ for image content types', async () => {
    let postedUrl = '';
    const fake = fakeRequest({
      postStatus: 200,
      postBody: SUCCESS_BODY,
      cookieCsrf: 'TOKEN',
      onPost: (url) => {
        postedUrl = url;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.uploadMultimedia({
      domain: 'demo',
      app_id: APP_ID,
      media_path: 'jr://file/commcare/image/x.png',
      file_bytes: Buffer.from('PNG'),
      content_type: 'image/png',
    });
    expect(postedUrl).toBe(`${baseUrl}/a/demo/apps/${APP_ID}/multimedia/uploaded/image/`);
  });

  it('returns multimedia_id (m_id) and file_hash_md5 (uid) from ref', async () => {
    const fake = fakeRequest({ postStatus: 200, postBody: SUCCESS_BODY, cookieCsrf: 'TOKEN' });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.uploadMultimedia({
      domain: 'demo',
      app_id: APP_ID,
      media_path: 'jr://file/commcare/image/x.png',
      file_bytes: Buffer.from('PNG'),
      content_type: 'image/png',
    });
    expect(out.multimedia_id).toBe('9'.repeat(32));
    expect(out.file_hash_md5).toBe('d'.repeat(32));
  });

  it('routes audio content types to /multimedia/uploaded/audio/', async () => {
    let postedUrl = '';
    const fake = fakeRequest({
      postStatus: 200,
      postBody: SUCCESS_BODY,
      cookieCsrf: 'TOKEN',
      onPost: (url) => {
        postedUrl = url;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.uploadMultimedia({
      domain: 'd',
      app_id: APP_ID,
      media_path: 'jr://file/commcare/audio/x.mp3',
      file_bytes: Buffer.from('MP3'),
      content_type: 'audio/mpeg',
    });
    expect(postedUrl).toMatch(/\/multimedia\/uploaded\/audio\/$/);
  });

  it('sets X-CSRFToken from cookies and uses the app-view page as Referer', async () => {
    let init: { headers?: Record<string, string> } | undefined;
    const fake = fakeRequest({
      postStatus: 200,
      postBody: SUCCESS_BODY,
      cookieCsrf: 'TOKEN',
      onPost: (_url, _init) => {
        init = _init;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.uploadMultimedia({
      domain: 'demo',
      app_id: APP_ID,
      media_path: 'jr://file/commcare/image/x.png',
      file_bytes: Buffer.from('PNG'),
      content_type: 'image/png',
    });
    expect(init?.headers?.['X-CSRFToken']).toBe('TOKEN');
    expect(init?.headers?.Referer).toBe(`${baseUrl}/a/demo/apps/view/${APP_ID}/`);
  });

  it('throws with errors[] payload when CCHQ returns 400', async () => {
    const fake = fakeRequest({
      postStatus: 400,
      postBody: JSON.stringify({ ref: null, errors: ['File extension does not match content_type'] }),
      cookieCsrf: 'TOKEN',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(
      backend.uploadMultimedia({
        domain: 'd',
        app_id: APP_ID,
        media_path: 'jr://file/commcare/image/x.png',
        file_bytes: Buffer.from('x'),
        content_type: 'image/png',
      }),
    ).rejects.toThrow(/extension does not match/);
  });

  it('throws on 302 redirect (session expired)', async () => {
    const fake = fakeRequest({
      postStatus: 302,
      postBody: '<html>login</html>',
      cookieCsrf: 'TOKEN',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(
      backend.uploadMultimedia({
        domain: 'd',
        app_id: APP_ID,
        media_path: 'jr://file/commcare/image/x.png',
        file_bytes: Buffer.from('x'),
        content_type: 'image/png',
      }),
    ).rejects.toThrow(/302|session/i);
  });
});
