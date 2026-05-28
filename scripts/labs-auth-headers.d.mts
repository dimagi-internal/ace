/**
 * Type declarations for labs-auth-headers.mjs — the connect-labs HTTP MCP
 * `headersHelper`. The helper is authored as a node-only `.mjs` (no tsx) so it
 * can run in Claude Code's unspecified headersHelper shell with `node` as its
 * only runtime dependency; this `.d.mts` lets the test import its exported
 * pure helpers with types.
 */

/** Derive `plugins/data/<mp>-<plugin>` from an installed `plugins/cache/...`
 * path. Returns null for paths not under an installed plugin. */
export function derivePluginDataDir(callerPath: string): string | null;

/** Extract a key's value from `.env` file text (default `LABS_MCP_TOKEN`),
 * skipping comments/blanks and stripping surrounding quotes. */
export function extractTokenFromEnv(envText: string, key?: string): string | null;

/** Wrap a token as `{ Authorization: "Bearer <token>" }`; `{}` when falsy. */
export function buildAuthHeaders(
  token: string | null | undefined,
): Record<string, string>;

/** Resolve the labs token: env var → `<data-dir>/.env` → dev-root `.env`. */
export function resolveToken(
  callerPath: string,
  env?: Record<string, string | undefined>,
): string | null;
