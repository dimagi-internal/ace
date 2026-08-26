/**
 * Type surface for the plain-node CLI helper (dimagi-internal/ace#1579).
 *
 * Deliberately a `.d.mts` beside a `.mjs` rather than a `.ts` compiled through
 * tsx: `bin/ace-doctor` runs this on the preflight hot path, where plain `node`
 * starts in milliseconds and `npx tsx` does not.
 */

/** What the clear attempt did, for the caller to report to the operator. */
export type NovaNeedsAuthClearResult = 'cleared' | 'absent' | 'unparseable';

/**
 * Remove a stuck `plugin:nova:nova` entry from Claude Code's needs-auth cache.
 *
 * Idempotent, and never rewrites a cache it cannot parse. Only call when a
 * valid `NOVA_API_KEY` is present — that is what proves the entry is stale.
 */
export function clearNovaNeedsAuthEntry(file: string | null | undefined): NovaNeedsAuthClearResult;
