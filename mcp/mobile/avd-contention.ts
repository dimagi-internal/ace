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
 * ## The lock is readable ground truth
 *
 * Verified against a LIVE emulator: `<avd>.avd/hardware-qemu.ini.lock` is a
 * plain FILE whose entire contents are the holding pid (`39908`, matching the
 * running process), with an empty `multiinstance.lock` marker beside it. So
 * contention is decidable BEFORE the spawn, in one read — which turns a
 * 60-second opaque stall into an instant named cause.
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

/** The emulator's own lock files, in the order they should be cleared. */
const LOCK_FILES = ['hardware-qemu.ini.lock', 'multiinstance.lock'];

export interface ContentionOpts {
  /** Injected for tests; defaults to a real signal-0 probe. */
  isPidAlive?: (pid: number) => boolean;
  /** Our own pid, so we never report contention against ourselves. */
  selfPid?: number;
}

export interface AvdContention {
  /** A LIVE process holds this AVD. Do not spawn. */
  contended: boolean;
  /** A lock exists but its holder is gone (or unparseable). Safe to clear. */
  stale: boolean;
  holderPid?: number;
  lockPath: string;
  detail: string;
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

  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return {
      contended: false,
      stale: false,
      lockPath,
      detail: `no emulator lock on ${avdName} — free to boot`,
    };
  }

  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      contended: false,
      stale: true,
      lockPath,
      detail:
        `${lockPath} exists but holds no readable pid (${JSON.stringify(raw.trim().slice(0, 40))}). ` +
        'Treated as stale: an unparseable lock is not evidence anyone is using the AVD.',
    };
  }

  if (opts.selfPid !== undefined && pid === opts.selfPid) {
    return { contended: false, stale: false, holderPid: pid, lockPath, detail: `${avdName} is held by this process` };
  }

  if (!isPidAlive(pid)) {
    return {
      contended: false,
      stale: true,
      holderPid: pid,
      lockPath,
      detail: `${avdName}'s lock names pid ${pid}, which is gone — stale lock, safe to clear`,
    };
  }

  return {
    contended: true,
    stale: false,
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
