/**
 * Which qemu processes may this session SIGKILL? (ace#1821)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `sweepStaleEmulatorState` in `mcp/mobile/backends/avd.ts` opens every AVD
 * dispatch by reaping orphaned emulators. Until this module it decided that
 * with one inference, stated verbatim in its own comment:
 *
 *     if `adb devices` is empty (which is the wedged state we're trying to
 *     recover from), every qemu PID is by definition an orphan.
 *
 * That is true on a single-session host and FALSE the moment a peer session
 * exists. `mcp/mobile/port-allocator.ts` hands every session its own adb
 * server, and a freshly-allocated server has scanned nothing yet — so at
 * dispatch start `adb devices` is legitimately empty while peers' emulators
 * are alive and healthy on THEIR servers. The old code read that emptiness as
 * evidence about processes it had never asked about, and SIGKILLed them.
 *
 * So every ACE session killed every other session's emulator at dispatch
 * start, routinely. That is ace#1821's original symptom verbatim — "emulators
 * this session launched died mid-work; emulators this session did not launch
 * appeared" — and it was observed again on 2026-09-05: an emulator on
 * `ACE_Pixel_API_34_b` died with a clean boot log (ending at `Boot completed`,
 * no crash line) exactly as a peer session spawned one on `ACE_Pixel_API_34`.
 *
 * The `qemuPids.length > liveCount` branch had the same flaw with a smaller
 * blast radius: peers' pids inflate `qemuPids`, can never appear in our
 * `adb devices`, and so were killed as "excess".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIX IS TO DELETE AN INFERENCE, NOT TO TUNE IT
 *
 * No count of devices on OUR adb server is evidence about whether SOMEONE
 * ELSE'S process is an orphan. There is no threshold that repairs that, so
 * `adb devices` does not appear in this module at all. Attribution replaces
 * it: a qemu is killable when nothing alive claims it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY SESSION LOCKS ARE THE RIGHT SUBSTRATE **HERE**
 *
 * `lib/mobile-contention.ts`'s header explains at length why the lock
 * registry cannot be the substrate for cross-account DETECTION:
 * `sessionLockDir()` is `~/.ace/sessions`, a per-`$HOME` path, so another
 * macOS account's locks are unreadable rather than merely unread. That
 * reasoning is correct, and it names this module's job as the exception:
 * *"it is the right substrate for fixing the orphan-kill."*
 *
 * The reason is that the two surfaces share one boundary:
 *
 *   - the candidate list comes from `pgrep -u <uid> -f qemu-system`, which is
 *     deliberately uid-scoped (ace#1063) — so every candidate is OURS;
 *   - the lock registry is `~/.ace/sessions`, per-`$HOME` — so it can see
 *     every lock belonging to that same account.
 *
 * A peer under a DIFFERENT account is invisible to the locks, but it is also
 * absent from the candidate list, so it is never at risk. A peer under the
 * SAME account is exactly the dangerous case, and is exactly the case the
 * locks CAN see. Detection needed a surface that spans accounts; the kill
 * decision does not, because the kill itself does not span accounts.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE JOIN KEY IS THE CONSOLE PORT
 *
 * An ACE emulator is detached (`ppid` 1) and shares no pid with the MCP that
 * spawned it, so pid comparison cannot bind a running emulator to a session.
 * The console port can: `port-allocator.ts` allocates one per session,
 * `avd.ts` passes it verbatim as `-port <n>` (backends/avd.ts:917-919), and
 * `SessionLock.emulator_port` records it. That is the same key
 * `parseAvdHolders` already uses to exclude a session's own emulator, so this
 * module reuses that parser rather than adding a second one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS PRESERVED
 *
 * The malaria-itn-fgd attempt-10 recovery — this session's own orphaned qemu
 * from a prior crashed boot — still dies. A crashed session's lock is reaped
 * by `listLiveSessionLocks`, which drops any lock whose `mcp_pid` is dead, so
 * its emulator is claimed by nothing and falls through to `kill`. Narrowing
 * the blast radius does not remove the capability; it removes only the kills
 * that were never ours to make.
 *
 * An unattributable qemu — no process-table row, or no `-port` in its argv —
 * is SPARED rather than killed. That is the one deliberate asymmetry here:
 * sparing a true orphan costs a port-allocation walk the allocator already
 * performs (`resolveEmulatorPair` probes upward from 5554), while killing a
 * peer destroys Phase 6's one-way Learn precondition and costs a whole run.
 * Unequal costs get an unequal default.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLASSIFICATION: unit-testable logic, NOT device-truth.
 *
 * Per CLAUDE.md — "does this change alter what is SENT TO, or MATCHED
 * AGAINST, the device?" Neither. The inputs are a pid list, a process-table
 * capture and a directory of JSON lock files; the output is a set of pids.
 * Nothing is transmitted to a device and nothing is compared against a device
 * response. Same class as ace#1235 (set logic over modules x forms, fixed and
 * proven device-free) and as `lib/mobile-contention.ts` itself. The impure
 * halves — `pgrep`, `ps`, `process.kill` — stay in the backend.
 *
 * Pure and synchronous.
 */

import type { AvdHolder } from './mobile-contention.js';

/** Why a qemu process was spared, or killed. */
export type OrphanReason =
  /** No row for this pid in the process-table capture — cannot attribute it. */
  | 'unattributable-no-ps-row'
  /** The argv carries no `-port`, so it cannot be joined to a session lock. */
  | 'unattributable-no-console-port'
  /** This session's own emulator; the cold-boot path owns it, not the sweep. */
  | 'self'
  /** A session lock whose owning `mcp_pid` is alive claims this console port. */
  | 'held-by-live-session'
  /** Nothing alive claims this console port. */
  | 'orphan';

export interface OrphanVerdict {
  pid: number;
  kill: boolean;
  reason: OrphanReason;
  /** The `-port <n>` from the process table, when it could be read. */
  consolePort: number | null;
  /** `mcp_pid` of the live session holding it, for `held-by-live-session`. */
  heldByMcpPid: number | null;
  /** Operator-readable, and it names the evidence rather than the conclusion. */
  detail: string;
}

/** One live session's claim, projected from a lock file whose pid is alive. */
export interface LiveSessionClaim {
  mcpPid: number;
  consolePort: number;
  avdName?: string;
  oppSlug?: string;
}

export interface OrphanScopeInput {
  /**
   * Candidate pids from `pgrep -u <uid> -f qemu-system`. Uid-scoped, so every
   * entry is owned by this macOS account (ace#1063).
   */
  qemuPids: readonly number[];
  /**
   * Emulator processes read from the host process table, via
   * `parseEmulatorProcesses` in `lib/mobile-contention.ts`. May include rows
   * for other accounts; those simply never match a candidate pid.
   */
  processes: readonly AvdHolder[];
  /**
   * Claims from `listLiveSessionLocks()` — locks whose `mcp_pid` is ALIVE.
   * Dead sessions' locks are already reaped there, which is what keeps the
   * attempt-10 orphan recovery working.
   */
  liveClaims: readonly LiveSessionClaim[];
  /** This session's own allocated emulator console port, when known. */
  selfConsolePort?: number | null;
}

export interface OrphanScopeResult {
  /** Pids the caller may SIGKILL. */
  killable: number[];
  /** Pids the caller must leave alone. */
  spared: number[];
  /** Every candidate, with its reason. Ordered as `qemuPids` was. */
  verdicts: OrphanVerdict[];
}

/**
 * Decide which of `qemuPids` this session may SIGKILL.
 *
 * A candidate is killable only when it can be positively shown that no live
 * session owns it. Every other outcome — including "we could not tell" —
 * spares it.
 */
export function scopeOrphanQemuKills(input: OrphanScopeInput): OrphanScopeResult {
  const byPid = new Map<number, AvdHolder>();
  for (const p of input.processes) byPid.set(p.pid, p);

  const claimByPort = new Map<number, LiveSessionClaim>();
  for (const c of input.liveClaims) {
    if (Number.isFinite(c.consolePort) && c.consolePort > 0) claimByPort.set(c.consolePort, c);
  }

  const verdicts: OrphanVerdict[] = input.qemuPids.map((pid) => {
    const proc = byPid.get(pid);
    if (!proc) {
      return {
        pid,
        kill: false,
        reason: 'unattributable-no-ps-row',
        consolePort: null,
        heldByMcpPid: null,
        detail:
          `pid ${pid} matched the qemu scan but has no row in the process-table ` +
          'capture, so its owning session cannot be determined. Spared: an ' +
          "unattributable process is not evidence of an orphan.",
      };
    }

    const port = proc.consolePort;
    if (port == null) {
      return {
        pid,
        kill: false,
        reason: 'unattributable-no-console-port',
        consolePort: null,
        heldByMcpPid: null,
        detail:
          `pid ${pid} carries no \`-port\` in its argv, so it cannot be joined to ` +
          'a session lock. Spared: ACE always passes `-port`, so this was almost ' +
          'certainly not launched by ACE.',
      };
    }

    if (input.selfConsolePort != null && port === input.selfConsolePort) {
      return {
        pid,
        kill: false,
        reason: 'self',
        consolePort: port,
        heldByMcpPid: null,
        detail:
          `pid ${pid} is on this session's own console port ${port}. Spared here: ` +
          'the deterministic cold-boot path owns this emulator, not the ' +
          'best-effort sweep.',
      };
    }

    const claim = claimByPort.get(port);
    if (claim) {
      return {
        pid,
        kill: false,
        reason: 'held-by-live-session',
        consolePort: port,
        heldByMcpPid: claim.mcpPid,
        detail:
          `pid ${pid} is on console port ${port}, claimed by LIVE session ` +
          `mcp_pid=${claim.mcpPid}` +
          (claim.avdName ? ` (avd ${claim.avdName}` : '') +
          (claim.avdName && claim.oppSlug ? `, opp ${claim.oppSlug})` : claim.avdName ? ')' : '') +
          '. Spared: killing a live peer\'s emulator is ace#1821.',
      };
    }

    return {
      pid,
      kill: true,
      reason: 'orphan',
      consolePort: port,
      heldByMcpPid: null,
      detail:
        `pid ${pid} is on console port ${port}, which no live session lock ` +
        'claims. Killable: its owning session is gone (a dead session\'s lock is ' +
        'reaped by listLiveSessionLocks), so this is a true orphan.',
    };
  });

  return {
    killable: verdicts.filter((v) => v.kill).map((v) => v.pid),
    spared: verdicts.filter((v) => !v.kill).map((v) => v.pid),
    verdicts,
  };
}
