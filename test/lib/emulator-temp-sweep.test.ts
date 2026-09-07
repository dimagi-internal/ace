/**
 * The emulator temp-partition sweep's decision logic (ace#2092).
 *
 * Pure set logic over a directory listing, an `lsof` result and a process
 * count. The NEGATIVE control is the one that matters: a qcow2 belonging to a
 * LIVE emulator must survive every path through this function. Deleting a
 * running VM's data partition mid-walk is a far worse outcome than 38 GiB of
 * garbage — and Phase 6's Learn completion is one-way per (test user,
 * opportunity), so a destroyed walk is not merely retried.
 *
 * CLASSIFICATION: unit-testable logic. Nothing here is sent to or matched
 * against a device.
 */
import { describe, it, expect } from 'vitest';
import {
  planEmulatorTempSweep,
  describeEmulatorTempSweep,
  isEmulatorTempPartition,
  formatBytes,
  DEFAULT_TEMP_SWEEP_GRACE_MS,
  type EmulatorTempFile,
  type EmulatorTempSweepFacts,
} from '../../lib/emulator-temp-sweep.js';

const NOW = Date.parse('2026-09-06T20:38:51Z');
const GiB = 1024 ** 3;

function file(name: string, ageMs: number, sizeBytes = 2 * GiB): EmulatorTempFile {
  return { path: `/private/tmp/android-acedimagi/${name}`, sizeBytes, mtimeMs: NOW - ageMs };
}

function facts(over: Partial<EmulatorTempSweepFacts> = {}): EmulatorTempSweepFacts {
  return {
    files: [],
    openPaths: new Set<string>(),
    lsofUsable: true,
    liveEmulatorCount: 0,
    nowMs: NOW,
    graceMs: DEFAULT_TEMP_SWEEP_GRACE_MS,
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('isEmulatorTempPartition', () => {
  it('matches the per-boot partition shape', () => {
    expect(isEmulatorTempPartition('emulator-6Y3598.qcow2')).toBe(true);
    expect(isEmulatorTempPartition('emulator-00m6tF.qcow2')).toBe(true);
  });

  it('does not match the sibling hardware-config files, which are out of scope', () => {
    // Real names from /tmp/android-acedimagi. These are read once at boot
    // rather than held open, so lsof cannot prove a live emulator's copy is
    // in use — 0.11 MiB of risk we decline.
    expect(isEmulatorTempPartition('emulator-o4Anp8')).toBe(false);
    expect(isEmulatorTempPartition('emulator-1jvnTf')).toBe(false);
    expect(isEmulatorTempPartition('emu-crash-36.5.11.db')).toBe(false);
  });

  it('is anchored at both ends — a persistent AVD image is never a candidate', () => {
    expect(isEmulatorTempPartition('userdata-qemu.qcow2')).toBe(false);
    expect(isEmulatorTempPartition('emulator-abc.qcow2.bak')).toBe(false);
    expect(isEmulatorTempPartition('my-emulator-abc.qcow2')).toBe(false);
    expect(isEmulatorTempPartition('emulator-../../etc/passwd.qcow2')).toBe(false);
  });
});

describe('NEGATIVE CONTROL — a live emulator partition is never deleted', () => {
  it('retains a file lsof reports as held open, however old it is', () => {
    const live = file('emulator-LIVE01.qcow2', 30 * DAY);
    const dead = file('emulator-DEAD01.qcow2', 30 * DAY);

    const plan = planEmulatorTempSweep(
      facts({
        files: [live, dead],
        openPaths: new Set([live.path]),
        liveEmulatorCount: 1,
      }),
    );

    expect(plan.orphans.map((f) => f.path)).toEqual([dead.path]);
    expect(plan.retained).toEqual([{ file: live, reason: 'held-open' }]);
    expect(plan.reclaimableBytes).toBe(2 * GiB);
  });

  it('retains a partition inside the grace window even with nothing open', () => {
    // The blind spot in the lsof read: an emulator part-way through boot has
    // created its partition but we raced its fd table.
    const booting = file('emulator-BOOT01.qcow2', 5 * 60 * 1000);
    const plan = planEmulatorTempSweep(facts({ files: [booting] }));
    expect(plan.orphans).toEqual([]);
    expect(plan.retained).toEqual([{ file: booting, reason: 'within-grace' }]);
    expect(plan.reclaimableBytes).toBe(0);
  });

  it('refuses the whole sweep when live emulators exist but lsof found none open', () => {
    // The two reads disagree, and lsof is the one we would be trusting with
    // an unlink. Refuse rather than pick a winner.
    const plan = planEmulatorTempSweep(
      facts({
        files: [file('emulator-A.qcow2', 30 * DAY), file('emulator-B.qcow2', 30 * DAY)],
        openPaths: new Set(),
        liveEmulatorCount: 2,
      }),
    );
    expect(plan.skipped).toMatch(/2 live emulator process\(es\) but lsof reports none/);
    expect(plan.orphans).toEqual([]);
    expect(plan.reclaimableBytes).toBe(0);
    expect(plan.totalBytes).toBe(4 * GiB);
  });

  it('refuses the whole sweep when lsof could not be run', () => {
    const plan = planEmulatorTempSweep(
      facts({ files: [file('emulator-A.qcow2', 30 * DAY)], lsofUsable: false }),
    );
    expect(plan.skipped).toMatch(/lsof could not be run/);
    expect(plan.orphans).toEqual([]);
    expect(plan.reclaimableBytes).toBe(0);
  });

  it('every refusal path returns an EMPTY orphan list, so ignoring `skipped` deletes nothing', () => {
    const stale = [file('emulator-A.qcow2', 30 * DAY)];
    const refusals: EmulatorTempSweepFacts[] = [
      facts({ files: stale, lsofUsable: false }),
      facts({ files: stale, liveEmulatorCount: 3 }),
    ];
    for (const f of refusals) {
      const plan = planEmulatorTempSweep(f);
      expect(plan.skipped).toBeTruthy();
      expect(plan.orphans).toEqual([]);
      expect(plan.reclaimableBytes).toBe(0);
    }
  });
});

describe('POSITIVE CONTROL — the measured leak is reclaimed', () => {
  it('sweeps a workstation-shaped directory with no live emulator', () => {
    // Shaped after the real measurement: 73 partitions, 38.14 GiB, zero live
    // emulators, all from previous dispatches.
    const files = Array.from({ length: 73 }, (_, i) =>
      file(`emulator-${String(i).padStart(6, 'a')}.qcow2`, (i + 2) * 60 * 60 * 1000, 561_000_000),
    );
    const plan = planEmulatorTempSweep(facts({ files }));

    expect(plan.skipped).toBeNull();
    expect(plan.orphans).toHaveLength(73);
    expect(plan.retained).toEqual([]);
    expect(plan.reclaimableBytes).toBe(73 * 561_000_000);
  });

  it('reclaims the dead partitions while a live emulator is running', () => {
    // The mixed case the reaper actually meets: one session working, the
    // previous 69 boots leaked.
    const live = file('emulator-LIVE.qcow2', 2 * 60 * 1000);
    const dead = Array.from({ length: 69 }, (_, i) =>
      file(`emulator-d${String(i).padStart(5, '0')}.qcow2`, (i + 3) * 60 * 60 * 1000),
    );
    const plan = planEmulatorTempSweep(
      facts({ files: [live, ...dead], openPaths: new Set([live.path]), liveEmulatorCount: 1 }),
    );

    expect(plan.skipped).toBeNull();
    expect(plan.orphans).toHaveLength(69);
    expect(plan.orphans.map((f) => f.path)).not.toContain(live.path);
    expect(plan.retained).toEqual([{ file: live, reason: 'held-open' }]);
  });

  it('is a no-op on a clean host', () => {
    const plan = planEmulatorTempSweep(facts({ files: [] }));
    expect(plan.skipped).toBeNull();
    expect(plan.orphans).toEqual([]);
    expect(plan.totalBytes).toBe(0);
    expect(describeEmulatorTempSweep(plan)).toContain('  (nothing to sweep)');
  });

  it('does not refuse on the disagreement guard when the directory is empty', () => {
    // A live emulator whose partition is not in a directory we scan is not a
    // contradiction — there is nothing to be wrong about.
    const plan = planEmulatorTempSweep(facts({ files: [], liveEmulatorCount: 4 }));
    expect(plan.skipped).toBeNull();
  });
});

describe('grace window', () => {
  it('is exclusive at the boundary — exactly graceMs old is an orphan', () => {
    const at = file('emulator-A.qcow2', DEFAULT_TEMP_SWEEP_GRACE_MS);
    const justInside = file('emulator-B.qcow2', DEFAULT_TEMP_SWEEP_GRACE_MS - 1);
    const plan = planEmulatorTempSweep(facts({ files: [at, justInside] }));
    expect(plan.orphans.map((f) => f.path)).toEqual([at.path]);
    expect(plan.retained.map((r) => r.file.path)).toEqual([justInside.path]);
  });

  it('honours a caller-supplied window', () => {
    const f = file('emulator-A.qcow2', 90 * 60 * 1000);
    expect(planEmulatorTempSweep(facts({ files: [f], graceMs: 2 * 60 * 60 * 1000 })).orphans).toEqual(
      [],
    );
    expect(planEmulatorTempSweep(facts({ files: [f], graceMs: 30 * 60 * 1000 })).orphans).toEqual([f]);
  });
});

describe('operator output', () => {
  it('a refusal SAYS what it saw and declined, never an empty reassurance', () => {
    // The `describeLocklessSweep` lesson: a reassuring "nothing to do" over a
    // directory full of reapable files is the failure, not the success.
    const plan = planEmulatorTempSweep(
      facts({ files: [file('emulator-A.qcow2', 30 * DAY)], lsofUsable: false }),
    );
    const lines = describeEmulatorTempSweep(plan).join('\n');
    expect(lines).toMatch(/SKIPPED/);
    expect(lines).toMatch(/2\.0 GiB/);
    expect(lines).toMatch(/deleted nothing/);
  });

  it('names the reclaimable total and what was kept, and why', () => {
    const live = file('emulator-LIVE.qcow2', 30 * DAY);
    const booting = file('emulator-BOOT.qcow2', 60 * 1000);
    const dead = file('emulator-DEAD.qcow2', 30 * DAY);
    const plan = planEmulatorTempSweep(
      facts({ files: [live, booting, dead], openPaths: new Set([live.path]), liveEmulatorCount: 1 }),
    );
    const lines = describeEmulatorTempSweep(plan).join('\n');
    expect(lines).toMatch(/1 orphaned partition\(s\), 2\.0 GiB reclaimable/);
    expect(lines).toMatch(/of 6\.0 GiB seen; 1 live emulator\(s\)/);
    expect(lines).toMatch(/kept 1 held open by a live process/);
    expect(lines).toMatch(/kept 1 inside the grace window/);
  });

  it('formats bytes at each scale', () => {
    expect(formatBytes(38.14 * GiB)).toBe('38.1 GiB');
    expect(formatBytes(4585)).toBe('4.5 KiB');
    expect(formatBytes(196_616)).toBe('192.0 KiB');
    expect(formatBytes(12)).toBe('12 B');
  });
});
