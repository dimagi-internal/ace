/**
 * Cross-session AVD contention, named (ace#1821).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * On `bednet-check-2-visit/20260828-0629` Phase 6's Deliver leg could not be
 * run at all. Emulators this session launched died mid-work; emulators it
 * never launched appeared; adb servers kept surfacing on ports it had not
 * allocated. `mobile_diagnose` reported:
 *
 *     adb_server_port: 5040 / emulator_console_port: 5558 / adb_visible_count: 0
 *
 * Every one of those fields was CORRECT, and together they read as a dead
 * device. The truth was that NINE live `ace-mobile` MCPs — across two macOS
 * accounts and four plugin versions — were cold-booting one shared AVD with
 * `-wipe-data`, each destroying the others' device state. Four successive
 * wrong diagnoses were made before anyone looked at the process table.
 *
 * This module does not fix that. It makes it SAYABLE. The failure is not
 * hard to understand once you can see it; it is nearly impossible to guess
 * from inside a single session, because every per-session number is right.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY `ps`, AND NOT THE SESSION-LOCK REGISTRY
 *
 * ACE already has a session-lock registry (`mcp/mobile/session-lock.ts`) with
 * pid-liveness reaping, and it is the right substrate for *fixing* the
 * orphan-kill. It cannot be the substrate for DETECTION here, for one
 * structural reason: `sessionLockDir()` is `~/.ace/sessions` — a per-`$HOME`
 * path. The other account's locks are not merely unread, they are unreadable.
 * Same for `pgrep -u <uid>`, which is deliberately uid-scoped (ace#1063).
 *
 * The process table is the only surface that spans accounts. Measured on the
 * affected host, from `acedimagi`:
 *
 *     $ ps -eo user= | sort | uniq -c | sort -rn | head -3
 *      878 acedimagi
 *      516 jjackson
 *      178 root
 *
 * `jjackson`'s full command lines are visible. That is why this reads `ps`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE THING THAT IS EASY TO GET WRONG
 *
 * **Each logical MCP is a THREE-process chain**, not one process:
 *
 *     npm exec tsx .../mcp/mobile-server.ts
 *       └─ node .../node_modules/.bin/tsx .../mcp/mobile-server.ts
 *            └─ node --require .../preflight.cjs .../mcp/mobile-server.ts
 *
 * All three command lines contain `mcp/mobile-server.ts`, so a naive count
 * reports 3x the real number — on the affected host, 27 rows for 9 sessions.
 * A detector that overstates contention 3x is worse than none: it would have
 * reported "27 contenders" for a 9-contender problem and been dismissed.
 *
 * So sessions are deduplicated to CHAIN ROOTS: a row whose `ppid` is not
 * itself a mobile-server row. Against the captured fixture that yields
 * exactly 9 — the number ace#1821 measured by hand.
 *
 * Own-session exclusion needs the same care in reverse: `process.pid` inside
 * the MCP is the INNERMOST node, a child. Resolving "self" means walking the
 * `ppid` chain UP to its root and excluding that.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLASSIFICATION: unit-testable logic, NOT device-truth.
 *
 * Per CLAUDE.md — "does this change alter what is SENT TO, or MATCHED
 * AGAINST, the device?" Nothing here is sent to a device (`diagnose`'s
 * contract forbids mutation, pinned by
 * `test/mcp/mobile/local-diagnose.test.ts`), and nothing is matched against a
 * device response: the input is the host process table. Same class as
 * ace#1235, whose set logic was fixed and proven device-free. A captured `ps`
 * fixture is a better authority here than one noisy device run — it says what
 * the process tree always looks like, not what it looked like once.
 *
 * Pure and synchronous; the collector that runs `ps` lives in the backend.
 */

/** One row of `ps -eo user=,pid=,ppid=,lstart=,command=`. */
export interface PsRow {
  user: string;
  pid: number;
  ppid: number;
  startedMs: number;
  command: string;
}

/** One logical `ace-mobile` MCP — the ROOT of its process chain. */
export interface MobileSession {
  pid: number;
  user: string;
  /** Plugin version parsed from the cache path, or null when unrecognised. */
  pluginVersion: string | null;
  startedMs: number;
  /** True for the chain this process belongs to. */
  isSelf: boolean;
  /** True when the session runs under the same macOS account as us. */
  sameUser: boolean;
}

export interface ContentionResult {
  /** `warn` when peers contend; `pass` when alone; `skip` when unanswerable. */
  verdict: 'pass' | 'warn' | 'skip';
  self: MobileSession | null;
  others: MobileSession[];
  otherSessionCount: number;
  /**
   * True when the live sessions span more than one macOS account — the case
   * that is structurally invisible to `~/.ace/sessions` locks and to
   * `pgrep -u <uid>`, and therefore to every other mechanism ACE has.
   */
  crossAccount: boolean;
  /** Distinct plugin versions across all sessions, sorted. */
  distinctPluginVersions: string[];
  /** Human-readable, and it names the remedy — the env-freshness convention. */
  reason: string;
}

/** Marks a command line as an ace-mobile MCP. */
const MOBILE_SERVER_RE = /\/mcp\/mobile-server\.ts\b/;

/** `.../plugins/cache/ace/ace/<version>/...` */
const PLUGIN_VERSION_RE = /\/cache\/ace\/ace\/(\d+\.\d+\.\d+)\//;

export function isMobileServerCommand(command: string): boolean {
  return MOBILE_SERVER_RE.test(command);
}

export function pluginVersionFromCommand(command: string): string | null {
  return PLUGIN_VERSION_RE.exec(command)?.[1] ?? null;
}

/**
 * Parse `ps -eo user=,pid=,ppid=,lstart=,command=`.
 *
 * `lstart` is FIVE whitespace-separated tokens (`Tue Sep  1 13:26:23 2026`) —
 * note the double space before a single-digit day, which is why the parse is
 * positional over `split(/\s+/)` rather than a column slice. `-o etimes=` would
 * be simpler and **does not exist on BSD/macOS**; that is the trap
 * `scripts/doctor-env-freshness.ts` already documents.
 */
export function parsePsRows(raw: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 9) continue;
    const user = parts[0];
    const pid = Number(parts[1]);
    const ppid = Number(parts[2]);
    const startedMs = new Date(parts.slice(3, 8).join(' ')).getTime();
    const command = parts.slice(8).join(' ');
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(startedMs)) continue;
    out.push({ user, pid, ppid, startedMs, command });
  }
  return out;
}

/**
 * Collapse a process table to one entry per logical ace-mobile MCP.
 *
 * A session is a CHAIN ROOT: a mobile-server row whose parent is not itself a
 * mobile-server row. See the header — counting rows overstates by 3x.
 */
export function parseMobileSessions(rows: readonly PsRow[], selfPid: number): MobileSession[] {
  const mobile = rows.filter((r) => isMobileServerCommand(r.command));
  const byPid = new Map(mobile.map((r) => [r.pid, r]));

  // Walk UP from selfPid to the root of ITS chain — process.pid inside the MCP
  // is the innermost node, so the root is an ancestor, never selfPid itself.
  const selfRootPid = (() => {
    let cur = byPid.get(selfPid);
    if (!cur) return null;
    const seen = new Set<number>();
    while (cur && byPid.has(cur.ppid) && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid)!;
    }
    return cur?.pid ?? null;
  })();

  const selfUser = byPid.get(selfPid)?.user ?? null;

  return mobile
    .filter((r) => !byPid.has(r.ppid))
    .map((r) => ({
      pid: r.pid,
      user: r.user,
      pluginVersion: pluginVersionFromCommand(r.command),
      startedMs: r.startedMs,
      isSelf: selfRootPid !== null && r.pid === selfRootPid,
      sameUser: selfUser === null ? true : r.user === selfUser,
    }))
    .sort((a, b) => a.startedMs - b.startedMs || a.pid - b.pid);
}

/**
 * Classify AVD contention from a process table.
 *
 * `avdCount` is how many AVDs exist on the host (`known_avds.length`). Peers
 * only contend when they outnumber the AVDs available to spread across — with
 * a pool of N, N concurrent sessions is the design, not a fault.
 *
 * Returns `skip`, never `warn`, when the question is unanswerable (the `ps`
 * read failed, or this process is not in the table). Warning on an
 * unanswerable question is how a check becomes noise and gets ignored — the
 * `lib/env-freshness.ts` precedent.
 */
export function classifyAvdContention(
  rows: readonly PsRow[],
  opts: { selfPid: number; avdCount: number },
): ContentionResult {
  const sessions = parseMobileSessions(rows, opts.selfPid);
  const self = sessions.find((s) => s.isSelf) ?? null;
  const others = sessions.filter((s) => !s.isSelf);
  const distinctPluginVersions = [
    ...new Set(sessions.map((s) => s.pluginVersion).filter((v): v is string => v !== null)),
  ].sort();

  if (sessions.length === 0) {
    return {
      verdict: 'skip',
      self: null,
      others: [],
      otherSessionCount: 0,
      crossAccount: false,
      distinctPluginVersions,
      reason:
        'could not read the process table for ace-mobile MCPs, so cross-session AVD contention ' +
        'was not assessed (not a claim that none exists)',
    };
  }

  // Derived from the DISTINCT user set across all sessions, not from
  // `others.some(!sameUser)`. Resolving "self" can fail (this process may not
  // be in the table at all), and a cross-account crowd must still be reported
  // as cross-account when it does — that is the case no `~/.ace/sessions`
  // lock and no `pgrep -u <uid>` scan can see, so it is the last thing that
  // should hinge on a lookup that might miss.
  const crossAccount = new Set(sessions.map((s) => s.user)).size > 1;

  if (others.length === 0) {
    return {
      verdict: 'pass',
      self,
      others,
      otherSessionCount: 0,
      crossAccount: false,
      distinctPluginVersions,
      reason: 'no other ace-mobile MCP is live on this host — this session has the AVD to itself',
    };
  }

  // A pool big enough for everyone is not contention.
  if (opts.avdCount > others.length) {
    return {
      verdict: 'pass',
      self,
      others,
      otherSessionCount: others.length,
      crossAccount,
      distinctPluginVersions,
      reason:
        `${others.length} other ace-mobile MCP(s) are live, but this host has ${opts.avdCount} AVDs — ` +
        'enough to go round, so sessions need not share one',
    };
  }

  const accounts = [...new Set(sessions.map((s) => s.user))].sort();
  return {
    verdict: 'warn',
    self,
    others,
    otherSessionCount: others.length,
    crossAccount,
    distinctPluginVersions,
    reason:
      `${others.length} other live ace-mobile MCP(s) share this host's ${opts.avdCount} AVD(s)` +
      (crossAccount ? ` across ${accounts.length} macOS accounts (${accounts.join(', ')})` : '') +
      (distinctPluginVersions.length > 1
        ? ` and ${distinctPluginVersions.length} plugin versions (${distinctPluginVersions.join(', ')})`
        : '') +
      '. Every dispatch cold-boots the shared AVD with -wipe-data and kills same-user qemu ' +
      'processes it cannot see in its own adb server, so these sessions destroy each other\'s ' +
      'device state — including a walk in flight. A device that looks dead here (adb_visible_count: 0) ' +
      'is most likely a peer\'s, not a fault in this session. Serialise Phase 6 runs on this host, ' +
      'or provision more AVDs. See ace#1821.',
  };
}
