/**
 * The reverse reaper pass — `port -> find lock -> kill if there is no lock`.
 * Regression suite for dimagi-internal/ace#1158.
 *
 * `reapStaleSessions` walks `~/.ace/sessions/*.lock.json` and kills
 * daemons whose owning `mcp_pid` is dead. A daemon with **no lock at
 * all** is structurally invisible to it — and that is exactly what the
 * retry path produces. Observed live on
 * `hh-poverty-targeting/20260730-2210`: four orphan adb daemons on
 * 5040..5043 (all `ppid=1`, owner = current user, no lock) attached to
 * the same `emulator-5554` as the one *locked* daemon on 5038. Five adb
 * servers contending for one emulator's adbd broke Android's per-device
 * UiAutomation singleton; `ace-mobile-reap` reported
 * `{"reaped_locks": [], "killed_pids": []}` — zero killed, four
 * reapable orphans listening.
 *
 * Everything here runs against the PURE half of the sweep
 * (`parseLsofListeners` / `classifyLocklessListeners` /
 * `describeLocklessSweep`) or against `reapLocklessOrphans` with
 * injected `scan` + `kill`. Nothing shells out to lsof and nothing
 * sends a signal — a test suite that kills adb daemons on the machine
 * running it would be worse than the bug.
 */

import { describe, it, expect } from 'vitest';
import {
  parseLsofListeners,
  classifyLocklessListeners,
  reapLocklessOrphans,
  inspectLocklessOrphans,
  describeLocklessSweep,
  allocatorRangeForPort,
  REAPABLE_LISTENER_PATTERN,
  ADB_SCAN_PORT_MIN,
  ADB_SCAN_PORT_MAX,
  EMULATOR_SCAN_PORT_MIN,
  EMULATOR_SCAN_PORT_MAX,
  type TcpListener,
} from '../../../mcp/mobile/session-lock.js';
import {
  DEFAULT_ADB_PORT,
  MIN_EMULATOR_CONSOLE_PORT,
  MAX_EMULATOR_CONSOLE_PORT,
} from '../../../mcp/mobile/port-allocator.js';

const NO_LOCKS = { adb: new Set<number>(), emulator: new Set<number>() };

/** The exact live state from the issue. */
function liveIncidentListeners(): TcpListener[] {
  return [
    { pid: 39821, command: 'adb', port: 5038 }, // has a lock (MCP 37510 alive)
    { pid: 42810, command: 'adb', port: 5040 }, // NO lock
    { pid: 42823, command: 'adb', port: 5041 }, // NO lock
    { pid: 42837, command: 'adb', port: 5042 }, // NO lock
    { pid: 42849, command: 'adb', port: 5043 }, // NO lock
  ];
}

describe('scan ranges agree with the allocator (no silent drift)', () => {
  // The constants are duplicated in session-lock.ts to avoid an import
  // cycle (port-allocator already imports session-lock). This is what
  // stops the duplication from drifting.
  it('adb scan starts at the allocator default', () => {
    expect(ADB_SCAN_PORT_MIN).toBe(DEFAULT_ADB_PORT);
  });

  it('emulator scan spans the allocator range plus each pair adb bridge', () => {
    expect(EMULATOR_SCAN_PORT_MIN).toBe(MIN_EMULATOR_CONSOLE_PORT);
    expect(EMULATOR_SCAN_PORT_MAX).toBe(MAX_EMULATOR_CONSOLE_PORT + 1);
  });

  it('classifies ports into the right range, and ignores everything else', () => {
    expect(allocatorRangeForPort(5037)).toBe('adb');
    expect(allocatorRangeForPort(ADB_SCAN_PORT_MAX)).toBe('adb');
    expect(allocatorRangeForPort(5554)).toBe('emulator');
    expect(allocatorRangeForPort(5555)).toBe('emulator'); // the adb bridge
    expect(allocatorRangeForPort(EMULATOR_SCAN_PORT_MAX)).toBe('emulator');
    expect(allocatorRangeForPort(ADB_SCAN_PORT_MAX + 1)).toBeNull();
    expect(allocatorRangeForPort(5553)).toBeNull();
    expect(allocatorRangeForPort(8080)).toBeNull();
    expect(allocatorRangeForPort(50037)).toBeNull(); // the unit suite's fake locks
  });
});

describe('parseLsofListeners', () => {
  it('carries pid + command forward across a process set', () => {
    const raw = ['p42810', 'cadb', 'f7', 'n127.0.0.1:5040', 'f9', 'n127.0.0.1:5041'].join('\n');
    expect(parseLsofListeners(raw)).toEqual([
      { pid: 42810, command: 'adb', port: 5040 },
      { pid: 42810, command: 'adb', port: 5041 },
    ]);
  });

  it('handles wildcard and IPv6 address forms', () => {
    const raw = ['p900', 'cqemu-system-aarch64', 'n*:5554', 'n[::1]:5555'].join('\n');
    expect(parseLsofListeners(raw)).toEqual([
      { pid: 900, command: 'qemu-system-aarch64', port: 5554 },
      { pid: 900, command: 'qemu-system-aarch64', port: 5555 },
    ]);
  });

  it('is empty on empty / junk input rather than throwing', () => {
    expect(parseLsofListeners('')).toEqual([]);
    expect(parseLsofListeners('\n\n')).toEqual([]);
    expect(parseLsofListeners('nonsense without field tags')).toEqual([]);
  });
});

describe('classifyLocklessListeners — the live ace#1158 state', () => {
  // MCP 37510 is alive and its lock claims adb 5038.
  const reserved = { adb: new Set([5038]), emulator: new Set([5554, 5555]) };

  it('kills the four lockless orphans and spares the locked daemon', () => {
    const v = classifyLocklessListeners(liveIncidentListeners(), reserved, { selfPid: 1234 });
    const killed = v.filter((x) => x.action === 'kill').map((x) => x.pid);
    expect(killed).toEqual([42810, 42823, 42837, 42849]);

    const spared = v.find((x) => x.pid === 39821)!;
    expect(spared.action).toBe('skip');
    expect(spared.reason).toMatch(/live session lock/);
  });

  it('says WHY each one was killed', () => {
    const v = classifyLocklessListeners(liveIncidentListeners(), reserved, { selfPid: 1234 });
    for (const k of v.filter((x) => x.action === 'kill')) {
      expect(k.reason).toBe('no owning lock');
    }
  });
});

describe('classifyLocklessListeners — guards', () => {
  it('never kills a non-adb/qemu listener squatting an allocator port', () => {
    const v = classifyLocklessListeners(
      [{ pid: 700, command: 'node', port: 5040 }],
      NO_LOCKS,
      { selfPid: 1 },
    );
    expect(v[0].action).toBe('skip');
    expect(v[0].reason).toMatch(/not an adb\/qemu listener/);
  });

  it('never kills this process', () => {
    const v = classifyLocklessListeners(
      [{ pid: 4242, command: 'adb', port: 5040 }],
      NO_LOCKS,
      { selfPid: 4242 },
    );
    expect(v[0].action).toBe('skip');
    expect(v[0].reason).toBe('this process');
  });

  it('ignores adb daemons outside the allocator ranges entirely', () => {
    const v = classifyLocklessListeners(
      [
        { pid: 800, command: 'adb', port: 5100 },
        { pid: 801, command: 'adb', port: 50037 },
      ],
      NO_LOCKS,
      { selfPid: 1 },
    );
    expect(v).toEqual([]);
  });

  it('spares the emulator adb-bridge port a live lock implies', () => {
    // A lock records only `emulator_port`; the emulator also listens on
    // +1. Forgetting the bridge would kill a live session's emulator.
    const reserved = { adb: new Set<number>(), emulator: new Set([5554, 5555]) };
    const v = classifyLocklessListeners(
      [{ pid: 900, command: 'qemu-system-aarch64', port: 5555 }],
      reserved,
      { selfPid: 1 },
    );
    expect(v[0].action).toBe('skip');
  });

  it('matches every real emulator/adb process name', () => {
    for (const cmd of ['adb', 'qemu-system-aarch64', 'qemu-system-x86_64', 'emulator']) {
      expect(REAPABLE_LISTENER_PATTERN.test(cmd)).toBe(true);
    }
    for (const cmd of ['node', 'python3.11', 'Google Chrome', 'ssh']) {
      expect(REAPABLE_LISTENER_PATTERN.test(cmd)).toBe(false);
    }
  });
});

describe('reapLocklessOrphans', () => {
  const scan = () => ({ listeners: liveIncidentListeners(), errors: [] as string[] });
  const reserved = () => ({ adb: new Set([5038]), emulator: new Set([5554, 5555]) });

  it('kills the orphans and reports each with its reason', () => {
    const killedPids: number[] = [];
    const r = reapLocklessOrphans({
      scan,
      reserved,
      selfPid: 1,
      kill: (pid) => {
        killedPids.push(pid);
        return true;
      },
    });
    expect(killedPids).toEqual([42810, 42823, 42837, 42849]);
    expect(r.killed).toHaveLength(4);
    expect(r.killed.every((v) => v.reason === 'no owning lock')).toBe(true);
    expect(r.skipped.map((v) => v.pid)).toEqual([39821]);
  });

  it('demotes a kill that did not take, rather than claiming it', () => {
    const r = reapLocklessOrphans({ scan, reserved, selfPid: 1, kill: () => false });
    expect(r.killed).toEqual([]);
    expect(r.skipped.filter((v) => /SIGKILL did not take/.test(v.reason))).toHaveLength(4);
  });

  it('surfaces a scan failure instead of reporting a clean sweep', () => {
    const r = reapLocklessOrphans({
      scan: () => ({ listeners: [], errors: ['lsof scan failed: boom'] }),
      reserved: () => NO_LOCKS,
      kill: () => true,
    });
    expect(r.killed).toEqual([]);
    expect(r.errors).toEqual(['lsof scan failed: boom']);
  });

  it('inspect mode classifies without killing anything', () => {
    // No `kill` is injected at all — if inspect ever sends a signal it
    // would have to reach for the real `killPid`, which this assertion
    // (four live "kill" verdicts, zero processes touched) documents it
    // must not do.
    const r = inspectLocklessOrphans({ scan, reserved, selfPid: 1 });
    expect(r.verdicts.filter((v) => v.action === 'kill')).toHaveLength(4);
    expect(r.verdicts.filter((v) => v.action === 'skip')).toHaveLength(1);
  });
});

describe('describeLocklessSweep — never a reassuring empty result', () => {
  it('names every kill with its port and reason', () => {
    const lines = describeLocklessSweep({
      killed: [{ pid: 42810, port: 5040, command: 'adb', action: 'kill', reason: 'no owning lock' }],
      skipped: [],
      errors: [],
    });
    expect(lines[0]).toMatch(/killed pid 42810 \(adb\) on :5040 — no owning lock/);
  });

  it('reports listeners it declined to kill — the ace#1158 symptom', () => {
    // The bug was `{killed_pids: []}` printed while four reapable
    // daemons were listening. A sweep that sees listeners and kills
    // none must still enumerate them.
    const lines = describeLocklessSweep({
      killed: [],
      skipped: [
        {
          pid: 39821,
          port: 5038,
          command: 'adb',
          action: 'skip',
          reason: 'claimed by a live session lock (owner pid alive)',
        },
      ],
      errors: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/kept\s+pid 39821 \(adb\) on :5038 — claimed by a live session lock/);
  });

  it('says so explicitly when there is genuinely nothing there', () => {
    expect(describeLocklessSweep({ killed: [], skipped: [], errors: [] })).toEqual([
      'no adb/qemu listeners in the allocator port ranges',
    ]);
  });
});
