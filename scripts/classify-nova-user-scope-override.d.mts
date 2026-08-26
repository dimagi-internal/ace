/**
 * Type surface for the plain-node CLI helper (dimagi-internal/ace#1629).
 *
 * Deliberately a `.d.mts` beside a `.mjs` rather than a `.ts` compiled through
 * tsx — same reason as `clear-nova-needs-auth-cache.d.mts`: `bin/ace-doctor`
 * runs this on the preflight hot path, where plain `node` starts in
 * milliseconds and `npx tsx` does not.
 */

/**
 * `workaround` — the entry carries a static `Authorization` header, i.e. it is
 * the voidcraft-labs/nova-plugin#52 workaround and MUST be left in place.
 * `stale` — an override with no credential of its own, which shadows the Nova
 * plugin's PAT-aware entry for nothing.
 */
export type NovaUserScopeOverrideClass = 'workaround' | 'stale';

/**
 * Classify `claude mcp get nova` output. Input is PAT-bearing and is never
 * echoed — the caller pipes it on stdin and only the token is printed.
 */
export function classifyNovaUserScopeOverride(
  mcpGetOutput: string | null | undefined,
): NovaUserScopeOverrideClass;
