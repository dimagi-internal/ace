/**
 * Tests for `lib/transient-retry.ts` — the shared classifier + retry
 * envelope extracted from `mcp/google-drive-server.ts` in PR-O so all
 * three MCPs (gdrive, OCS, Connect) share the same patterns.
 *
 * The bulk of pattern coverage already lives in
 * `test/mcp/gdrive/transient-error-classifier.test.ts` (which imports
 * the re-exported names from the gdrive server module — same backing
 * lib). This file pins the direct lib API + the new behaviors that PR-O
 * added on top (custom isTransient, custom initial backoff, etc.).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isTransientNetworkError,
  withTransientRetry,
} from '../../lib/transient-retry.js';

const noSleep = () => Promise.resolve();

describe('isTransientNetworkError (direct lib import)', () => {
  it('classifies ECONNRESET as transient', () => {
    expect(isTransientNetworkError({ code: 'ECONNRESET' })).toBe(true);
  });
  it('classifies fetch failed as transient', () => {
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true);
  });
  it('classifies 4xx as permanent', () => {
    expect(isTransientNetworkError({ code: 400 })).toBe(false);
  });
});

describe('withTransientRetry (direct lib import)', () => {
  it('uses custom isTransient classifier when provided', async () => {
    let attempts = 0;
    const op = async () => {
      attempts++;
      throw new Error('weird domain error');
    };
    const isTransient = (e: unknown) => /weird domain/.test(String((e as Error).message));
    await expect(
      withTransientRetry(op, { sleep: noSleep, isTransient }),
    ).rejects.toThrow(/weird domain/);
    expect(attempts).toBe(3); // retried because custom classifier matched
  });

  it('does NOT retry when custom classifier returns false', async () => {
    let attempts = 0;
    const op = async () => {
      attempts++;
      throw new Error('any error');
    };
    await expect(
      withTransientRetry(op, { sleep: noSleep, isTransient: () => false }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('respects initialBackoffMs', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const op = async () => {
      attempts++;
      const e: any = new Error('socket hang up');
      throw e;
    };
    await expect(
      withTransientRetry(op, { sleep, initialBackoffMs: 250, maxAttempts: 3 }),
    ).rejects.toThrow();
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });
});
