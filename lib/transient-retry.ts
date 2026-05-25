/**
 * Generic transient-error classifier + retry envelope.
 *
 * Each ACE MCP backend (gdrive Drive API, OCS REST, Connect REST via
 * Playwright APIRequestContext) had its own narrow-regex classifier
 * before PR-O. The e2e-malaria-rdt 2026-05-24 session showed several
 * network failure shapes (ECONNREFUSED, socket hang up) fell through
 * to the caller without retry because the regexes didn't recognize
 * them — same bug class across all three MCPs.
 *
 * This module consolidates the classifier + retry envelope into one
 * pure helper so every MCP shares the same patterns. Add a new
 * transient pattern here and every consumer picks it up.
 *
 * Patterns covered (any → true / retryable):
 *   - HTTP 5xx (numeric code).
 *   - Timeouts ("timeout", ETIMEDOUT).
 *   - Connection resets / hang-ups / closed (ECONNRESET, "socket hang
 *     up", "socket close", "connection closed", EPIPE).
 *   - Connection refused / unreachable (ECONNREFUSED, ENETUNREACH,
 *     EHOSTUNREACH, ECONNABORTED, "connection refused").
 *   - DNS flakes (EAI_AGAIN, "getaddrinfo eai_again").
 *   - Generic undici fetch failures ("fetch failed").
 *
 * Patterns NOT retried:
 *   - 4xx (caller bug or auth).
 *   - 429 is callers' decision (some want to retry with longer
 *     backoff, others want to surface immediately).
 *   - Errors with no code AND no message.
 */

export function isTransientNetworkError(e: any): boolean {
  // Numeric HTTP 5xx
  const code = typeof e?.code === 'number' ? e.code : Number(e?.code);
  if (Number.isFinite(code) && code >= 500 && code < 600) return true;

  // Node-layer network errors as string codes
  const codeStr = String(e?.code ?? '').toUpperCase();
  if (
    codeStr === 'ECONNRESET' ||
    codeStr === 'ECONNREFUSED' ||
    codeStr === 'ECONNABORTED' ||
    codeStr === 'ETIMEDOUT' ||
    codeStr === 'ENETUNREACH' ||
    codeStr === 'EHOSTUNREACH' ||
    codeStr === 'EPIPE' ||
    codeStr === 'EAI_AGAIN'
  ) {
    return true;
  }

  const msg = String(e?.message || '').toLowerCase();
  if (
    /internal error|backend error|service unavailable|gateway|timeout|econnreset|econnrefused|econnaborted|etimedout|enetunreach|ehostunreach|epipe|eai_again|socket hang up|socket close|socket closed|connection closed|connection refused|fetch failed|getaddrinfo/.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

export interface TransientRetryOptions {
  maxAttempts?: number;
  /** Override sleep for tests (skip the actual wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Custom transient classifier — defaults to `isTransientNetworkError`. */
  isTransient?: (e: unknown) => boolean;
  /** Initial backoff in ms; doubles each attempt. Default 1000. */
  initialBackoffMs?: number;
}

/**
 * Run `op` with up to N attempts on transient errors. Backoff schedule
 * is `initialBackoffMs * 2^(attempt-1)` (default 1s/2s/4s). The final
 * failure rethrows so the caller still surfaces it.
 */
export async function withTransientRetry<T>(
  op: () => Promise<T>,
  opts: TransientRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initial = opts.initialBackoffMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const isTransient = opts.isTransient ?? isTransientNetworkError;
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (e: any) {
      lastErr = e;
      if (!isTransient(e)) throw e;
      if (attempt < maxAttempts) {
        const backoffMs = initial * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr;
}
