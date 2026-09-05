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
  const result = dotenvConfig({ path: envPath });
  return {
    path: envPath,
    fromPluginData: dataDir !== null,
    loaded: result.error === undefined,
  };
}
