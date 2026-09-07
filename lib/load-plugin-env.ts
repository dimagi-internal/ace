/**
 * Load the plugin-data `.env` into `process.env` for a script invoked from a
 * Bash tool call.
 *
 * ## Why this exists
 *
 * Each MCP server calls `dotenvConfig()` at module top level, so an MCP
 * *subprocess* has ACE's secrets. Nothing does that for the parent shell —
 * CLAUDE.md § Gotchas states it plainly: "values are loaded into MCP
 * subprocesses, not the parent shell, so `$ACE_*` in your shell will normally
 * be empty." A skill that runs `npx tsx scripts/<x>.ts` therefore starts with
 * none of them, and any script on that path has to load the file itself.
 *
 * `scripts/run-form-walk.ts` learned this the hard way (ace#993) and carries
 * the loader inline; `scripts/run-content-generator.ts` did not, so
 * `app-media-coverage` step 6 failed with "Set CONTENT_GENERATOR_URL and
 * CONTENT_GENERATOR_API_KEY in the env." on a machine where both were
 * provisioned (ace#1957). The remediation the skill documented,
 * `source ~/.ace/env.sh`, exports exactly one variable (`NOVA_API_KEY`), so
 * an operator who followed it still could not run the script.
 *
 * The gap is per-script, which is why it stayed invisible: the sibling worked.
 * This helper is the shared form so the next script gets it in one line
 * instead of a copied five, and so `loadPluginEnv(import.meta.url)` is a
 * single greppable marker for "this script is Bash-reachable and needs
 * secrets".
 *
 * ## Usage
 *
 *   import { loadPluginEnv } from '../lib/load-plugin-env.js';
 *   loadPluginEnv(import.meta.url);
 *
 * Call it in the module body BEFORE the first `process.env.<SECRET>` read.
 * ESM evaluates every `import` before any module body, so a module you import
 * that reads a secret at ITS top level is still too early — pass the value in
 * rather than reading it there.
 *
 * Existing `process.env` values always win: dotenv never overwrites a key that
 * is already present, so an explicit `export` in the shell still overrides the
 * file, and a deliberately-scrubbed var stays scrubbed.
 *
 * ## Why the banner is ours, and why it is on stderr (ace#2095)
 *
 * dotenv v17 prints `◇ injected env (N) from .env // tip: …` on **stdout**,
 * via `console.log`, unless it is passed `quiet: true`. There is no option to
 * route it to stderr — `lib/main.js` has exactly one sink for it. So a shared
 * helper that leaves it on writes to the stream its callers use for DATA.
 *
 * That is not hypothetical here; ACE has paid for it four times:
 *
 *   - `scripts/plan-avd-pool.ts --json` emitted the banner ahead of its JSON,
 *     so `jq .base` returned `parse error: Invalid numeric literal at line 1,
 *     column 4` (exit 5). Five of dotenv's eight rotating tips contain a `{`,
 *     so the obvious workaround — slice at the first brace — lands INSIDE the
 *     banner rather than at the JSON. That is ace#2095.
 *   - `scripts/doctor-ocs-generation.ts` splices its stdout verbatim into the
 *     orchestrator's `--preflight` YAML; one banner line stopped the snapshot
 *     parsing, with no human in the loop. It now hand-rolls a silent reader,
 *     gated by a test that bans the dotenv import outright.
 *   - `scripts/doctor-nova-scopes.ts` and `scripts/doctor-nova-header.ts`
 *     carry the same hand-rolled parser for the same stated reason.
 *
 * Three scripts paying a per-script tax to route around a shared helper is the
 * tell. So the helper takes the tax once: dotenv is silenced with
 * `quiet: true`, and this module emits its OWN line on **stderr**, which is
 * the stream that exists for exactly this — still visible to a human at a
 * terminal, absent from a pipe.
 *
 * The replacement line is not merely relocated, it answers the question the
 * dotenv one could not. dotenv prints a path relative to `process.cwd()`,
 * which for a plugin-data `.env` is an unreadable `../../../Library/…`; and
 * its `(N)` counts keys newly injected, so a fully-exported shell reports `0`
 * from a file with 40 keys and reads as "nothing loaded". Ours names the
 * absolute path, says whether it came from plugin data or the cwd fallback,
 * and says whether the file was actually there — which is precisely what
 * ace#1957's operator needed and did not get.
 *
 * Suppressing it per-script under `--json` was the rejected alternative: it is
 * per-script, so the next script to grow a `--json` flag re-introduces the
 * bug, and it inverts the normal stream convention.
 *
 * *Enforced:* `test/lib/load-plugin-env-streams.test.ts`.
 */

import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import { resolvePluginDataDir } from './plugin-data-dir.js';

export interface LoadedPluginEnv {
  /** The `.env` path dotenv was pointed at. */
  path: string;
  /** True when that path resolved from the installed plugin's DATA dir. */
  fromPluginData: boolean;
  /** True when the file existed and parsed. */
  loaded: boolean;
  /**
   * How many keys the file declared. NOT how many reached `process.env` —
   * dotenv skips a key that is already set, so an exported shell yields a
   * positive count here and zero new injections, which is correct and is the
   * distinction dotenv's own `(N)` blurred.
   */
  keys: number;
}

/**
 * Load `<plugin-data>/.env`, falling back to `<cwd>/.env` when the caller is
 * running from a dev checkout rather than the installed plugin cache. Returns
 * where it looked so a caller can name that path in its own error message —
 * "missing" is only actionable if the operator knows which file to look in.
 */
export function loadPluginEnv(callerMetaUrl: string): LoadedPluginEnv {
  const dataDir = resolvePluginDataDir(callerMetaUrl);
  const envPath = dataDir
    ? path.join(dataDir, '.env')
    : path.join(process.cwd(), '.env');
  const result = dotenvConfig({ path: envPath, quiet: true });
  const info: LoadedPluginEnv = {
    path: envPath,
    fromPluginData: dataDir !== null,
    loaded: result.error === undefined,
    keys: Object.keys(result.parsed ?? {}).length,
  };
  announce(info);
  return info;
}

/**
 * The stderr replacement for dotenv's stdout banner. Separate and exported so
 * the stream contract is testable without spawning a process, and so a caller
 * that has already loaded the file can restate it.
 *
 * `process.stderr.write` rather than `console.error`: no formatting, no
 * inspection of arguments, and nothing that could later be captured by a
 * `console` shim a script installs for its own output.
 */
export function announce(info: LoadedPluginEnv, stream: NodeJS.WritableStream = process.stderr): void {
  const origin = info.fromPluginData ? 'plugin data' : 'cwd fallback';
  const body = info.loaded
    ? `read ${info.keys} key(s) from ${info.path} (${origin})`
    : `no .env at ${info.path} (${origin}) — 0 key(s) read`;
  stream.write(`[ace-env] ${body}\n`);
}
