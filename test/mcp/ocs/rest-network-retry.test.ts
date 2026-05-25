/**
 * Tests for `mcp/ocs/backends/rest.ts`'s PR-O network-retry envelope.
 *
 * Pre-PR-O the RestBackend only retried on 5xx/429 *responses* — if
 * fetch threw before returning a Response (ECONNRESET, ECONNREFUSED,
 * "socket hang up", "fetch failed", etc.) the error bubbled to the
 * caller immediately. PR-O wraps fetch in a try/catch on idempotent
 * (GET) requests and retries the network-level failure with the same
 * exponential backoff used for 5xx.
 *
 * Coverage:
 *   - Transient network error on a GET request retries up to maxRetries
 *     and ultimately succeeds.
 *   - Non-idempotent (POST) network errors do NOT retry — surface
 *     immediately (the request might have partially landed; idempotency
 *     is the caller's contract).
 *   - 4xx responses never retry (unchanged behavior).
 *   - 5xx responses still retry on GET (unchanged behavior).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock undici.fetch BEFORE importing RestBackend so the module picks up
// the mock. vi.mock hoists, so the factory uses vi.hoisted to share the
// spy reference with the test body.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', () => ({ fetch: fetchMock }));

import { RestBackend } from '../../../mcp/ocs/backends/rest.js';

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

describe('OCS RestBackend network retry (PR-O)', () => {
  let backend: RestBackend;

  beforeEach(() => {
    fetchMock.mockReset();
    backend = new RestBackend({
      baseUrl: 'https://ocs.example.com',
      token: 'test-token',
      maxRetries: 3,
      retryBackoffMs: 1, // tests don't need real backoff
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a GET that throws ECONNRESET and ultimately succeeds', async () => {
    const econnreset: any = new Error('socket hang up');
    econnreset.code = 'ECONNRESET';
    fetchMock
      .mockRejectedValueOnce(econnreset)
      .mockRejectedValueOnce(econnreset)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const r = await backend.request('GET', '/api/things/');
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a GET that throws ECONNREFUSED', async () => {
    const econnrefused: any = new Error('connect ECONNREFUSED 127.0.0.1');
    econnrefused.code = 'ECONNREFUSED';
    fetchMock
      .mockRejectedValueOnce(econnrefused)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const r = await backend.request('GET', '/api/things/');
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a GET that throws "fetch failed" (undici)', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const r = await backend.request('GET', '/api/things/');
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a POST that throws a network error (idempotency)', async () => {
    const e: any = new Error('socket hang up');
    e.code = 'ECONNRESET';
    fetchMock.mockRejectedValue(e);

    await expect(backend.request('POST', '/api/things/', {})).rejects.toThrow(
      /socket hang up/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows the network error after maxRetries exhausted', async () => {
    const e: any = new Error('connect ECONNREFUSED');
    e.code = 'ECONNREFUSED';
    fetchMock.mockRejectedValue(e);

    await expect(backend.request('GET', '/api/things/')).rejects.toThrow(
      /ECONNREFUSED/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a permanent (non-transient) error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Invalid URL'));

    await expect(backend.request('GET', '/api/things/')).rejects.toThrow(
      /Invalid URL/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries 5xx responses (unchanged behavior)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, 'Service Unavailable'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const r = await backend.request('GET', '/api/things/');
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry 4xx responses (unchanged behavior)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { detail: 'not found' }));

    await expect(backend.request('GET', '/api/things/')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
