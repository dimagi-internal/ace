/**
 * Is any running MCP subprocess holding a stale `.env`? (dimagi-internal/ace#880)
 *
 * ## The failure this exists to surface
 *
 * Every ACE MCP server calls `dotenvConfig()` at module top level — see
 * `mcp/connect-server.ts:13,18`, and the same shape in `mobile-server.ts`,
 * `ocs-server.ts`, `google-drive-server.ts`, `decisions-server.ts`. The file is
 * read exactly once, at subprocess spawn, and consumed immediately (e.g.
 * `buildHqClusterRegistry(process.env)` at import time). A subprocess that
 * started before `/ace:setup --force-env` rewrote `.env` therefore holds the
 * old values for its entire life, and nothing says so.
 *
 * Measured on the reporting run: the connect MCP started 21:17:09, `.env` was
 * written 21:17:54 — 45 seconds later. The HQ cluster registry read `[us]`
 * while the file on disk yielded `[eu, us]`. The parser was correct; the
 * process was stale. So the operator ordering is **setup first, restart
 * after** — the reverse silently keeps the old env.
 *
 * ## Why `/ace:doctor` could not already see this
 *
 * `session_freshness` (`bin/ace-doctor`) compares `$ROOT/VERSION` against
 * `installed_plugins.json` — two ON-DISK facts. It structurally cannot observe
 * a running subprocess, which is exactly where this defect lives. This module
 * generalizes that check from version-freshness to env-freshness by comparing
 * `.env`'s mtime against each MCP child's start time.
 *
 * ## Pure by design
 *
 * All process discovery and `stat` live in `scripts/doctor-env-freshness.ts`.
 * This half takes numbers and returns a verdict, so the interesting rules —
 * especially the three skip cases — are unit-testable without a live process
 * tree. `/reload-plugins` does NOT respawn MCP subprocesses; only a full quit
 * does, which is why the remedy text says so explicitly.
 */

export interface McpProc {
  pid: number;
  /** Full `ps` command line, used to derive a readable server name. */
  command: string;
  /** Process start time, epoch ms (parsed from `ps -o lstart=`). */
  startedMs: number;
}

export interface EnvFreshnessInput {
  /** `.env`'s mtime in epoch ms, or null when it does not exist / is unreadable. */
  envMtimeMs: number | null;
  /** This session's ACE MCP children. */
  procs: McpProc[];
  /**
   * Whether the collector resolved a `claude` ancestor. When false the process
   * list cannot be bound to THIS session, so no judgment is possible.
   * Defaults true so callers that already filtered can omit it.
   */
  claudeAncestorFound?: boolean;
}

export interface StaleProc {
  pid: number;
  /** e.g. `connect`, `google-drive`. Falls back to the raw command. */
  server: string;
  startedMs: number;
}

export interface EnvFreshnessResult {
  /** `skip` = could not judge. Never warn on an unanswerable question. */
  verdict: 'pass' | 'warn' | 'skip';
  stale: StaleProc[];
  reason: string;
}

/** `…/mcp/connect-server.ts` → `connect`. Null when the command is not one. */
export function serverNameFromCommand(command: string): string | null {
  const m = command.match(/\/mcp\/([a-z0-9-]+)-server\.ts\b/);
  return m ? m[1] : null;
}

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/**
 * Decide whether a restart is owed, given `.env`'s mtime and this session's
 * MCP children.
 *
 * A process is stale iff it started **strictly before** the write. An exact
 * tie is treated as fresh: `ps -o lstart=` has one-second resolution while
 * mtime is sub-second, so equality is a rounding artifact and warning on it
 * would fire on a perfectly healthy setup-then-restart.
 */
export function classifyEnvFreshness(input: EnvFreshnessInput): EnvFreshnessResult {
  const { envMtimeMs, procs, claudeAncestorFound = true } = input;

  if (envMtimeMs === null) {
    return {
      verdict: 'skip',
      stale: [],
      reason: 'no readable .env — nothing to compare MCP start times against',
    };
  }

  if (!claudeAncestorFound) {
    return {
      verdict: 'skip',
      stale: [],
      reason:
        'no `claude` ancestor process found — cannot bind the MCP process list ' +
        'to this session, and a sibling session’s children would be a ' +
        'meaningless comparison',
    };
  }

  if (procs.length === 0) {
    return {
      verdict: 'skip',
      stale: [],
      reason:
        'no ACE MCP subprocesses under this session (normal when running ' +
        'bin/ace-doctor from a plain terminal) — nothing to check',
    };
  }

  const stale: StaleProc[] = procs
    .filter((p) => p.startedMs < envMtimeMs)
    .map((p) => ({
      pid: p.pid,
      server: serverNameFromCommand(p.command) ?? p.command,
      startedMs: p.startedMs,
    }));

  if (stale.length === 0) {
    return {
      verdict: 'pass',
      stale: [],
      reason: `all ${procs.length} MCP subprocess(es) started after .env was written`,
    };
  }

  const detail = stale.map((s) => `${s.server}(pid ${s.pid}) ${hhmmss(s.startedMs)}`).join(', ');
  return {
    verdict: 'warn',
    stale,
    reason:
      `${stale.length} MCP subprocess(es) started BEFORE the current .env was ` +
      `written (.env ${hhmmss(envMtimeMs)}; ${detail}). They read .env only at ` +
      `startup, so they are running the previous values. Quit and reopen ` +
      `Claude Code (Cmd-Q) to respawn them — /reload-plugins does NOT respawn ` +
      `MCP subprocesses.`,
  };
}
