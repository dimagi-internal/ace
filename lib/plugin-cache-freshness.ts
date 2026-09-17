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

// ── Version DRIFT: the sibling failure where the old cache dir is still there ──

/**
 * Is a running MCP subprocess executing OLD code from a directory that still
 * exists? (dimagi-internal/ace#2394)
 *
 * `classifyPluginCacheFreshness` above only fires when the directory has been
 * DELETED. A session that auto-updated on startup can spawn its MCP children
 * from the previous version ~1s before the registry is rewritten, and then
 * both existing probes report PASS:
 *
 * - `session_freshness` compares `$ROOT/VERSION` against
 *   `installed_plugins.json` — two ON-DISK facts, which agree;
 * - `cache_freshness` sees `rootExists === true`, because `0.13.1445/` is
 *   still sitting next to `0.13.1446/`.
 *
 * Nothing observed the one fact that matters: the version in the live
 * subprocess's own argv. Measured 2026-09-15 — five MCP children on
 * `0.13.1445` while the registry read `0.13.1446`, so `verify_run_claims`
 * (shipped in 1446) resolved to nothing and every claim came back
 * `NOT REACHED`. The operator reads that as "the run didn't address the
 * counterpart's asks" rather than "the atom wasn't loaded", which is the
 * expensive part: the probe's own absence is reported as a property of the run.
 *
 * **Judge the VERSION FILE, not the directory name.** `CLAUDE.md § Check the
 * running subprocess` records that the cache dir is NAMED from
 * `.claude-plugin/plugin.json` but FILLED from the marketplace clone's HEAD, so
 * the name can lie in both directions — on 2026-07-27 `cache/ace/ace/0.13.667/`
 * contained `0.13.670` code. A check that compared directory names would have
 * reported that healthy session as stale. The caller resolves
 * `<root>/VERSION`; the name is only a fallback for when it cannot be read.
 *
 * Pure by design, same split as the two classifiers above.
 */
export interface ChildVersionProc {
  pid: number;
  command: string;
  /** Contents of `<root>/VERSION`, trimmed. Resolved by the caller; null if unreadable. */
  rootVersionFile: string | null;
  /** Resolved by the caller — a missing root belongs to cache_freshness, not here. */
  rootExists: boolean;
}

export interface DriftedProc {
  pid: number;
  server: string;
  /** What the process is actually running, authoritative where available. */
  running: string;
  /** The directory name, kept because it is what a `ps` by hand shows. */
  dirName: string;
  /** True when `<root>/VERSION` could not be read and dirName was used instead. */
  fromDirName: boolean;
}

export interface ChildVersionDriftResult {
  verdict: 'pass' | 'warn' | 'skip';
  drifted: DriftedProc[];
  reason: string;
}

export function classifyMcpChildVersionDrift(input: {
  procs: ChildVersionProc[];
  installedVersion?: string;
}): ChildVersionDriftResult {
  const installed = (input.installedVersion ?? '').trim();
  const judged = (input.procs ?? []).filter(
    (p) => p && pluginRootFromCommand(p.command) !== null && p.rootExists,
  );

  if (!installed) {
    return {
      verdict: 'skip',
      drifted: [],
      reason:
        'installed plugin version is unknown (registry unreadable) — nothing to compare the ' +
        'running subprocesses against',
    };
  }
  if (judged.length === 0) {
    return {
      verdict: 'skip',
      drifted: [],
      reason:
        'no MCP subprocess is running from an existing plugin-cache directory (dev checkout, ' +
        'or the directory is gone — cache_freshness owns that case)',
    };
  }

  const drifted: DriftedProc[] = [];
  for (const p of judged) {
    const dirName = pluginRootFromCommand(p.command)!.version;
    const fromFile = (p.rootVersionFile ?? '').trim();
    const running = fromFile || dirName;
    if (running !== installed) {
      drifted.push({
        pid: p.pid,
        server: serverName(p.command),
        running,
        dirName,
        fromDirName: fromFile === '',
      });
    }
  }

  if (drifted.length === 0) {
    return {
      verdict: 'pass',
      drifted: [],
      reason: `all ${judged.length} MCP subprocess(es) are running v${installed}, matching the installed plugin`,
    };
  }

  const detail = drifted
    .map(
      (d) =>
        `${d.server}(pid ${d.pid}) v${d.running}${d.fromDirName ? ' [dir name; VERSION unreadable]' : ''}`,
    )
    .join(', ');

  return {
    verdict: 'warn',
    drifted,
    reason:
      `${drifted.length} MCP subprocess(es) are running OLDER code than the installed plugin ` +
      `v${installed} (${detail}). The directory still exists, so cache_freshness cannot see ` +
      `this, and session_freshness compares two on-disk facts that both read v${installed}. ` +
      `Any atom added since is silently ABSENT and any changed atom silently serves old ` +
      `behaviour — an absent atom reads as a finding about your run, not about the plugin. ` +
      `Quit and reopen Claude Code (Cmd-Q); /ace:update and /reload-plugins do NOT respawn ` +
      `MCP subprocesses (CLAUDE.md § MCP changes need a full Claude restart).`,
  };
}
