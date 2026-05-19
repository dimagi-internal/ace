import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AvdBackend } from '../../../mcp/mobile/backends/avd.js';

function fakeShell(scripted: Record<string, { stdout: string; stderr?: string; code?: number }>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = scripted[key];
    if (!r) throw new Error(`Unscripted shell call: ${key}`);
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.code ?? 0 };
  });
}

import { AvdBootError, AvdBootTimeoutError } from '../../../mcp/mobile/errors.js';

describe('AvdBackend.listAvds', () => {
  it('parses emulator -list-avds output', async () => {
    const shell = fakeShell({
      'emulator -list-avds': { stdout: 'ACE_Pixel_API_34\nOther_AVD\n' },
    });
    const backend = new AvdBackend({ shell });
    const result = await backend.listAvds();
    expect(result).toEqual(['ACE_Pixel_API_34', 'Other_AVD']);
  });

  it('returns empty array when no AVDs', async () => {
    const shell = fakeShell({ 'emulator -list-avds': { stdout: '' } });
    const backend = new AvdBackend({ shell });
    expect(await backend.listAvds()).toEqual([]);
  });
});

describe('AvdBackend.ensureAvdRunning', () => {
  it('kills any prior running emulator for the same AVD before re-booting (cold-boot model)', async () => {
    // The prior fast-path "return existing serial if already booted"
    // was a warm-AVD optimization that masked accumulated junk-state
    // (lockscreen residue, wedged Maestro driver, GMS toggles) across
    // dispatches. The new contract: every call cold-boots, so any
    // running emulator for this AVD MUST be killed first.
    //
    // We can't easily mock the detached `emulator` spawn from a unit
    // test (it forks a real binary). Instead we observe the kill call
    // synchronously, then cancel the test before the boot-poll loop
    // takes effect.
    const calls: string[] = [];
    let killed = false;
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'adb -s emulator-5554 emu kill') {
        killed = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (key === 'adb devices') {
        return killed
          ? { stdout: 'List of devices attached\n', stderr: '', exitCode: 0 }
          : {
              stdout: 'List of devices attached\nemulator-5554\tdevice\n',
              stderr: '',
              exitCode: 0,
            };
      }
      if (key === 'adb -s emulator-5554 emu avd name') {
        return { stdout: 'ACE_Pixel_API_34\nOK\n', stderr: '', exitCode: 0 };
      }
      if (key === 'emulator -list-avds') {
        return { stdout: 'ACE_Pixel_API_34\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = new AvdBackend({ shell });
    // The real emulator spawn would never produce a device in this
    // test, so ensureAvdRunning will eventually throw AvdBootError on
    // boot timeout. We don't care about that — we only care that the
    // kill ran first.
    const p = backend.ensureAvdRunning('ACE_Pixel_API_34').catch(() => null);
    // Give the find + kill round-trip a beat to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(killed).toBe(true);
    expect(calls).toContain('adb -s emulator-5554 emu kill');
    // Don't await `p` — it's blocked on the boot poll. The test framework
    // will not flag a dangling unresolved promise.
  });

  it('throws AvdBootError if AVD does not exist (cold-boot path: listAvds runs before kill)', async () => {
    // The cold-boot orchestration calls listAvds early to surface
    // unknown-AVD errors quickly. No `emu kill` should fire when there
    // is no running emulator AND the requested AVD isn't even known.
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\n' },
      'emulator -list-avds': { stdout: 'Other_AVD\n' },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);
  });

  // Pin emulator console port to 5554 so the expected serial in mocks
  // is stable across machines (probe-allocator would skip 5554 if it
  // detected anything on that port).
  const savedEmuPort = process.env.ACE_MOBILE_EMULATOR_PORT;
  const savedAdbPort = process.env.ANDROID_ADB_SERVER_PORT;
  beforeEach(() => {
    process.env.ACE_MOBILE_EMULATOR_PORT = '5554';
    process.env.ANDROID_ADB_SERVER_PORT = '5037';
  });
  afterEach(() => {
    if (savedEmuPort === undefined) delete process.env.ACE_MOBILE_EMULATOR_PORT;
    else process.env.ACE_MOBILE_EMULATOR_PORT = savedEmuPort;
    if (savedAdbPort === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
    else process.env.ANDROID_ADB_SERVER_PORT = savedAdbPort;
  });

  // Regression suite for the v0.13.270 cold-boot wait short-circuit
  // (malaria-itn-fgd/20260515-1645 Phase 6 attempt 7). The original
  // boot-wait returned the first `offline` reading from `adb devices`
  // as fatal, throwing within ~1s while the emulator was still finishing
  // its cold-boot. The fix: a three-phase wait (adb-register →
  // boot-completed → storage-mount) that tolerates the brief `offline`
  // window and reports which phase ran out of budget if any.

  it('cold-boot waits for device-then-boot-completed (does not bail on the brief offline window)', async () => {
    // Mock adb devices to report offline for the first 2 polls, then
    // device. Then `getprop sys.boot_completed` returns empty for 1
    // poll, then 1. Then `test -e /storage/emulated/0` exits 0.
    // Expected: ensureAvdRunning resolves with the booted AvdInfo.
    let devicesPolls = 0;
    let bootPolls = 0;
    const calls: string[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'emulator -list-avds') {
        return { stdout: 'ACE_Pixel_API_34\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb devices') {
        devicesPolls += 1;
        // First find-running-avd probe sees nothing (no prior). After
        // spawn, the wait poll sees offline twice, then device.
        const lines: string[] = ['List of devices attached'];
        if (devicesPolls === 1) {
          // pre-spawn `findRunningAvd` lookup — return empty
        } else if (devicesPolls <= 3) {
          lines.push('emulator-5554\toffline');
        } else {
          lines.push('emulator-5554\tdevice');
        }
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb -s emulator-5554 shell getprop sys.boot_completed') {
        bootPolls += 1;
        return { stdout: bootPolls < 2 ? '\n' : '1\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb -s emulator-5554 shell test -e /storage/emulated/0') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (key === 'adb -s emulator-5554 emu avd name') {
        return { stdout: 'ACE_Pixel_API_34\nOK\n', stderr: '', exitCode: 0 };
      }
      // Best-effort post-boot prep — all return success.
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = new AvdBackend({
      shell,
      bootWait: { adbRegisterMs: 2000, bootCompletedMs: 2000, storageMountMs: 1000, pollMs: 20 },
    });
    const info = await backend.ensureAvdRunning('ACE_Pixel_API_34');
    expect(info).toMatchObject({ name: 'ACE_Pixel_API_34', serial: 'emulator-5554' });
    // Sanity: we polled `adb devices` more than once (proves we waited
    // past the first `offline` reading rather than bailing).
    expect(devicesPolls).toBeGreaterThan(2);
  });

  it('cold-boot throws AvdBootTimeoutError(phase=adb-register) when serial never appears as device', async () => {
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key === 'emulator -list-avds') {
        return { stdout: 'ACE_Pixel_API_34\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb devices') {
        // Always empty — emulator never registers.
        return { stdout: 'List of devices attached\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = new AvdBackend({
      shell,
      bootWait: { adbRegisterMs: 200, bootCompletedMs: 200, storageMountMs: 200, pollMs: 20 },
    });
    await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toMatchObject({
      code: 'AVD_BOOT_TIMEOUT',
      diagnostics: expect.objectContaining({
        phase: 'adb-register',
        last_adb_state: null,
      }),
    });
  });

  it('cold-boot throws AvdBootTimeoutError(phase=boot-completed) when device registers but sys.boot_completed never flips', async () => {
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key === 'emulator -list-avds') {
        return { stdout: 'ACE_Pixel_API_34\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb devices') {
        return {
          stdout: 'List of devices attached\nemulator-5554\tdevice\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (key === 'adb -s emulator-5554 shell getprop sys.boot_completed') {
        return { stdout: '\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = new AvdBackend({
      shell,
      bootWait: { adbRegisterMs: 1000, bootCompletedMs: 200, storageMountMs: 200, pollMs: 20 },
    });
    await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toMatchObject({
      code: 'AVD_BOOT_TIMEOUT',
      diagnostics: expect.objectContaining({
        phase: 'boot-completed',
        last_adb_state: 'device',
        last_boot_completed: '',
      }),
    });
  });

  it('cold-boot kills orphan qemu via `adb emu kill` when the wait throws', async () => {
    // The wait throws (adb never reports device); the catch handler MUST
    // fire `adb -s emulator-5554 emu kill` against the just-spawned
    // qemu so it doesn't keep running in the background.
    const calls: string[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'emulator -list-avds') {
        return { stdout: 'ACE_Pixel_API_34\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb devices') {
        return { stdout: 'List of devices attached\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = new AvdBackend({
      shell,
      bootWait: { adbRegisterMs: 100, bootCompletedMs: 100, storageMountMs: 100, pollMs: 20 },
    });
    await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(
      AvdBootTimeoutError,
    );
    // Orphan-kill fired against the expected serial (derived from the
    // allocated emulator console port — 5554 on a clean test box).
    expect(calls).toContain('adb -s emulator-5554 emu kill');
  });

  // Regression suite for the qemu+adb-daemon-wedge class observed
  // three times in malaria-itn-fgd/20260515-1645 Phase 6 attempts 8,
  // 10, 11. Same precondition-restore pattern as the cold-boot itself
  // (CLAUDE.md § "Phase preconditions are restored, not adapted") —
  // one layer lower (qemu+adb daemon state, not AVD content state).

  it('sweepStaleEmulatorState: restarts adb daemon as pre-step before the AVD-specific emu kill', async () => {
    const calls: string[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      if (key === 'pgrep -f qemu-system') {
        // No qemu PIDs — skip the orphan-kill branch and just exercise
        // the always-restart adb-server step.
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (key === 'emulator -list-avds') {
        // Unknown AVD — we don't actually care about boot, we just
        // want to capture the order of pre-step adb daemon calls
        // before the AvdBootError throws.
        return { stdout: 'Other_AVD\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb devices') {
        return { stdout: 'List of devices attached\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);

    // adb kill-server and adb start-server must have fired before any
    // AVD-specific `emu kill` call (in this scenario emu kill never
    // fires, but the more important contract is that the daemon
    // restart is at the very top of the heal).
    const killSrvIdx = calls.indexOf('adb kill-server');
    const startSrvIdx = calls.indexOf('adb start-server');
    expect(killSrvIdx, 'expected adb kill-server in heal pre-step').toBeGreaterThan(-1);
    expect(startSrvIdx, 'expected adb start-server in heal pre-step').toBeGreaterThan(killSrvIdx);
    // The list-avds call (and therefore everything downstream) must
    // come AFTER the daemon restart, not before.
    const listAvdsIdx = calls.indexOf('emulator -list-avds');
    expect(listAvdsIdx).toBeGreaterThan(startSrvIdx);
  });

  it('sweepStaleEmulatorState: kills orphan qemu PIDs when adb sees no devices', async () => {
    if (process.platform === 'win32') return; // skipped on win32 by design
    const killed: number[] = [];
    const realKill = process.kill;
    // Stub process.kill so we can observe orphan kills without actually
    // signaling random PIDs on the test machine.
    (process as { kill: typeof process.kill }).kill = ((pid: number, _sig?: string | number) => {
      killed.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const shell = vi.fn(async (cmd: string, args: string[]) => {
        const key = `${cmd} ${args.join(' ')}`;
        if (key === 'pgrep -f qemu-system') {
          // Two orphan qemu PIDs (the attempt-10 reproducer signature).
          return { stdout: '90001\n90002\n', stderr: '', exitCode: 0 };
        }
        if (key === 'adb devices') {
          return { stdout: 'List of devices attached\n', stderr: '', exitCode: 0 };
        }
        if (key === 'emulator -list-avds') {
          return { stdout: 'Other_AVD\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const backend = new AvdBackend({ shell });
      await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);
      expect(killed).toContain(90001);
      expect(killed).toContain(90002);
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it('sweepStaleEmulatorState: orphan-qemu kill runs BEFORE adb kill-server with a socket-release wait between', async () => {
    if (process.platform === 'win32') return;
    // Regression guard for the 2026-05-19 malaria-itn-fgd attempt-12
    // re-occurrence (run 20260515-1645 Phase 6): PR #349 wired up
    // both the orphan-qemu sweep and the adb-server restart, but
    // without (a) firm ordering and (b) a socket-release wait between
    // them. The bug pattern: SIGKILL on qemu returns synchronously,
    // but the kernel takes a few hundred ms to release the
    // emulator-NNNN TCP sockets the qemu was holding. When the
    // adb-restart fires immediately after the kill, the freshly-
    // restarted daemon re-adopts the wedged-port state and the next
    // `ensureAvdRunning` still fails with "package service did not
    // bind." Empirically 2 attempts failed even after PR #349 was
    // live, before a *second* `adb kill-server`/`start-server`
    // inside the dispatch cleared it.
    //
    // Structural fix: orphan-qemu kill MUST run first, then a brief
    // (~500ms) wait, then adb-server restart.
    const events: { name: string; t: number }[] = [];
    const start = Date.now();
    const realKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, _sig?: string | number) => {
      events.push({ name: `process.kill(${pid})`, t: Date.now() - start });
      return true;
    }) as typeof process.kill;
    try {
      const shell = vi.fn(async (cmd: string, args: string[]) => {
        const key = `${cmd} ${args.join(' ')}`;
        events.push({ name: key, t: Date.now() - start });
        if (key === 'pgrep -f qemu-system') {
          // Two orphan qemu PIDs (matches attempt-12 signature).
          return { stdout: '90011\n90012\n', stderr: '', exitCode: 0 };
        }
        if (key === 'adb devices') {
          return { stdout: 'List of devices attached\n', stderr: '', exitCode: 0 };
        }
        if (key === 'emulator -list-avds') {
          // Unknown AVD short-circuits the rest of the boot path —
          // we only care about the order of the sweep steps here.
          return { stdout: 'Other_AVD\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const backend = new AvdBackend({ shell });
      await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);

      const firstOrphanKill = events.findIndex((e) => e.name.startsWith('process.kill('));
      const adbKillSrv = events.findIndex((e) => e.name === 'adb kill-server');
      const adbStartSrv = events.findIndex((e) => e.name === 'adb start-server');
      expect(firstOrphanKill, 'expected at least one orphan-qemu kill').toBeGreaterThan(-1);
      expect(adbKillSrv, 'expected adb kill-server in heal').toBeGreaterThan(-1);
      expect(adbStartSrv, 'expected adb start-server in heal').toBeGreaterThan(adbKillSrv);
      // ORDER: orphan kill must precede adb kill-server.
      expect(
        firstOrphanKill,
        'orphan-qemu kill must run BEFORE adb kill-server so the freshly-restarted daemon sees a clean port landscape',
      ).toBeLessThan(adbKillSrv);
      // SOCKET-RELEASE WAIT: at least ~400ms must pass between the
      // last orphan kill and adb kill-server (we wait 500ms; allow a
      // 100ms scheduling slack so the test isn't flaky on slow CI).
      const lastOrphanKillT = [...events]
        .reverse()
        .find((e) => e.name.startsWith('process.kill('))!.t;
      const adbKillSrvT = events[adbKillSrv].t;
      expect(
        adbKillSrvT - lastOrphanKillT,
        'expected ≥400ms socket-release wait between orphan-qemu kill and adb kill-server',
      ).toBeGreaterThanOrEqual(400);
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it('sweepStaleEmulatorState: kills orphan qemu PIDs when adb sees only a partial subset (no +2 threshold)', async () => {
    if (process.platform === 'win32') return;
    // Regression guard against re-introducing PR #349's conservative
    // `qemuPids.length >= liveCount + 2` guard. Attempt-12 signature:
    // 2 orphan qemu PIDs + 1 stale adb-devices entry → length 2,
    // liveCount 1 → 2 >= 1+2 is FALSE → no kill fires, orphans
    // survive into the next ensureAvdRunning. Loosened to
    // `qemuPids.length > liveCount`: with N > M, (N-M) PIDs are
    // orphan and must be killed.
    const killed: number[] = [];
    const realKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, _sig?: string | number) => {
      killed.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const shell = vi.fn(async (cmd: string, args: string[]) => {
        const key = `${cmd} ${args.join(' ')}`;
        if (key === 'pgrep -f qemu-system') {
          return { stdout: '90021\n90022\n', stderr: '', exitCode: 0 };
        }
        if (key === 'adb devices') {
          // One legitimate-looking adb device entry; 2 qemu PIDs.
          // PR #349 +2 guard wouldn't fire here — confirming the
          // loosened guard fires the kill for the orphan.
          return {
            stdout: 'List of devices attached\nemulator-5554\tdevice\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (key === 'emulator -list-avds') {
          return { stdout: 'Other_AVD\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const backend = new AvdBackend({ shell });
      await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);
      // (qemu length 2) - (live count 1) = 1 expected orphan kill.
      expect(killed.length).toBeGreaterThanOrEqual(1);
      // Killed the lowest PID first (the older, more-likely-orphan).
      expect(killed[0]).toBe(90021);
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it('sweepStaleEmulatorState: tolerates pgrep/kill failures (best-effort)', async () => {
    if (process.platform === 'win32') return;
    const realKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((_pid: number, _sig?: string | number) => {
      // Simulate ESRCH — the process was already gone.
      throw new Error('ESRCH');
    }) as typeof process.kill;
    try {
      const shell = vi.fn(async (cmd: string, args: string[]) => {
        const key = `${cmd} ${args.join(' ')}`;
        if (key === 'pgrep -f qemu-system') {
          return { stdout: '90003\n', stderr: '', exitCode: 0 };
        }
        if (key === 'adb devices') {
          return { stdout: 'List of devices attached\n', stderr: '', exitCode: 0 };
        }
        if (key === 'emulator -list-avds') {
          return { stdout: 'Other_AVD\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const backend = new AvdBackend({ shell });
      // Should still reach the unknown-AVD throw cleanly — the kill
      // failure during the sweep must NOT propagate.
      await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });
});

describe('AvdBackend.requireRunningAvd', () => {
  it('returns the running AVD info without triggering a boot', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
    });
    const backend = new AvdBackend({ shell });
    const info = await backend.requireRunningAvd('ACE_Pixel_API_34');
    expect(info).toMatchObject({ name: 'ACE_Pixel_API_34', serial: 'emulator-5554', status: 'booted' });
  });

  it('throws AvdBootError when the AVD is not currently running', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\n' },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.requireRunningAvd('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);
  });
});

describe('AvdBackend.stopAvd', () => {
  it('shells adb emu kill against the matching device', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu kill': { stdout: '' },
    });
    const backend = new AvdBackend({ shell });
    await backend.stopAvd('ACE_Pixel_API_34');
    expect(shell).toHaveBeenCalledWith('adb', ['-s', 'emulator-5554', 'emu', 'kill']);
  });
});

describe('AvdBackend.installApk', () => {
  it('shells adb install -r and parses package info via aapt', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 install -r /tmp/foo.apk': { stdout: 'Performing Streamed Install\nSuccess\n' },
      'aapt dump badging /tmp/foo.apk': {
        stdout: `package: name='org.commcare.dalvik' versionCode='2550' versionName='2.55'\n`,
      },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.installApk('ACE_Pixel_API_34', '/tmp/foo.apk');
    expect(r).toEqual({
      packageId: 'org.commcare.dalvik',
      versionName: '2.55',
      versionCode: 2550,
      path: '/tmp/foo.apk',
    });
  });
});

describe('AvdBackend.ensureFrontCameraEmulated', () => {
  let tmpAvdHome: string;
  let oldEnv: string | undefined;

  beforeEach(() => {
    tmpAvdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-test-'));
    oldEnv = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_AVD_HOME = tmpAvdHome;
  });
  afterEach(() => {
    if (oldEnv === undefined) delete process.env.ANDROID_AVD_HOME;
    else process.env.ANDROID_AVD_HOME = oldEnv;
    fs.rmSync(tmpAvdHome, { recursive: true, force: true });
  });

  function writeConfig(name: string, contents: string) {
    const dir = path.join(tmpAvdHome, `${name}.avd`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.ini'), contents);
  }

  function readConfig(name: string): string {
    return fs.readFileSync(path.join(tmpAvdHome, `${name}.avd`, 'config.ini'), 'utf8');
  }

  it('rewrites hw.camera.front=none to emulated', () => {
    writeConfig('AvdA', 'hw.camera.back=emulated\nhw.camera.front=none\nhw.gps=yes\n');
    const backend = new AvdBackend();
    expect(backend.ensureFrontCameraEmulated('AvdA')).toBe(true);
    expect(readConfig('AvdA')).toContain('hw.camera.front=emulated');
    expect(readConfig('AvdA')).not.toContain('hw.camera.front=none');
  });

  it('appends hw.camera.front=emulated when key missing', () => {
    writeConfig('AvdB', 'hw.camera.back=emulated\nhw.gps=yes\n');
    const backend = new AvdBackend();
    expect(backend.ensureFrontCameraEmulated('AvdB')).toBe(true);
    expect(readConfig('AvdB')).toMatch(/hw\.camera\.front=emulated\s*$/);
  });

  it('is a no-op when already set to emulated (idempotent)', () => {
    writeConfig('AvdC', 'hw.camera.front=emulated\n');
    const backend = new AvdBackend();
    expect(backend.ensureFrontCameraEmulated('AvdC')).toBe(false);
    // Original content preserved.
    expect(readConfig('AvdC')).toBe('hw.camera.front=emulated\n');
  });

  it('returns false when config.ini does not exist', () => {
    const backend = new AvdBackend();
    expect(backend.ensureFrontCameraEmulated('NonexistentAvd')).toBe(false);
  });
});

describe('AvdBackend.saveSnapshot / loadSnapshot', () => {
  it('shells adb emu avd snapshot save', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu avd snapshot save registered_user': { stdout: 'OK\n' },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.saveSnapshot('ACE_Pixel_API_34', 'registered_user');
    expect(r).toMatchObject({
      avdName: 'ACE_Pixel_API_34',
      snapshotName: 'registered_user',
      saved: true,
    });
  });

  it('shells adb emu avd snapshot load', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu avd snapshot load registered_user': { stdout: 'OK\n' },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.loadSnapshot('ACE_Pixel_API_34', 'registered_user');
    expect(r.saved).toBe(true);
  });

  it('reports saved=false when adb prints an error', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu avd snapshot load missing': {
        stdout: 'KO: error: snapshot not found\n',
      },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.loadSnapshot('ACE_Pixel_API_34', 'missing');
    expect(r.saved).toBe(false);
  });
});

describe('AvdBackend.captureUiDump', () => {
  it('runs uiautomator dump, pulls XML, parses elements', async () => {
    const xml = `<hierarchy><node resource-id="login_btn" text="Sign in" class="android.widget.Button" bounds="[0,0][100,50]"/></hierarchy>`;
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 shell uiautomator dump /data/local/tmp/window_dump.xml': { stdout: 'UI hierarchy dumped\n' },
      'adb -s emulator-5554 exec-out cat /data/local/tmp/window_dump.xml': { stdout: xml },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.captureUiDump('ACE_Pixel_API_34');
    expect(r.xml).toBe(xml);
    expect(r.elements).toContainEqual(
      expect.objectContaining({ id: 'login_btn', text: 'Sign in', class: 'android.widget.Button' }),
    );
  });
});

describe('AvdBackend.getAllocatedPorts', () => {
  const saved = {
    adb: process.env.ANDROID_ADB_SERVER_PORT,
    emu: process.env.ACE_MOBILE_EMULATOR_PORT,
  };
  afterEach(() => {
    if (saved.adb === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
    else process.env.ANDROID_ADB_SERVER_PORT = saved.adb;
    if (saved.emu === undefined) delete process.env.ACE_MOBILE_EMULATOR_PORT;
    else process.env.ACE_MOBILE_EMULATOR_PORT = saved.emu;
  });

  it('uses env-pinned ports when set, marks autoAllocated=false', async () => {
    process.env.ANDROID_ADB_SERVER_PORT = '5099';
    process.env.ACE_MOBILE_EMULATOR_PORT = '5580';
    const backend = new AvdBackend({ rawShell: true });
    const ports = await backend.getAllocatedPorts();
    expect(ports.adbServerPort).toBe(5099);
    expect(ports.emulatorConsolePort).toBe(5580);
    expect(ports.emulatorAdbBridgePort).toBe(5581);
    expect(ports.autoAllocated).toBe(false);
  });

  it('auto-probes when both env vars unset, marks autoAllocated=true', async () => {
    delete process.env.ANDROID_ADB_SERVER_PORT;
    delete process.env.ACE_MOBILE_EMULATOR_PORT;
    const backend = new AvdBackend({ rawShell: true });
    const ports = await backend.getAllocatedPorts();
    expect(ports.adbServerPort).toBeGreaterThanOrEqual(5037);
    expect(ports.emulatorConsolePort).toBeGreaterThanOrEqual(5554);
    expect(ports.emulatorConsolePort % 2).toBe(0);
    expect(ports.emulatorAdbBridgePort).toBe(ports.emulatorConsolePort + 1);
    expect(ports.autoAllocated).toBe(true);
  });

  it('caches allocation across calls (same backend = same ports)', async () => {
    delete process.env.ANDROID_ADB_SERVER_PORT;
    delete process.env.ACE_MOBILE_EMULATOR_PORT;
    const backend = new AvdBackend({ rawShell: true });
    const a = await backend.getAllocatedPorts();
    const b = await backend.getAllocatedPorts();
    expect(b).toEqual(a);
  });
});

describe('AvdBackend.adbPortFromSerial', () => {
  it('derives the adbd port for a standard emulator serial', () => {
    expect(AvdBackend.adbPortFromSerial('emulator-5554')).toBe(5555);
    expect(AvdBackend.adbPortFromSerial('emulator-5558')).toBe(5559);
  });

  it('returns null for non-emulator serials', () => {
    expect(AvdBackend.adbPortFromSerial('127.0.0.1:5555')).toBeNull();
    expect(AvdBackend.adbPortFromSerial('R5CMA0BARRP')).toBeNull();
    expect(AvdBackend.adbPortFromSerial('')).toBeNull();
  });
});

describe('AvdBackend.disableHeadsUpNotifications', () => {
  it('runs `settings put global heads_up_notifications_enabled 0` against the matching device', async () => {
    const calls: string[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      const scripted: Record<string, { stdout: string; code?: number }> = {
        'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
        'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
        'adb -s emulator-5554 shell settings put global heads_up_notifications_enabled 0': {
          stdout: '',
        },
        'adb -s emulator-5554 shell cmd notification disallow_dnd com.google.android.gms': {
          stdout: '',
        },
      };
      const r = scripted[key];
      if (!r) throw new Error(`Unscripted shell call: ${key}`);
      return { stdout: r.stdout, stderr: '', exitCode: r.code ?? 0 };
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.disableHeadsUpNotifications('ACE_Pixel_API_34')).resolves.toBeUndefined();
    expect(calls).toContain(
      'adb -s emulator-5554 shell settings put global heads_up_notifications_enabled 0',
    );
    expect(calls).toContain(
      'adb -s emulator-5554 shell cmd notification disallow_dnd com.google.android.gms',
    );
  });

  it('swallows shell failures (best-effort; never gates bootstrap)', async () => {
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key === 'adb devices') {
        return { stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb -s emulator-5554 emu avd name') {
        return { stdout: 'ACE_Pixel_API_34\nOK\n', stderr: '', exitCode: 0 };
      }
      throw new Error(`adb hiccup: ${key}`);
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.disableHeadsUpNotifications('ACE_Pixel_API_34')).resolves.toBeUndefined();
  });
});

describe('AvdBackend.setGmsEnabled', () => {
  it('runs `pm enable` against the matching device when enabled=true', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 shell pm enable com.google.android.gms': {
        stdout: 'Package com.google.android.gms new state: enabled\n',
      },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.setGmsEnabled('ACE_Pixel_API_34', true)).resolves.toBeUndefined();
  });

  it('runs `pm disable-user --user 0` when enabled=false', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 shell pm disable-user --user 0 com.google.android.gms': {
        stdout: 'Package com.google.android.gms new state: disabled-user\n',
      },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.setGmsEnabled('ACE_Pixel_API_34', false)).resolves.toBeUndefined();
  });

  it('is a no-op when the AVD is not running', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\n' },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.setGmsEnabled('ACE_Pixel_API_34', true)).resolves.toBeUndefined();
  });
});

describe('AvdBackend.applyEnvironmentBaseline', () => {
  it('applies all three baseline settings and returns a stable fingerprint', async () => {
    const calls: string[] = [];
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      const scripted: Record<string, { stdout: string }> = {
        'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
        'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
        'adb -s emulator-5554 shell settings put global heads_up_notifications_enabled 0': { stdout: '' },
        'adb -s emulator-5554 shell cmd notification disallow_dnd com.google.android.gms': { stdout: '' },
        'adb -s emulator-5554 shell settings put system screen_off_timeout 1800000': { stdout: '' },
      };
      const r = scripted[key];
      if (!r) throw new Error(`Unscripted shell call: ${key}`);
      return { stdout: r.stdout, stderr: '', exitCode: 0 };
    });
    const backend = new AvdBackend({ shell });
    const fingerprint = await backend.applyEnvironmentBaseline('ACE_Pixel_API_34');

    // All three settings applied.
    expect(calls).toContain(
      'adb -s emulator-5554 shell settings put global heads_up_notifications_enabled 0',
    );
    expect(calls).toContain(
      'adb -s emulator-5554 shell cmd notification disallow_dnd com.google.android.gms',
    );
    expect(calls).toContain(
      'adb -s emulator-5554 shell settings put system screen_off_timeout 1800000',
    );

    // Fingerprint is a stable, non-empty short hex string. Re-running
    // produces the same fingerprint (baseline didn't change).
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const second = await backend.applyEnvironmentBaseline('ACE_Pixel_API_34');
    expect(second).toBe(fingerprint);
  });

  it('still returns the fingerprint even when individual adb writes fail (best-effort)', async () => {
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key === 'adb devices') {
        return { stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '', exitCode: 0 };
      }
      if (key === 'adb -s emulator-5554 emu avd name') {
        return { stdout: 'ACE_Pixel_API_34\nOK\n', stderr: '', exitCode: 0 };
      }
      throw new Error(`adb hiccup: ${key}`);
    });
    const backend = new AvdBackend({ shell });
    const fingerprint = await backend.applyEnvironmentBaseline('ACE_Pixel_API_34');
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });
});
