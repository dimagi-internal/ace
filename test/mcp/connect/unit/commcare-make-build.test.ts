/**
 * Unit tests for `commcare_make_build` and the `BuildRejectedError`
 * surface added 0.13.131.
 *
 * Background: CCHQ's `apps/save/<app_id>/` endpoint returns 200 with
 * `{saved_app: null, error_html: "..."}` when the emitted XForm fails
 * its build-time well-formedness check. Pre-0.13.131 the backend raised
 * a generic Error with the raw JSON inlined; the operator had to peek
 * at the CCHQ form designer UI to read the actual rejection reason
 * (form name, menu name, line/column, parser message). Now the backend
 * extracts `error_html`, summarises it via `summarizeServerErrorBody`,
 * and throws a typed `BuildRejectedError` with both a structured
 * `errorText` and the raw `errorHtml`.
 *
 * The fixture is the literal CCHQ rejection from
 * `leep-paint-collection/runs/20260509-2204` Phase 2: the architect's
 * Q5 in the "Unique ID check" form had a literal `<3 letters>`
 * placeholder that became invalid XML after Nova's emitter skipped
 * entity-encoding (filed upstream at voidcraft-labs/nova-plugin).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CommCareBackend,
  BuildRejectedError,
} from '../../../../mcp/connect/backends/commcare.js';

interface FakeResponse {
  status: () => number;
  text: () => Promise<string>;
}

function fakeRequest(opts: { postStatus: number; postBody: string; cookieCsrf?: string }) {
  return {
    request: {
      get: vi.fn(async () => ({
        status: () => 200,
        text: async () => '',
        headers: () => ({}),
      } as FakeResponse)),
      post: vi.fn(async () => ({
        status: () => opts.postStatus,
        text: async () => opts.postBody,
        headers: () => ({}),
      } as FakeResponse)),
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

describe('BuildRejectedError', () => {
  it('toJSON is structured for MCP responses', () => {
    const err = new BuildRejectedError(
      'app123',
      'Unique ID check Form: invalid element name at line 64',
      '<html>...raw...</html>',
    );
    expect(err.name).toBe('BuildRejectedError');
    expect(err.retryable).toBe(false);
    expect(err.toJSON()).toEqual({
      error: 'build_rejected',
      message: expect.stringContaining('app123'),
      app_id: 'app123',
      error_text: 'Unique ID check Form: invalid element name at line 64',
      error_html: '<html>...raw...</html>',
      retryable: false,
    });
  });
});

describe('CommCareBackend.makeBuild', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = { domain: 'connect-ace-prod', app_id: '18fc3bf1e0bd4a15998e065767ba3f06' };

  it('returns a build_id when CCHQ accepts the build', async () => {
    const okBody = JSON.stringify({
      saved_app: { _id: 'b1', version: 7, built_on: '2026-05-10T05:00:00Z' },
    });
    const fake = fakeRequest({ postStatus: 200, postBody: okBody, cookieCsrf: 'tok' });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.makeBuild(args);
    expect(out.build_id).toBe('b1');
    expect(out.version).toBe(7);
  });

  it('throws BuildRejectedError when CCHQ returns saved_app:null with error_html', async () => {
    // Reproduction from leep run 20260509-2204 — Q5's literal "<3 letters>"
    // placeholder became invalid XML after Nova's emitter skipped escaping.
    const errorHtml =
      '<div class="alert alert-build">Cannot make new version' +
      '<br>"Unique ID check" Form in the "5. Stage 2 — Unique ID rules" Menu ' +
      'Error parsing XML: StartTag: invalid element name, line 64, column 88 (&lt;string&gt;, line 64)' +
      '</div>';
    const rejectBody = JSON.stringify({ saved_app: null, error_html: errorHtml });
    const fake = fakeRequest({ postStatus: 200, postBody: rejectBody, cookieCsrf: 'tok' });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    await expect(backend.makeBuild(args)).rejects.toMatchObject({
      name: 'BuildRejectedError',
      app_id: args.app_id,
      retryable: false,
    });
  });

  it('BuildRejectedError.errorText is human-readable (HTML stripped)', async () => {
    const errorHtml =
      '<div class="alert alert-build">Cannot make new version' +
      '<br>"Unique ID check" Form: invalid element name, line 64</div>';
    const fake = fakeRequest({
      postStatus: 200,
      postBody: JSON.stringify({ saved_app: null, error_html: errorHtml }),
      cookieCsrf: 'tok',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    let captured: BuildRejectedError | null = null;
    try {
      await backend.makeBuild(args);
    } catch (e) {
      if (e instanceof BuildRejectedError) captured = e;
    }
    expect(captured).not.toBeNull();
    expect(captured!.errorText).not.toContain('<div');
    expect(captured!.errorText).toContain('Unique ID check');
    // Raw html preserved verbatim for callers wanting to re-parse.
    expect(captured!.errorHtml).toBe(errorHtml);
  });

  it('falls back to a descriptive Error when saved_app is null and no error_html present', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: JSON.stringify({ saved_app: null }),
      cookieCsrf: 'tok',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.makeBuild(args)).rejects.toThrow(/Unrecognized response shape/);
  });
});
