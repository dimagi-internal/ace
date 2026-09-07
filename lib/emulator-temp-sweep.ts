/**
 * Reclaiming the temp data partitions that SIGKILL-reaped emulators leak
 * (ace#2092).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Both ACE pool AVDs run an EPHEMERAL data partition:
 *
 *     $ grep -E "^disk.dataPartition" ~/.android/avd/ACE_Pixel_API_34.avd/config.ini
 *     disk.dataPartition.path=<temp>
 *     disk.dataPartition.size=6G
 *
 * With `<temp>`, the emulator allocates a fresh qcow2 under its temp dir per
 * boot and unlinks it on a CLEAN shutdown. ACE's dispatch model is "always
 * cold-boot, and reap the previous emulator with SIGKILL"
 * (`mobile_ensure_avd_running`'s restore-unconditionally contract;
 * `bin/ace-mobile-reap`). SIGKILL means qemu's cleanup path never runs, so
 * every dispatch leaks one ~2 GiB file, forever.
 *
 * Measured on the ACE workstation 2026-09-06 20:38: **73 files, 38.14 GiB** in
 * `/tmp/android-acedimagi` with ZERO live emulators on the host. (The issue
 * measured 70 / 37 GiB ~90 minutes earlier — it grows per dispatch.)
 *
 * The SIGKILL is CORRECT and is not what changes here. A killed qemu cannot
 * clean up after itself, so the fix is reclamation, not a gentler kill.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONLY QUESTION THAT MATTERS: IS THIS FILE LIVE?
 *
 * A qcow2 belonging to a running emulator must NEVER be touched — deleting a
 * live VM's data partition mid-walk is a far worse outcome than 38 GiB of
 * garbage. The filename is a random 6-character token with no pid in it, so
 * the binding has to come from somewhere else. Three guards, and a file has to
 * clear ALL of them to be deleted:
 *
 *  1. **No live process holds it open.** qemu holds its block-device fds for
 *     the life of the VM, so `lsof` over the candidate paths is an exact
 *     file → holder binding. This is NOT a new liveness heuristic; it is the
 *     only thing that can answer "which file" at all.
 *
 *  2. **Its mtime is older than a grace window** (default 60 min). Covers the
 *     blind spot in (1): an emulator part-way through boot that has created
 *     its partition but whose fd table we raced.
 *
 *  3. **The whole sweep is REFUSED** unless `lsof` actually ran, and refused
 *     again if `parseEmulatorProcesses` (`lib/mobile-contention.ts` — ACE's
 *     one process-table emulator detector, deliberately reused rather than
 *     duplicated) sees a live emulator while `lsof` reports no open partition
 *     in the directory. A live emulator on an ephemeral partition MUST hold
 *     one; if it does not appear to, our read is incomplete and nothing is
 *     safe to delete. Refusing costs one deferred cleanup. Being wrong costs
 *     a Phase 6 walk, and Learn completion is one-way.
 *
 * Scope is `*.qcow2` ONLY. The issue also proposed sweeping the sibling
 * `emulator-<token>` hardware-config files; they total 0.11 MiB against
 * 38.14 GiB, and unlike the partition they are read once at boot rather than
 * held open, so guard (1) cannot see a live emulator's copy. Deliberately
 * out of scope — all of the value, none of that risk.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLASSIFICATION: unit-testable logic. This module is pure — the caller
 * supplies the directory listing, the lsof result and the process table, and
 * gets back a PLAN. Nothing here is sent to or matched against a device.
 * `mcp/mobile/session-lock.ts` owns the impure collector and the `unlink`,
 * mirroring the pure-lib / impure-collector split `lib/mobile-contention.ts`
 * established.
 */

/** One candidate file, as the collector stat'ed it. Paths are REALPATHS. */
export interface EmulatorTempFile {
  /** Absolute, symlink-resolved. macOS `/tmp` is a symlink to `/private/tmp`
   *  and `lsof` reports the resolved form, so an unresolved path here would
   *  silently match nothing and every live file would look like an orphan. */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface EmulatorTempSweepFacts {
  files: readonly EmulatorTempFile[];
  /** Realpaths currently held open by any live process, per `lsof`. */
  openPaths: ReadonlySet<string>;
  /** False when `lsof` could not be run at all. Forces a refusal. */
  lsofUsable: boolean;
  /** From `parseEmulatorProcesses` — ACE's existing process-table detector. */
  liveEmulatorCount: number;
  nowMs: number;
  graceMs: number;
}

export type RetainReason = 'held-open' | 'within-grace';

export interface RetainedFile {
  file: EmulatorTempFile;
  reason: RetainReason;
}

export interface EmulatorTempSweepPlan {
  /** Safe to delete. Empty whenever `skipped` is non-null. */
  orphans: EmulatorTempFile[];
  /** Everything the sweep saw and declined to delete, with the reason. */
  retained: RetainedFile[];
  /** Bytes the orphans occupy. Zero whenever `skipped` is non-null. */
  reclaimableBytes: number;
  /** Non-null means DELETE NOTHING, and says why. Load-bearing output. */
  skipped: string | null;
  liveEmulatorCount: number;
  /** Total bytes seen, deletable or not — the size of the problem. */
  totalBytes: number;
}

/**
 * An hour. A dispatch's own partition is written to continuously while the
 * emulator runs, so anything this old is not an emulator that is doing work;
 * and the window only has to cover the gap between "file created" and "fd
 * visible to lsof", which is milliseconds.
 */
export const DEFAULT_TEMP_SWEEP_GRACE_MS = 60 * 60 * 1000;

/**
 * `emulator-<token>.qcow2` — the per-boot ephemeral data partition.
 *
 * Anchored at both ends on purpose. A looser `*.qcow2` would also match an
 * AVD's own persistent `userdata-qemu.qcow2` if one were ever staged here,
 * and this function is the last thing standing between a regex and `unlink`.
 */
const EMULATOR_TEMP_PARTITION_RE = /^emulator-[A-Za-z0-9]+\.qcow2$/;

export function isEmulatorTempPartition(basename: string): boolean {
  return EMULATOR_TEMP_PARTITION_RE.test(basename);
}

/**
 * Decide what may be deleted. Pure.
 *
 * Every refusal path returns `orphans: []` and `reclaimableBytes: 0` with a
 * populated `skipped`, so a caller that ignores `skipped` still deletes
 * nothing — the failure mode of a misread is "we reclaimed no disk", never
 * "we deleted a live emulator's partition".
 */
export function planEmulatorTempSweep(facts: EmulatorTempSweepFacts): EmulatorTempSweepPlan {
  const totalBytes = facts.files.reduce((n, f) => n + f.sizeBytes, 0);
  const refuse = (why: string): EmulatorTempSweepPlan => ({
    orphans: [],
    retained: [],
    reclaimableBytes: 0,
    skipped: why,
    liveEmulatorCount: facts.liveEmulatorCount,
    totalBytes,
  });

  if (!facts.lsofUsable) {
    return refuse(
      'lsof could not be run, so no file could be proven unheld — refusing to delete anything',
    );
  }

  // A live emulator on an ephemeral data partition MUST hold one open. If the
  // process table says one is running and lsof found nothing open here, the
  // two disagree and the lsof read is the one we would be trusting with an
  // unlink. Refuse rather than pick a winner.
  const anyOpenHere = facts.files.some((f) => facts.openPaths.has(f.path));
  if (facts.liveEmulatorCount > 0 && !anyOpenHere && facts.files.length > 0) {
    return refuse(
      `${facts.liveEmulatorCount} live emulator process(es) but lsof reports none of the ` +
        `${facts.files.length} partition file(s) open — the two reads disagree, refusing to delete anything`,
    );
  }

  const orphans: EmulatorTempFile[] = [];
  const retained: RetainedFile[] = [];

  for (const file of facts.files) {
    if (facts.openPaths.has(file.path)) {
      retained.push({ file, reason: 'held-open' });
      continue;
    }
    if (facts.nowMs - file.mtimeMs < facts.graceMs) {
      retained.push({ file, reason: 'within-grace' });
      continue;
    }
    orphans.push(file);
  }

  return {
    orphans,
    retained,
    reclaimableBytes: orphans.reduce((n, f) => n + f.sizeBytes, 0),
    skipped: null,
    liveEmulatorCount: facts.liveEmulatorCount,
    totalBytes,
  };
}

/** GiB/MiB/KiB, one decimal. For operator output only. */
export function formatBytes(bytes: number): string {
  const units: [number, string][] = [
    [1024 ** 3, 'GiB'],
    [1024 ** 2, 'MiB'],
    [1024, 'KiB'],
  ];
  for (const [scale, label] of units) {
    if (bytes >= scale) return `${(bytes / scale).toFixed(1)} ${label}`;
  }
  return `${bytes} B`;
}

/**
 * Operator-readable lines. A sweep that SAW files and declined to delete them
 * must say so — the same reasoning `describeLocklessSweep` carries: a
 * reassuring empty result over a directory full of reapable files is the
 * failure, not the success.
 */
export function describeEmulatorTempSweep(plan: EmulatorTempSweepPlan): string[] {
  const lines: string[] = [];
  if (plan.skipped) {
    lines.push(`SKIPPED — ${plan.skipped}`);
    lines.push(
      `  saw ${plan.totalBytes > 0 ? formatBytes(plan.totalBytes) : '0 B'} of emulator temp partitions; deleted nothing`,
    );
    return lines;
  }
  lines.push(
    `${plan.orphans.length} orphaned partition(s), ${formatBytes(plan.reclaimableBytes)} reclaimable ` +
      `(of ${formatBytes(plan.totalBytes)} seen; ${plan.liveEmulatorCount} live emulator(s))`,
  );
  const held = plan.retained.filter((r) => r.reason === 'held-open').length;
  const grace = plan.retained.filter((r) => r.reason === 'within-grace').length;
  if (held > 0) lines.push(`  kept ${held} held open by a live process`);
  if (grace > 0) lines.push(`  kept ${grace} inside the grace window`);
  if (plan.orphans.length === 0 && plan.retained.length === 0) lines.push('  (nothing to sweep)');
  return lines;
}
