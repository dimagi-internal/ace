/**
 * Unit tests for the PlaywrightBackend lazy-`request` resolver (CL-1, 0.13.17).
 *
 * Background: pre-0.13.17, `PlaywrightBackend` cached the `APIRequestContext`
 * passed to its constructor as a private field. `RestBackend.reauth()` calls
 * `session.invalidate()` (which closes the underlying BrowserContext) and
 * then `session.getContext()` to rebuild via `hqOAuthLogin`. The new
 * `BrowserContext` produces a fresh `APIRequestContext`, but the
 * PlaywrightBackend kept holding the dead one — every subsequent Playwright
 * read failed with `apiRequestContext.get: Target page, context or browser
 * has been closed`. Surfaced in the leep-paint-collection 2026-05-05 e2e run
 * (Phase 3 connect-opp-setup_BLOCKED.md).
 *
 * Fix: PlaywrightBackend now accepts an optional `session` and resolves
 * `request` lazily on every call via `session.peekRequest()`. A
 * RestBackend reauth that closes the cached context is followed by
 * `getContext()` rebuilding a new one; the next PlaywrightBackend call
 * picks up the fresh handle automatically. Tests omit `session` and the
 * lazy getter falls back to the constructor-bound static handle.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';
import type { PlaywrightSession } from '../../../../mcp/connect/auth/playwright-session.js';

function fakeRequestContext(label: string, scriptedHtml: string): APIRequestContext {
  const respond = (): APIResponse => ({
    status: () => 200,
    headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
    text: async () => scriptedHtml,
  } as unknown as APIResponse);
  // We tag both methods with the label so test assertions can identify
  // which underlying request handle actually serviced the call.
  return {
    __label: label,
    get: async () => respond(),
    post: async () => respond(),
  } as unknown as APIRequestContext;
}

const PROGRAMS_LIST_HTML = `<table><tr></tr></table>`;

describe('PlaywrightBackend lazy request resolution', () => {
  it('uses session.peekRequest() over the constructor-bound handle when both are wired', async () => {
    const stale = fakeRequestContext('stale', PROGRAMS_LIST_HTML);
    const fresh = fakeRequestContext('fresh', PROGRAMS_LIST_HTML);
    let current: APIRequestContext = fresh;
    const session = {
      peekRequest: () => current,
    } as unknown as PlaywrightSession;
    const backend = new PlaywrightBackend({
      baseUrl: 'https://connect.dimagi.com',
      csrfToken: 'csrf',
      request: stale,
      session,
    });
    // Spy on each handle's `get` so we can tell which one was actually used.
    let staleHits = 0;
    let freshHits = 0;
    (stale as unknown as { get: () => Promise<APIResponse> }).get = async () => {
      staleHits += 1;
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => PROGRAMS_LIST_HTML,
      } as unknown as APIResponse;
    };
    (fresh as unknown as { get: () => Promise<APIResponse> }).get = async () => {
      freshHits += 1;
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => PROGRAMS_LIST_HTML,
      } as unknown as APIResponse;
    };

    await backend.listPrograms({ organization_slug: 'pm-org' });

    expect(freshHits).toBe(1);
    expect(staleHits).toBe(0);
  });

  it('picks up a refreshed request handle after invalidate() simulates RestBackend.reauth()', async () => {
    // Round 1: session has request handle A (cached). Backend uses A.
    // Then we simulate a reauth by mutating the session's currently-returned
    // handle to B. Round 2: backend should now use B without rebuild.
    const a = fakeRequestContext('A', PROGRAMS_LIST_HTML);
    const b = fakeRequestContext('B', PROGRAMS_LIST_HTML);
    let current: APIRequestContext | undefined = a;
    const session = {
      peekRequest: () => current,
    } as unknown as PlaywrightSession;
    const aHits: number[] = [];
    const bHits: number[] = [];
    (a as unknown as { get: () => Promise<APIResponse> }).get = async () => {
      aHits.push(Date.now());
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => PROGRAMS_LIST_HTML,
      } as unknown as APIResponse;
    };
    (b as unknown as { get: () => Promise<APIResponse> }).get = async () => {
      bHits.push(Date.now());
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => PROGRAMS_LIST_HTML,
      } as unknown as APIResponse;
    };
    const backend = new PlaywrightBackend({
      baseUrl: 'https://connect.dimagi.com',
      csrfToken: 'csrf',
      request: a, // pre-reauth handle
      session,
    });

    await backend.listPrograms({ organization_slug: 'pm-org' });
    expect(aHits.length).toBe(1);
    expect(bHits.length).toBe(0);

    // Simulate RestBackend.reauth(): invalidate then getContext rebuilds with B.
    current = b;

    await backend.listPrograms({ organization_slug: 'pm-org' });
    expect(aHits.length).toBe(1); // still 1 — A was NOT touched again
    expect(bHits.length).toBe(1); // B serviced the second call
  });

  it('falls back to the constructor-bound handle when no session is wired (test path)', async () => {
    const ctx = fakeRequestContext('only', PROGRAMS_LIST_HTML);
    let hits = 0;
    (ctx as unknown as { get: () => Promise<APIResponse> }).get = async () => {
      hits += 1;
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => PROGRAMS_LIST_HTML,
      } as unknown as APIResponse;
    };
    const backend = new PlaywrightBackend({
      baseUrl: 'https://connect.dimagi.com',
      csrfToken: 'csrf',
      request: ctx,
      // session: undefined  — pre-0.13.17 behaviour preserved for tests
    });
    await backend.listPrograms({ organization_slug: 'pm-org' });
    expect(hits).toBe(1);
  });

  it('falls back to the constructor handle when session.peekRequest() returns undefined (transient)', async () => {
    // Models the tiny window between session.invalidate() (which clears the
    // cached context) and the next session.getContext() call. peekRequest()
    // returns undefined; the backend should not crash — it should use the
    // constructor handle as a soft fallback. The next getContext() will
    // re-cache, after which subsequent calls pick up the new handle.
    const ctx = fakeRequestContext('fallback', PROGRAMS_LIST_HTML);
    let hits = 0;
    (ctx as unknown as { get: () => Promise<APIResponse> }).get = async () => {
      hits += 1;
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html' }),
        text: async () => PROGRAMS_LIST_HTML,
      } as unknown as APIResponse;
    };
    const session = {
      peekRequest: () => undefined,
    } as unknown as PlaywrightSession;
    const backend = new PlaywrightBackend({
      baseUrl: 'https://connect.dimagi.com',
      csrfToken: 'csrf',
      request: ctx,
      session,
    });
    await backend.listPrograms({ organization_slug: 'pm-org' });
    expect(hits).toBe(1);
  });
});
