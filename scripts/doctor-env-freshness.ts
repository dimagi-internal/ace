#!/usr/bin/env npx tsx
/**
 * `/ace:doctor`'s env-freshness probe (dimagi-internal/ace#880).
 *
 * The impure half of `lib/env-freshness.ts`: find this session's ACE MCP
 * children, read `.env`'s mtime, and print a doctor-shaped PASS/WARN line. All
 * decision logic lives in the pure helper and is unit-tested there.
 *
 * ## Two traps this deliberately avoids
 *
 * 1. **`ps -o etimes=` does not exist on BSD ps.** macOS answers
 *    `ps: etimes: keyword not found`. `ps -o lstart=` works, and Node parses
 *    its format (`Thu Aug 13 14:35:15 2026`) directly via `new Date(...)` — so
 *    no `date -j` / `date -d` platform branching is needed anywhere here.
 *
 * 2. **`$PPID` is NOT the claude pid from inside a script.** CLAUDE.md's
 *    documented recipe (`ps -eo ppid,command | awk -v c="$PPID"`) is correct
 *    only when typed DIRECTLY in a Bash tool call. Inside a script `$PPID` is
 *    the invoking shell, and `bin/ace-doctor` adds a further level when it is
 *    itself invoked from `bin/ace-setup`. So we walk ancestors until the
 *    process name is `claude`, bounded, rather than assuming a fixed depth.
 *
 * Never exits non-zero on its own failure — a diagnostic that breaks the
 * diagnostic is worse than a missing line.
 *
 * Test seam: set `ACE_ENV_FRESHNESS_PS_FIXTURE` to a file containing canned
 * `ps -eo pid=,ppid=,lstart=,command=` output, and `ACE_ENV_FRESHNESS_ENV_PATH`
 * to a specific .env, so the parsing is gated in CI without a live tree.
 */
import { execFileSync } from 'node:child_process';
import { statSync, readFileSync, existsSync } from 'node:fs';

import { classifyEnvFreshness, type McpProc } from '../lib/env-freshness.js';
import {
  classifyPluginCacheFreshness,
  pluginRootFromCommand,
} from '../lib/plugin-cache-freshness.js';

const MAX_ANCESTOR_HOPS = 6;

function ps(args: string[]): string {
  try {
    return execFileSync('ps', args, { encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}

/** Walk up from `startPid` until a process named `claude` is found. */
function findClaudeAncestor(startPid: number): number | null {
  let pid = startPid;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    if (!Number.isFinite(pid) || pid <= 1) return null;
    const comm = ps(['-o', 'comm=', '-p', String(pid)]).trim();
    // `comm` may be a full path (/usr/local/bin/claude) or bare (claude).
    if (comm.split('/').pop() === 'claude') return pid;
    const parent = Number(ps(['-o', 'ppid=', '-p', String(pid)]).trim());
    if (!Number.isFinite(parent) || parent === pid) return null;
    pid = parent;
  }
  return null;
}

/**
 * Rows are `pid ppid lstart(5 fields) command`. lstart is fixed-width-ish but
 * space-separated, so split on whitespace and take a known slice rather than
 * regexing the date format.
 */
function parsePsRows(raw: string): Array<{ pid: number; ppid: number; startedMs: number; command: string }> {
  const out: Array<{ pid: number; ppid: number; startedMs: number; command: string }> = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 8) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    // lstart = 5 tokens: "Thu Aug 13 14:35:15 2026"
    const startedMs = new Date(parts.slice(2, 7).join(' ')).getTime();
    const command = parts.slice(7).join(' ');
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(startedMs)) continue;
    out.push({ pid, ppid, startedMs, command });
  }
  return out;
}

/**
 * An ACE MCP child: a `mcp/<name>-server.ts` under an ACE plugin root.
 *
 * The plugin-root check matters — sibling plugins ship a `google-drive-server.ts`
 * of their own (chrome-sales does), and counting theirs would produce a warn
 * about a process ACE's .env has nothing to do with.
 */
function isAceMcpCommand(command: string): boolean {
  if (!/\/mcp\/[a-z0-9-]+-server\.ts\b/.test(command)) return false;
  return /\/ace\/ace\//.test(command) || /\/plugins\/cache\/ace\//.test(command) || /ace-ace/.test(command);
}

function resolveEnvPath(): string {
  if (process.env.ACE_ENV_FRESHNESS_ENV_PATH) return process.env.ACE_ENV_FRESHNESS_ENV_PATH;
  const dataDir =
    process.env.CLAUDE_PLUGIN_DATA && !process.env.CLAUDE_PLUGIN_DATA.includes('${')
      ? process.env.CLAUDE_PLUGIN_DATA
      : `${process.env.HOME}/.claude/plugins/data/ace-ace`;
  return `${dataDir}/.env`;
}

/** Best-effort installed version, for contrast in the warn message. */
function readInstalledVersion(): string | undefined {
  try {
    const reg = JSON.parse(
      readFileSync(`${process.env.HOME}/.claude/plugins/installed_plugins.json`, 'utf8'),
    );
    const e = reg['ace@ace'] ?? reg.plugins?.['ace@ace'];
    const v = Array.isArray(e) ? e[0] : e;
    return v?.version;
  } catch {
    return undefined;
  }
}

function main(): void {
  const envPath = resolveEnvPath();
  let envMtimeMs: number | null = null;
  try {
    if (existsSync(envPath)) envMtimeMs = statSync(envPath).mtimeMs;
  } catch {
    envMtimeMs = null;
  }

  const fixture = process.env.ACE_ENV_FRESHNESS_PS_FIXTURE;
  let procs: McpProc[] = [];
  let claudeAncestorFound = true;

  if (fixture) {
    // In fixture mode every row IS the session's tree by construction; the
    // ancestor walk is what the fixture stands in for.
    const rows = parsePsRows(readFileSync(fixture, 'utf8'));
    procs = rows
      .filter((r) => isAceMcpCommand(r.command))
      .map((r) => ({ pid: r.pid, command: r.command, startedMs: r.startedMs }));
    claudeAncestorFound = procs.length > 0 || rows.length > 0;
  } else {
    const claudePid = findClaudeAncestor(process.ppid);
    claudeAncestorFound = claudePid !== null;
    if (claudePid !== null) {
      const rows = parsePsRows(ps(['-eo', 'pid=,ppid=,lstart=,command=']));
      procs = rows
        .filter((r) => r.ppid === claudePid && isAceMcpCommand(r.command))
        .map((r) => ({ pid: r.pid, command: r.command, startedMs: r.startedMs }));
    }
  }

  const result = classifyEnvFreshness({ envMtimeMs, procs, claudeAncestorFound });

  // ace#970 — same process list, one extra existsSync per child. A subprocess
  // running from a pruned plugin-cache dir dies on its next lazy module load,
  // and session_freshness reports PASS in that scenario (the doctor launcher
  // falls through to the new root, where both on-disk facts agree).
  const cache = classifyPluginCacheFreshness({
    procs: procs.map((p) => {
      const parsed = pluginRootFromCommand(p.command);
      return { pid: p.pid, command: p.command, rootExists: parsed ? existsSync(parsed.root) : false };
    }),
    installedVersion: readInstalledVersion(),
  });

  if (result.verdict === 'warn') {
    console.log(`WARN env_freshness: ${result.reason}`);
    console.log(
      '  fix: quit and reopen Claude Code (Cmd-Q). MCP servers read .env only at ' +
        'subprocess startup, and /reload-plugins does NOT respawn them ' +
        '(CLAUDE.md § MCP changes need a full Claude restart).',
    );
  } else if (result.verdict === 'pass') {
    console.log(`PASS env_freshness: ${result.reason}`);
  } else {
    console.log(`SKIP env_freshness: ${result.reason}`);
  }

  if (cache.verdict === 'warn') {
    console.log(`WARN cache_freshness: ${cache.reason}`);
  } else if (cache.verdict === 'pass') {
    console.log(`PASS cache_freshness: ${cache.reason}`);
  } else {
    console.log(`SKIP cache_freshness: ${cache.reason}`);
  }
}

try {
  main();
} catch (err) {
  // A broken probe must never break `/ace:doctor`.
  console.log(`SKIP env_freshness: probe failed (${(err as Error).message})`);
}
