/**
 * Tests for `isTransientDriveError` — the classifier that gates the
 * exponential-backoff retry around every Drive API call.
 *
 * Coverage: the rescan of e2e-malaria-rdt (2026-05-24) showed two hard
 * network errors interrupt an autonomous run despite withTransientRetry
 * being wired up — because the classifier's regex didn't recognize the
 * specific error shapes (ECONNREFUSED, socket-close). PR-I broadens the
 * classifier; these tests pin down each transient pattern so future
 * narrowings don't regress.
 *
 * Patterns covered (any → true):
 *   - HTTP 5xx (numeric code, string code, message text)
 *   - Connection reset / hang-up / closed (ECONNRESET, socket hang up)
 *   - Connection refused / unreachable
 *   - Timeouts
 *   - DNS flakes (EAI_AGAIN)
 *   - Undici fetch-failed
 *
 * Patterns NOT covered (any → false):
 *   - 4xx HTTP codes (caller bug, retry wouldn't help)
 *   - Auth errors
 *   - Truly empty errors
 */

import { describe, it, expect } from 'vitest';
import {
  isTransientDriveError,
  withTransientRetry,
} from '../../../mcp/google-drive-server.js';

describe('isTransientDriveError', () => {
  describe('transient (returns true)', () => {
    it.each([
      ['HTTP 500 (numeric code)',        { code: 500 }],
      ['HTTP 502 (numeric code)',        { code: 502 }],
      ['HTTP 503 (numeric code)',        { code: 503 }],
      ['HTTP 504 (numeric code)',        { code: 504 }],
      ['HTTP 599 (numeric code)',        { code: 599 }],
      ['internal error (message)',       { message: 'Internal Error' }],
      ['backend error (message)',        { message: 'Backend Error' }],
      ['service unavailable (message)',  { message: 'Service Unavailable' }],
      ['gateway timeout (message)',      { message: 'Bad Gateway' }],
      ['ECONNRESET (code)',              { code: 'ECONNRESET' }],
      ['ECONNRESET (message)',           { message: 'socket: read ECONNRESET' }],
      ['ECONNREFUSED (code)',            { code: 'ECONNREFUSED' }],
      ['ECONNREFUSED (message)',         { message: 'connect ECONNREFUSED 127.0.0.1:443' }],
      ['ECONNABORTED (code)',            { code: 'ECONNABORTED' }],
      ['ETIMEDOUT (code)',               { code: 'ETIMEDOUT' }],
      ['ENETUNREACH (code)',             { code: 'ENETUNREACH' }],
      ['EHOSTUNREACH (code)',            { code: 'EHOSTUNREACH' }],
      ['EPIPE (code)',                   { code: 'EPIPE' }],
      ['EAI_AGAIN (code)',               { code: 'EAI_AGAIN' }],
      ['EAI_AGAIN (message)',            { message: 'getaddrinfo EAI_AGAIN mcp.commcare.app' }],
      ['socket hang up (message)',       { message: 'socket hang up' }],
      ['socket close (message)',         { message: 'socket close' }],
      ['connection closed (message)',    { message: 'connection closed' }],
      ['connection refused (message)',   { message: 'connection refused' }],
      ['fetch failed (undici)',          { message: 'fetch failed' }],
      ['timeout (generic message)',      { message: 'request timeout' }],
    ])('classifies %s as transient', (_label, err) => {
      expect(isTransientDriveError(err)).toBe(true);
    });

    it('classifies a TypeError with a transient message as transient', () => {
      const e = new TypeError('fetch failed');
      expect(isTransientDriveError(e)).toBe(true);
    });
  });

  describe('permanent (returns false)', () => {
    it.each([
      ['HTTP 400 (Bad Request)',         { code: 400 }],
      ['HTTP 401 (Unauthorized)',        { code: 401 }],
      ['HTTP 403 (Forbidden)',           { code: 403 }],
      ['HTTP 404 (Not Found)',           { code: 404 }],
      ['HTTP 429 (Rate Limit)',          { code: 429 }],
      ['no code, no message',            {}],
      ['caller bug (message)',           { message: 'Invalid argument: fileId is required' }],
      ['permission denied (message)',    { message: 'The user does not have sufficient permissions' }],
    ])('classifies %s as permanent', (_label, err) => {
      expect(isTransientDriveError(err)).toBe(false);
    });
  });
});

describe('withTransientRetry', () => {
  const noSleep = () => Promise.resolve();

  it('retries up to 3 times on transient errors and ultimately succeeds', async () => {
    let attempts = 0;
    const op = async () => {
      attempts++;
      if (attempts < 3) {
        const e: any = new Error('socket hang up');
        e.code = 'ECONNRESET';
        throw e;
      }
      return 'ok';
    };
    const r = await withTransientRetry(op, { sleep: noSleep });
    expect(r).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry permanent (4xx) errors', async () => {
    let attempts = 0;
    const op = async () => {
      attempts++;
      const e: any = new Error('Not Found');
      e.code = 404;
      throw e;
    };
    await expect(withTransientRetry(op, { sleep: noSleep })).rejects.toThrow(/Not Found/);
    expect(attempts).toBe(1);
  });

  it('rethrows the last transient error after maxAttempts', async () => {
    let attempts = 0;
    const op = async () => {
      attempts++;
      const e: any = new Error('connect ECONNREFUSED 127.0.0.1:443');
      e.code = 'ECONNREFUSED';
      throw e;
    };
    await expect(withTransientRetry(op, { sleep: noSleep })).rejects.toThrow(/ECONNREFUSED/);
    expect(attempts).toBe(3);
  });

  it('respects custom maxAttempts', async () => {
    let attempts = 0;
    const op = async () => {
      attempts++;
      const e: any = new Error('socket hang up');
      throw e;
    };
    await expect(
      withTransientRetry(op, { sleep: noSleep, maxAttempts: 5 }),
    ).rejects.toThrow(/socket hang up/);
    expect(attempts).toBe(5);
  });
});
