/**
 * Unit tests for `connect_preflight_learn_app_user` — the CI-660 boundary
 * probe shipped to convert opaque `POST /users/start_learn_app/` 500s into
 * a structured Zod/JSON outcome before Phase 6 mobile navigation triggers
 * `create_hq_user_and_link` (which `users/views.py:107` doesn't try/except).
 *
 * Test surface:
 *   - 200 + no existing user → `action: 'would_create'`.
 *   - 200 + existing user, compatible → `action: 'would_reuse_existing'`.
 *   - 200 + existing user, linked to a different connect_username → `conflict_existing_user`.
 *   - 200 + existing user, inactive → `conflict_existing_user`.
 *   - 401/403 on step 1 → `auth_failed` with the rotate-key remediation.
 *   - 404 on step 1 → `domain_unreachable` with the typo-check remediation.
 *   - 5xx on step 1 → `cchq_error`.
 *   - Network failure on step 1 → `domain_unreachable`.
 *   - No `connect_username` supplied + 200 on step 1 → `skipped` happy path.
 *
 * Mocks: a `fetchImpl` stub is injected so no real HTTP fires. Each test
 * configures the queue of responses the stub returns in order.
 */
import { describe, it, expect, vi } from 'vitest';
import { preflightLearnAppUser } from '../../../../mcp/connect/backends/commcare-preflight.js';

/** Build a stub `fetch` whose responses come from a queue. */
function fakeFetch(
  responses: Array<{
    status: number;
    body?: string;
    json?: unknown;
    throws?: Error;
  }>,
): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const r = queue.shift();
    if (!r) throw new Error('fakeFetch: queue exhausted');
    if (r.throws) throw r.throws;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => r.body ?? (r.json !== undefined ? JSON.stringify(r.json) : ''),
      json: async () => (r.json !== undefined ? r.json : JSON.parse(r.body ?? '{}')),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const baseArgs = {
  hq_domain: 'connect-ace-prod',
  api_key: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  hq_username: 'ace@dimagi-ai.com',
} as const;

describe('preflightLearnAppUser — auth + reachability branch', () => {
  it('returns auth_failed on HTTP 401 (rotate-key remediation in reason)', async () => {
    const fetchImpl = fakeFetch([
      { status: 401, body: '{"error_message":"Incorrect authentication credentials."}' },
    ]);
    const out = await preflightLearnAppUser(
      { ...baseArgs, connect_username: 'ace-test-user' },
      fetchImpl,
    );
    expect(out.ok).toBe(false);
    expect(out.action).toBe('auth_failed');
    expect(out.reason).toMatch(/rotate|mint a new HQ API key/i);
    expect(out.cchq?.status).toBe(401);
    expect(out.cchq?.path).toContain('/api/v0.5/user/?limit=1');
  });

  it('returns auth_failed on HTTP 403', async () => {
    const fetchImpl = fakeFetch([{ status: 403, body: 'forbidden' }]);
    const out = await preflightLearnAppUser(baseArgs, fetchImpl);
    expect(out.action).toBe('auth_failed');
  });

  it('returns domain_unreachable on HTTP 404 with typo hint', async () => {
    const fetchImpl = fakeFetch([{ status: 404 }]);
    const out = await preflightLearnAppUser(
      { ...baseArgs, hq_domain: 'connect-ace-prod-typo' },
      fetchImpl,
    );
    expect(out.ok).toBe(false);
    expect(out.action).toBe('domain_unreachable');
    expect(out.reason).toMatch(/archived|spelling|typo/i);
  });

  it('returns cchq_error on HTTP 500', async () => {
    const fetchImpl = fakeFetch([
      { status: 500, body: '<html><h1>Server Error (500)</h1></html>' },
    ]);
    const out = await preflightLearnAppUser(baseArgs, fetchImpl);
    expect(out.action).toBe('cchq_error');
    expect(out.cchq?.status).toBe(500);
  });

  it('returns domain_unreachable on network throw', async () => {
    const fetchImpl = fakeFetch([
      { status: 0, throws: new Error('getaddrinfo ENOTFOUND www.commcarehq.org') },
    ]);
    const out = await preflightLearnAppUser(baseArgs, fetchImpl);
    expect(out.action).toBe('domain_unreachable');
    expect(out.reason).toContain('ENOTFOUND');
  });

  it('returns cchq_error on unexpected HTTP status (e.g. 418)', async () => {
    const fetchImpl = fakeFetch([{ status: 418, body: 'teapot' }]);
    const out = await preflightLearnAppUser(baseArgs, fetchImpl);
    expect(out.action).toBe('cchq_error');
  });
});

describe('preflightLearnAppUser — user-existence branch', () => {
  it('returns would_create when CCHQ user lookup is empty', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, json: { meta: { total_count: 1 }, objects: [{ username: 'other-user' }] } }, // step 1: list/limit=1
      { status: 200, json: { meta: { total_count: 0 }, objects: [] } }, // step 2: lookup
    ]);
    const out = await preflightLearnAppUser(
      { ...baseArgs, connect_username: 'fresh-user' },
      fetchImpl,
    );
    expect(out.ok).toBe(true);
    expect(out.action).toBe('would_create');
    expect(out.existing_user).toBeUndefined();
  });

  it('returns would_reuse_existing when a compatible user already exists', async () => {
    // "Compatible" = active + connect_username matches (or is empty).
    const fetchImpl = fakeFetch([
      { status: 200, json: { objects: [] } }, // step 1 passes
      {
        status: 200,
        json: {
          objects: [
            {
              username: 'ace-test-user',
              connect_username: 'ace-test-user', // matches request
              is_active: true,
            },
          ],
        },
      },
    ]);
    const out = await preflightLearnAppUser(
      { ...baseArgs, connect_username: 'ace-test-user' },
      fetchImpl,
    );
    expect(out.ok).toBe(true);
    expect(out.action).toBe('would_reuse_existing');
    expect(out.existing_user?.username).toBe('ace-test-user');
    expect(out.existing_user?.is_active).toBe(true);
  });

  it('treats legacy HQ-only user (connect_username null) as compatible', async () => {
    // A legacy mobile worker with no ConnectID linkage is fine for
    // re-linking — `create_hq_user_and_link` adds the link idempotently.
    const fetchImpl = fakeFetch([
      { status: 200, json: { objects: [] } },
      {
        status: 200,
        json: {
          objects: [
            { username: 'legacy-worker', connect_username: null, is_active: true },
          ],
        },
      },
    ]);
    const out = await preflightLearnAppUser(
      { ...baseArgs, connect_username: 'legacy-worker' },
      fetchImpl,
    );
    expect(out.ok).toBe(true);
    expect(out.action).toBe('would_reuse_existing');
  });

  it('returns conflict_existing_user when linked to a different connect_username', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, json: { objects: [] } },
      {
        status: 200,
        json: {
          objects: [
            {
              username: 'shared-worker',
              connect_username: 'someone-else@connectid', // mismatch
              is_active: true,
            },
          ],
        },
      },
    ]);
    const out = await preflightLearnAppUser(
      { ...baseArgs, connect_username: 'shared-worker' },
      fetchImpl,
    );
    expect(out.ok).toBe(false);
    expect(out.action).toBe('conflict_existing_user');
    expect(out.reason).toContain('someone-else@connectid');
    expect(out.reason).toMatch(/CommCareHQAPIException/);
    expect(out.existing_user?.connect_username).toBe('someone-else@connectid');
  });

  it('returns conflict_existing_user when the existing user is inactive', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, json: { objects: [] } },
      {
        status: 200,
        json: {
          objects: [
            {
              username: 'dormant-worker',
              connect_username: 'dormant-worker',
              is_active: false,
            },
          ],
        },
      },
    ]);
    const out = await preflightLearnAppUser(
      { ...baseArgs, connect_username: 'dormant-worker' },
      fetchImpl,
    );
    expect(out.ok).toBe(false);
    expect(out.action).toBe('conflict_existing_user');
    expect(out.reason).toMatch(/inactive|Reactivate/i);
    expect(out.existing_user?.is_active).toBe(false);
  });

  it('skips the user-existence branch when connect_username is omitted', async () => {
    const fetchImpl = fakeFetch([{ status: 200, json: { objects: [] } }]);
    const out = await preflightLearnAppUser(baseArgs, fetchImpl);
    expect(out.ok).toBe(true);
    expect(out.action).toBe('skipped');
    expect(out.reason).toMatch(/No connect_username supplied/);
  });

  it('surfaces malformed JSON from the user-lookup step as cchq_error', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, json: { objects: [] } },
      { status: 200, body: 'not json at all' },
    ]);
    const out = await preflightLearnAppUser(
      { ...baseArgs, connect_username: 'someone' },
      fetchImpl,
    );
    expect(out.action).toBe('cchq_error');
    expect(out.reason).toMatch(/was not JSON/);
  });
});

describe('preflightLearnAppUser — request shape', () => {
  it('includes ApiKey auth header and URL-encodes the username', async () => {
    const fetchSpy = vi.fn(async () =>
      ({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () => ({ objects: [] }),
      }) as unknown as Response,
    );
    await preflightLearnAppUser(
      { ...baseArgs, connect_username: 'user with spaces+symbols' },
      fetchSpy as unknown as typeof fetch,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>;
    const firstHeaders = calls[0][1].headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe(
      `ApiKey ${baseArgs.hq_username}:${baseArgs.api_key}`,
    );
    const secondUrl = String(calls[1][0]);
    // The username must be URL-encoded (space → %20, + → %2B).
    expect(secondUrl).toContain('username=user%20with%20spaces%2Bsymbols');
  });

  it('respects base_url override', async () => {
    const fetchSpy = vi.fn(async () =>
      ({
        status: 200,
        ok: true,
        text: async () => '',
        json: async () => ({ objects: [] }),
      }) as unknown as Response,
    );
    await preflightLearnAppUser(
      { ...baseArgs, base_url: 'https://staging.commcarehq.org' },
      fetchSpy as unknown as typeof fetch,
    );
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(String(calls[0][0])).toMatch(/^https:\/\/staging\.commcarehq\.org/);
  });
});
