/**
 * Resolve the plugin DATA dir without relying on Claude Code's
 * `${CLAUDE_PLUGIN_DATA}` substitution.
 *
 * Background: anthropics/claude-code#9427 documents that Claude Code fails
 * to substitute `${CLAUDE_PLUGIN_DATA}` inside env blocks of plugin MCP
 * configs — in our testing (2026-04-21, Claude Code 2.1.116), this reproduces
 * for BOTH a `.mcp.json` at plugin root AND an inline `mcpServers` block in
 * `plugin.json`, even when the value is a pure pass-through. Interestingly,
 * `${CLAUDE_PLUGIN_ROOT}` in the `args` field DOES get substituted in the same
 * session (the MCP server launches from the correct versioned cache dir), so
 * the bug is specific to env-block expansion.
 *
 * Rather than depend on an upstream fix, MCP servers in ACE derive the DATA
 * dir from their own module path at runtime. When a plugin is installed via
 * the marketplace, Node loads the server from:
 *
 *   <claude-home>/plugins/cache/<marketplace>/<plugin>/<version>/mcp/<file>.ts
 *
 * The corresponding DATA dir is:
 *
 *   <claude-home>/plugins/data/<marketplace>-<plugin>
 *
 * We walk up from the caller's `import.meta.url`, look for the
 * `plugins/cache/...` segment, and compose the `data/...` sibling. When the
 * server is running from a dev checkout (e.g. `npm run mcp:gdrive` in a
 * local clone), the path won't match and we return null — callers fall
 * through to their existing cwd-based or legacy fallbacks.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface DerivedPluginDataDir {
  path: string;
  marketplace: string;
  plugin: string;
  version: string;
}

/**
 * Walk the caller's module path looking for `plugins/cache/<mp>/<plugin>/<version>/`
 * and compose the sibling `plugins/data/<mp>-<plugin>` path.
 */
export function derivePluginDataDir(callerMetaUrl: string): DerivedPluginDataDir | null {
  const callerPath = fileURLToPath(callerMetaUrl);
  const parts = callerPath.split(path.sep);

  // Need at least: plugins, cache, <mp>, <plugin>, <version>, ...
  for (let i = 0; i < parts.length - 4; i++) {
    if (parts[i] === 'plugins' && parts[i + 1] === 'cache') {
      const marketplace = parts[i + 2];
      const plugin = parts[i + 3];
      const version = parts[i + 4];
      if (!marketplace || !plugin || !version) continue;
      const pluginsRoot = parts.slice(0, i + 1).join(path.sep);
      const dataDir = path.join(pluginsRoot, 'data', `${marketplace}-${plugin}`);
      return { path: dataDir, marketplace, plugin, version };
    }
  }
  return null;
}

/**
 * Resolve the effective DATA dir for this plugin.
 *
 * Order:
 *   1. `$CLAUDE_PLUGIN_DATA` if set to a path that exists (lets operators
 *      override explicitly, and lets future Claude Code versions that
 *      actually pass it through work without change).
 *   2. Path derived from `callerMetaUrl` if it resolves to an existing dir
 *      (covers the 9427 case where Claude Code doesn't expand env).
 *   3. null (caller decides what to do).
 *
 * The "exists" check is load-bearing: a broken `${CLAUDE_PLUGIN_DATA}`
 * substitution may leave the env var set to the literal string
 * `"${CLAUDE_PLUGIN_DATA}"` or to an empty string — both untruthy for our
 * purposes, so we want to fall through to derivation in those cases.
 */
export function resolvePluginDataDir(callerMetaUrl: string): string | null {
  const envDir = process.env.CLAUDE_PLUGIN_DATA;
  if (envDir && envDir !== '${CLAUDE_PLUGIN_DATA}' && fs.existsSync(envDir)) {
    return envDir;
  }
  const derived = derivePluginDataDir(callerMetaUrl);
  if (derived && fs.existsSync(derived.path)) {
    return derived.path;
  }
  return null;
}

/**
 * One-line stderr diagnostic showing which env-var and derivation branches
 * resolved or didn't. Designed to land in the Claude Code MCP log so the
 * next debugger has a zero-setup way to verify what Claude Code passed in.
 *
 * Call this once, early, from the MCP server entrypoint. Keep it a single
 * line so it's easy to grep.
 */
export function logPluginDataDirDiag(serverName: string, callerMetaUrl: string): void {
  const envRaw = process.env.CLAUDE_PLUGIN_DATA;
  const rootRaw = process.env.CLAUDE_PLUGIN_ROOT;
  const derived = derivePluginDataDir(callerMetaUrl);
  const resolved = resolvePluginDataDir(callerMetaUrl);
  const diag = {
    server: serverName,
    env_CLAUDE_PLUGIN_DATA: envRaw ?? null,
    env_CLAUDE_PLUGIN_ROOT: rootRaw ?? null,
    // Diagnostic echo declared in plugin.json mcpServers.<name>.env.
    // If this comes through expanded (a real path) but env_CLAUDE_PLUGIN_DATA
    // is null/literal, we've confirmed Claude Code substitutes some env
    // values and not others. If BOTH come through literal, substitution is
    // broken wholesale. See anthropics/claude-code#9427.
    env_CLAUDE_PLUGIN_ROOT_ECHO: process.env.CLAUDE_PLUGIN_ROOT_ECHO ?? null,
    derived_data_dir: derived?.path ?? null,
    derived_version: derived?.version ?? null,
    resolved_data_dir: resolved,
  };
  // Single-line JSON so it's both human-readable and machine-parseable in
  // the MCP log capture.
  process.stderr.write(`[ace-plugin-data-dir] ${JSON.stringify(diag)}\n`);
}
