/**
 * Is another emulator already holding this AVD?
 *
 * Why this exists (dimagi-internal/ace#1047 fix #3). Port allocation is
 * per-session (#1030), but the AVD **name** is not — so a second local ACE
 * session targets the same `ACE_Pixel_API_34`, loses the race, and finds out
 * 60 seconds later via:
 *
 * ```
 * AVD emulator-5558 stalled in phase=adb-register
 * (elapsed_ms=60954 budget_ms=60000 last_adb_state=absent)
 * ```
 *
 * which reads as a boot-timeout or a driver problem. The emulator never
 * booted at all.
 *
 * Reproduced on a dev host 2026-08-14 while validating the mobile batch: TWO
 * orphaned qemu processes (parent pid 1) held `ACE_Pixel_API_34` read-only on
 * port 5554, and every read-write boot of that AVD died shortly afterwards
 * with **no crash signature anywhere** — no OOM, no panic, the emulator log
 * simply stopping after `Boot completed`, on a host with 85% memory free.
 * Moving to a dedicated AVD made the instability vanish completely.
 *
 * ## The lock is NOT ground truth under `-read-only` (ace#1909)
 *
 * This module originally decided contention by reading exactly one file,
 * `<avd>.avd/hardware-qemu.ini.lock`, on an observation that was true when it
 * was made and had ALREADY been invalidated 16 days earlier in this same tree:
 *
 *     f089bd49  2026-07-29  fix(mobile): pass -read-only so two sessions can share one AVD
 *     a78c27d2  2026-08-14  fix(mobile): refuse a CONTENDED AVD before spawning (#1047 fix #3)
 *
 * **Not taking the AVD lock is precisely HOW `-read-only` permits concurrent
 * instances**, and `-read-only` is unconditionally in ACE's launch argv
 * (`backends/avd.ts`). So the read always threw into the `catch` and the
 * function always returned `free to boot` — for two weeks of concurrent-session
 * failures that were diagnosed as port confusion instead. Nothing errored, and
 * the answer it gave was the reassuring one. Measured on the affected host
 * 2026-09-02 with qemu pid 29670 live on `ACE_Pixel_API_34`:
 *
 *     $ ls ~/.android/avd/ACE_Pixel_API_34.avd/hardware-qemu.ini.lock
 *     ls: ...: No such file or directory
 *     $ ls -la ~/.android/avd/ACE_Pixel_API_34.avd/ | grep -i lock
 *     -rw-r--r--@ 1 acedimagi staff 0 Sep 1 09:56 multiinstance.lock
 *
 * `multiinstance.lock` IS created under the flag, but it is 0 bytes — it names
 * no holder, so its presence cannot separate a live holder from a stale marker.
 *
 * So the process table is now the primary evidence, via
 * `lib/mobile-contention.ts` — the SAME `ps` substrate PR #1911 built for
 * cross-session MCP contention (ace#1821), deliberately shared rather than
 * duplicated: two contention detectors that disagree would be worse than one
 * dead one. The lock read is kept as a secondary signal, because it is still
 * correct for the case it can see: a read-WRITE emulator (one launched by hand
 * or by another tool without `-read-only`) does take the lock.
 *
 * ## HELD is not CONTENDED — and this deliberately does not refuse harder
 *
 * `-read-only` exists so that several instances may share one AVD. A live
 * read-only holder is therefore reported (`held` / `heldBy` / `shareable`) and
 * NOT refused. Only a read-write holder sets `contended`, because that is the
 * case the emulator itself rejects (`FATAL | Running multiple emulators with
 * the same AVD is an experimental feature.`).
 *
 * That split is a judgment call, taken from ace#1821's risk finding: against a
 * ONE-AVD host, a refusing lock converts N-1 concurrent sessions from "limps to
 * a partial walk" into "dies immediately", while Phase 6's one-way Learn
 * precondition is burned either way. The caller (`ensureAvdRunning`) therefore
 * PREFERS an unheld AVD when the pool offers one and warns loudly when it does
 * not — refuse only once there is somewhere to fall back to. Making the check
 * truthful is this module's job; making it block is a separate decision.
 *
 * ## Why "unreadable pid" is treated as STALE
 *
 * A lock we cannot parse is not evidence that someone is using the AVD.
 * Blocking a boot on garbage would convert a cosmetic mess into a hard
 * failure, and the emulator itself will refuse if it really is held. We only
 * refuse when we can name a LIVE holder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseAvdHolders, type AvdHolder, type PsRow } from '../../lib/mobile-contention.js';

/** The emulator's own lock files, in the order they should be cleared. */
const LOCK_FILES = ['hardware-qemu.ini.lock', 'multiinstance.lock'];

export interface ContentionOpts {
  /** Injected for tests; defaults to a real signal-0 probe. */
  isPidAlive?: (pid: number) => boolean;
  /** Our own pid, so we never report contention against ourselves. */
  selfPid?: number;
  /**
   * Host process table, from `ps -eo user=,pid=,ppid=,lstart=,command=` parsed
   * by `lib/mobile-contention.ts#parsePsRows`. PRIMARY evidence (ace#1909);
   * when omitted this falls back to the lock file alone and says so, rather
   * than reporting `free to boot` off a read it never made.
   */
  psRows?: readonly PsRow[];
  /**
   * This session's allocated emulator console port. The emulator is detached
   * (`ppid` 1) and shares no pid with the MCP that spawned it, so the port is
   * the only thing that binds a running emulator back to its own session — and
   * without it a session reports its OWN device as a peer and switches away
   * from it every dispatch.
   */
  selfEmulatorPort?: number | null;
}

export interface AvdContention {
  /**
   * Do NOT spawn: a read-WRITE emulator holds this AVD and the emulator itself
   * will reject a second instance. A `-read-only` holder does not set this —
   * see `held`.
   */
  contended: boolean;
  /** A lock exists but its holder is gone (or unparseable). Safe to clear. */
  stale: boolean;
  holderPid?: number;
  lockPath: string;
  detail: string;
  /** A live emulator (ours excluded) is attached to this AVD. */
  held: boolean;
  /** Every such holder, from the process table. Empty when `psRows` is absent. */
  heldBy: AvdHolder[];
  /**
   * Every live holder passed `-read-only`, so a further instance is permitted.
   * False when there are no holders, and false the moment one is read-write.
   */
  shareable: boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function checkAvdContention(
  avdHome: string,
  avdName: string,
  opts: ContentionOpts = {},
): AvdContention {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const lockPath = path.join(avdHome, `${avdName}.avd`, 'hardware-qemu.ini.lock');

  // PRIMARY evidence: who does the process table say is on this AVD?
  // Under `-read-only` this is the ONLY surface that can see a holder at all
  // (ace#1909). `heldBy` is empty when no `ps` capture was supplied, which is
  // reported below as "not consulted" rather than as "nobody is there".
  const heldBy = opts.psRows
    ? parseAvdHolders(opts.psRows, avdName, { selfConsolePort: opts.selfEmulatorPort })
    : [];
  const readWrite = heldBy.filter((h) => !h.readOnly);
  const held = heldBy.length > 0;
  const shareable = held && readWrite.length === 0;
  const holders = (hs: AvdHolder[]): string =>
    hs.map((h) => `pid ${h.pid} (${h.user}${h.consolePort ? `, port ${h.consolePort}` : ''})`).join(', ');

  // A read-WRITE holder is the case the emulator itself rejects with
  // `FATAL | Running multiple emulators with the same AVD is an experimental
  // feature.` — spawning against it produces the opaque 60s adb-register stall
  // that #1047 fix #3 exists to pre-empt.
  if (readWrite.length > 0) {
    return {
      contended: true,
      stale: false,
      held,
      heldBy,
      shareable: false,
      holderPid: readWrite[0].pid,
      lockPath,
      detail:
        `a read-write emulator already holds AVD '${avdName}' — ${holders(readWrite)}. The emulator ` +
        'refuses a second instance on the same AVD unless BOTH pass -read-only, and the refusal ' +
        'surfaces 60s later as phase=adb-register, which reads as a boot timeout. Use a different ' +
        'AVD, or stop that process first (dimagi-internal/ace#1047).',
    };
  }

  if (held) {
    // Reported, NOT refused. See the header: `-read-only` exists so that these
    // may coexist, and refusing on a one-AVD host would turn every peer session
    // into an immediate death (ace#1821).
    return {
      contended: false,
      stale: false,
      held: true,
      heldBy,
      shareable: true,
      holderPid: heldBy[0].pid,
      lockPath,
      detail:
        `${heldBy.length} other -read-only emulator(s) hold AVD '${avdName}' — ${holders(heldBy)}. ` +
        'Concurrent instances are permitted by -read-only, so this is not a refusal; but every ACE ' +
        'dispatch cold-boots with -wipe-data, so these sessions destroy each other\'s device state. ' +
        'Prefer a free AVD if the pool has one (ace#1821, ace#1909).',
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return {
      contended: false,
      stale: false,
      held: false,
      heldBy,
      shareable: false,
      lockPath,
      detail: opts.psRows
        ? `no emulator process holds ${avdName} and no lock file is present — free to boot`
        : `no emulator lock on ${avdName}, and the process table was not consulted — ` +
          'under -read-only that file is never written, so this is weak evidence (ace#1909)',
    };
  }

  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      contended: false,
      stale: true,
      held: false,
      heldBy,
      shareable: false,
      lockPath,
      detail:
        `${lockPath} exists but holds no readable pid (${JSON.stringify(raw.trim().slice(0, 40))}). ` +
        'Treated as stale: an unparseable lock is not evidence anyone is using the AVD.',
    };
  }

  if (opts.selfPid !== undefined && pid === opts.selfPid) {
    return {
      contended: false,
      stale: false,
      held: false,
      heldBy,
      shareable: false,
      holderPid: pid,
      lockPath,
      detail: `${avdName} is held by this process`,
    };
  }

  if (!isPidAlive(pid)) {
    return {
      contended: false,
      stale: true,
      held: false,
      heldBy,
      shareable: false,
      holderPid: pid,
      lockPath,
      detail: `${avdName}'s lock names pid ${pid}, which is gone — stale lock, safe to clear`,
    };
  }

  return {
    contended: true,
    stale: false,
    held: false,
    heldBy,
    shareable: false,
    holderPid: pid,
    lockPath,
    detail:
      `another emulator (pid ${pid}) already holds AVD '${avdName}'. Booting a second one against the ` +
      'same AVD is what produces a 60s adb-register stall that reads as a boot timeout — the emulator ' +
      'never registers. Use a different AVD, or stop that process first ' +
      '(dimagi-internal/ace#1047).',
  };
}

/**
 * Remove a STALE lock so the next boot is not blocked forever. Refuses when
 * the holder is alive — clearing a live lock would let two emulators write
 * the same AVD, which is worse than the stall this exists to prevent.
 */
export function clearStaleAvdLock(
  avdHome: string,
  avdName: string,
  opts: ContentionOpts = {},
): boolean {
  const state = checkAvdContention(avdHome, avdName, opts);
  if (!state.stale) return false;
  const dir = path.join(avdHome, `${avdName}.avd`);
  for (const f of LOCK_FILES) {
    try {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    } catch {
      /* best-effort: a lock we cannot remove is reported by the next check */
    }
  }
  return true;
}
