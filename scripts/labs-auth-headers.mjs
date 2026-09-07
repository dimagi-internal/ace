#!/usr/bin/env node
/**
 * Native `headersHelper` for the connect-labs HTTP MCP server.
 *
 * Claude Code runs this command at connection time and merges the JSON object
 * it prints to stdout into the outbound request headers (docs: "Dynamic headers
 * for custom authentication"). It must print a JSON object of string->string
 * and exit 0.
 *
 * This replaced the old stdio->HTTP proxy (since removed) whose only jobs were
 * forwarding JSON-RPC frames and injecting the Bearer token. With a native
 * `type: "http"` entry, Claude Code handles the transport; this helper only has
 * to produce the auth header.
 *
 * Self-contained on purpose. The helper runs in an unspecified shell + CWD with
 * no guaranteed env-block propagation, so:
 *   - Runtime dep is `node` only (no tsx, no node_modules resolution). That's
 *     why this is `.mjs` with a `#!/usr/bin/env node` shebang rather than a
 *     `tsx` script importing lib/plugin-data-dir.ts.
 *   - We self-derive the plugin DATA dir from this file's own location instead
 *     of trusting `$CLAUDE_PLUGIN_DATA`, which Claude Code does NOT expand in
 *     plugin MCP configs (anthropics/claude-code#9427, still open on 2.1.153).
 *     `${CLAUDE_PLUGIN_ROOT}` IS expanded, so plugin.json points `headersHelper`
 *     at `${CLAUDE_PLUGIN_ROOT}/scripts/labs-auth-headers.mjs`.
 *
 * The derivation mirrors lib/plugin-data-dir.ts::derivePluginDataDir; the test
 * (test/mcp/connect-labs/headers-helper.test.ts) cross-checks the two so they
 * can't drift.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk an absolute file path looking for `plugins/cache/<mp>/<plugin>/<ver>/`
 * and compose the sibling `plugins/data/<mp>-<plugin>` dir. Returns null when
 * the path isn't inside an installed plugin (e.g. a dev checkout). Mirrors
 * lib/plugin-data-dir.ts::derivePluginDataDir, but takes an already-resolved
 * filesystem path rather than an import.meta.url.
 */
export function derivePluginDataDir(callerPath) {
  const parts = callerPath.split(path.sep);
  for (let i = 0; i < parts.length - 4; i++) {
    if (parts[i] === 'plugins' && parts[i + 1] === 'cache') {
      const marketplace = parts[i + 2];
      const plugin = parts[i + 3];
      const version = parts[i + 4];
      if (!marketplace || !plugin || !version) continue;
      const pluginsRoot = parts.slice(0, i + 1).join(path.sep);
      return path.join(pluginsRoot, 'data', `${marketplace}-${plugin}`);
    }
  }
  return null;
}

/** Extract a single key's value from `.env` file text. Mirrors the proxy's
 * parseEnvFile: skips blanks + `#` comments, splits on the first `=`, strips
 * surrounding quotes. Returns null when the key is absent. */
export function extractTokenFromEnv(envText, key = 'LABS_MCP_TOKEN') {
  for (const line of envText.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    return line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

/** Build the headers object Claude Code merges into the labs request. Empty
 * object when there's no token — never emit a `Bearer undefined`. */
export function buildAuthHeaders(token) {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Resolve the labs token. Order, matching the retired proxy's loadToken():
 *   1. `LABS_MCP_TOKEN` already in the environment (lets operators override).
 *   2. `<plugin-data-dir>/.env`, where the data dir is taken from
 *      `$CLAUDE_PLUGIN_DATA` if it's a real path, else self-derived from
 *      `callerPath`.
 *   3. A repo-root `.env` relative to this script (dev-checkout fallback).
 *   4. The canonical installed default `~/.claude/plugins/data/ace-ace/.env`
 *      (worktree-safe last resort). When this helper runs from a *worktree*
 *      checkout, `${CLAUDE_PLUGIN_ROOT}` resolves to the worktree path, so
 *      `derivePluginDataDir` finds no `plugins/cache/<mp>/<plugin>/<ver>`
 *      segment (returns null) AND the dev-root `.env` doesn't exist (the real
 *      env lives under ~/.claude). Without this candidate the helper emits {}
 *      headers, Claude Code connects to labs unauthenticated, the server 406s,
 *      and ZERO connect-labs atoms bind into the session (jjackson/ace#620).
 *      This mirrors bin/ace-doctor's DATA_DIR fallback so the helper's
 *      resolution order is never narrower than doctor's.
 * Returns null when no token is found anywhere.
 */
/**
 * The env key holding the token for a given identity.
 *
 * Unset identity -> `LABS_MCP_TOKEN`, ACE's own PAT and the default for every
 * session. A named identity -> `LABS_MCP_TOKEN_<NAME>`, e.g. `jjackson` reads
 * `LABS_MCP_TOKEN_JJACKSON`.
 *
 * Labs PATs are PER USER: the server resolves the caller straight off the token
 * (`MCPAccessToken.verify` returns `(token.user, token)`), so the token IS the
 * identity. ACE's own PAT cannot see opportunities outside its orgs, which is
 * correct and not something to route around -- when work genuinely needs a
 * human's access, it borrows that human's token deliberately and briefly.
 */
export function tokenKeyFor(identity) {
  if (!identity) return 'LABS_MCP_TOKEN';
  return `LABS_MCP_TOKEN_${identity.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function resolveToken(callerPath, env = process.env) {
  const identity = (env.LABS_MCP_IDENTITY || '').trim();
  const key = tokenKeyFor(identity);

  if (env[key]) return env[key];

  const candidates = [];
  if (env.CLAUDE_PLUGIN_DATA && env.CLAUDE_PLUGIN_DATA !== '${CLAUDE_PLUGIN_DATA}') {
    candidates.push(path.join(env.CLAUDE_PLUGIN_DATA, '.env'));
  }
  const derived = derivePluginDataDir(callerPath);
  if (derived) candidates.push(path.join(derived, '.env'));
  candidates.push(path.join(path.dirname(callerPath), '..', '.env'));
  const home = env.HOME || homedir();
  if (home) {
    candidates.push(path.join(home, '.claude', 'plugins', 'data', 'ace-ace', '.env'));
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const tok = extractTokenFromEnv(readFileSync(candidate, 'utf8'), key);
        if (tok) return tok;
      }
    } catch {
      // Unreadable candidate — keep trying the rest.
    }
  }
  // Deliberately NO fallback to LABS_MCP_TOKEN when an identity was named.
  // Falling back would run the call as ACE while the operator believes it is
  // running as someone else -- answers would come back plausibly scoped to the
  // wrong account with nothing in the transcript saying so. Failing loud costs
  // one error; failing quiet costs a wrong conclusion about real data.
  return null;
}

function main() {
  const callerPath = fileURLToPath(import.meta.url);
  const token = resolveToken(callerPath);
  if (!token) {
    process.stderr.write(
      `[labs-auth-headers] ${tokenKeyFor((process.env.LABS_MCP_IDENTITY || '').trim())} ` +
        'not found in env or .env; emitting empty headers\n',
    );
  }
  process.stdout.write(JSON.stringify(buildAuthHeaders(token)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
