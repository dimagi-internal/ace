/**
 * Is a running MCP subprocess executing from a plugin-cache directory that has
 * since been deleted? (dimagi-internal/ace#970)
 *
 * ## The failure
 *
 * MCP subprocesses are spawned from `~/.claude/plugins/cache/ace/ace/<version>/`
 * and live for the whole Claude Code session. When a newer version installs and
 * the old cache dir is pruned, the still-running subprocess keeps executing
 * from a path that no longer exists. The next lazy `require` inside a
 * dependency then fails — the reported symptom is
 * `browser.newContext: Cannot find module './../../../package.json'`, raised by
 * node's loader inside `playwright-core`'s `userAgent.js` and delivered as an
 * ordinary rejected promise.
 *
 * ACE cannot prevent it. What ACE can do is stop reporting it as a mysterious
 * playwright failure and name it.
 *
 * ## Why `session_freshness` does not already cover this — it reports PASS
 *
 * `session_freshness` compares `$ROOT/VERSION` against `installed_plugins.json`
 * — two ON-DISK facts. In this scenario the doctor launcher cannot find
 * `$CLAUDE_PLUGIN_ROOT/bin/ace-doctor` (that root is gone) and falls through to
 * the *new* `installPath`, where VERSION and the registry agree. So it prints a
 * reassuring PASS while a live subprocess executes from a deleted directory.
 * That is worse than blind.
 *
 * Pure by design: the caller resolves `rootExists`, so the decision is testable
 * without touching the filesystem. Same split as `lib/env-freshness.ts`.
 */

/** `…/plugins/cache/ace/ace/0.13.770/mcp/connect-server.ts` → root + version. */
export function pluginRootFromCommand(
  command: string,
): { root: string; version: string } | null {
  // `[^\s]*` rather than `.*` — a greedy match would swallow the command
  // prefix ("npm exec tsx ") into the returned root path.
  const m = command.match(/([^\s]*\/plugins\/cache\/[^/]+\/[^/]+\/([^/]+))\/mcp\/[a-z0-9-]+-server\.ts\b/);
  return m ? { root: m[1], version: m[2] } : null;
}

/**
 * Does this error look like the stale-cache module failure?
 *
 * Deliberately broad on the message (node phrases it several ways) and narrow
 * on the caller: the caller must ALSO have confirmed the plugin root is gone
 * before treating it as this class. Message-matching alone would mislabel an
 * ordinary missing dependency.
 */
export function isStaleCacheModuleError(message: string): boolean {
  return /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(message);
}

export interface CacheProc {
  pid: number;
  command: string;
  /** Resolved by the caller — this module does no I/O. */
  rootExists: boolean;
}

export interface StaleCacheProc {
  pid: number;
  server: string;
  version: string;
  root: string;
}

export interface CacheFreshnessResult {
  verdict: 'pass' | 'warn' | 'skip';
  stale: StaleCacheProc[];
  reason: string;
}

function serverName(command: string): string {
  return command.match(/\/mcp\/([a-z0-9-]+)-server\.ts\b/)?.[1] ?? command;
}

/**
 * Classify this session's MCP children by whether the directory they are
 * running from still exists.
 *
 * A process whose command carries no `plugins/cache/` segment (a dev checkout,
 * `npm run mcp:*`) is NOT judged — it is legitimately running from elsewhere,
 * and warning about it would be a false positive on every developer machine.
 */
export function classifyPluginCacheFreshness(input: {
  procs: CacheProc[];
  installedVersion?: string;
}): CacheFreshnessResult {
  const judged = input.procs.filter((p) => pluginRootFromCommand(p.command) !== null);

  if (judged.length === 0) {
    return {
      verdict: 'skip',
      stale: [],
      reason:
        'no MCP subprocess is running from a plugin-cache directory (dev checkout, ' +
        'or no ACE MCP children under this session) — nothing to check',
    };
  }

  const stale: StaleCacheProc[] = judged
    .filter((p) => !p.rootExists)
    .map((p) => {
      const parsed = pluginRootFromCommand(p.command)!;
      return { pid: p.pid, server: serverName(p.command), version: parsed.version, root: parsed.root };
    });

  if (stale.length === 0) {
    return {
      verdict: 'pass',
      stale: [],
      reason: `all ${judged.length} MCP subprocess(es) are running from a cache directory that still exists`,
    };
  }

  const detail = stale.map((s) => `${s.server}(pid ${s.pid}) v${s.version}`).join(', ');
  const installed = input.installedVersion ? ` Installed is v${input.installedVersion}.` : '';
  return {
    verdict: 'warn',
    stale,
    reason:
      `${stale.length} MCP subprocess(es) are executing from a plugin-cache directory that ` +
      `NO LONGER EXISTS (${detail}).${installed} The next lazy module load in those processes ` +
      `will fail with "Cannot find module", which surfaces as an unrelated-looking ` +
      `playwright/browser error. Quit and reopen Claude Code (Cmd-Q) — /reload-plugins does ` +
      `NOT respawn MCP subprocesses.`,
  };
}
