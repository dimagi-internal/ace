/**
 * End-to-end test of the parallel-session lock + reap protocol.
 *
 * Unlike `session-lock.test.ts` (in-process unit tests with fake PIDs),
 * this file spawns REAL Node subprocesses, each of which imports
 * `session-lock.ts` and acquires its own lock. We then exercise the
 * scenarios that actually bit us in production on the malaria-itn-app
 * run 20260517-1829 Phase 6 reverify:
 *
 *   1. Two MCP-like processes acquire concurrent locks, both succeed,
 *      filenames don't collide (PID-based naming guarantees uniqueness).
 *   2. SIGKILL one of them (bypasses the signal handler — the worst-case
 *      cleanup path) and verify the lock survives the kill (because no
 *      handler ran).
 *   3. Run the reaper from a third process; verify the dead one's lock
 *      is removed and the alive one's lock is preserved.
 *
 * Why this matters: this is exactly the flow that protects parallel
 * `/ace:run` sessions from leaking adb daemons across each other. The
 * unit tests prove the mechanism with mocked PIDs; this test proves
 * the mechanism survives real OS-level process death and PID liveness
 * probing.
 *
 * Subprocesses use the `npx tsx -e` inline shim so we don't need a
 * separate fixture .ts file. The inline code does ONE thing: write a
 * lock under our pid, print `LOCK_WRITTEN <pid>` to stdout so the test
 * driver knows when to proceed, then hang on a long interval until
 * killed. The test driver always kills its subprocesses in `finally`
 * blocks so this is robust against test failures.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  lockPathForPid,
  reapStaleSessions,
  SESSION_LOCK_DIR,
  isPidAlive,
} from '../../../mcp/mobile/session-lock.js';

const SESSION_LOCK_TS = path.resolve(__dirname, '../../../mcp/mobile/session-lock.ts');

// Test ports far above the real-world range so we never collide with
// a live adb/qemu allocation if this test runs while a normal session
// is open. The ports are RECORDED in the lock but never bound — we're
// testing the lock+reap protocol, not actual daemon spawning.
const TEST_ADB_PORT_A = 60037;
const TEST_EMU_PORT_A = 60554;
const TEST_ADB_PORT_B = 60038;
const TEST_EMU_PORT_B = 60556;

type LockHolder = {
  pid: number;
  // `stdio: ['ignore', 'pipe', 'pipe']` gives stdin=null, hence the
  // null in the ChildProcessByStdio first slot. The lock-holder
  // subprocess doesn't read stdin — it just acquires the lock and
  // hangs on an interval.
  proc: ChildProcessByStdio<null, Readable, Readable>;
};

/**
 * Spawn a Node subprocess that imports session-lock.ts, writes a lock
 * recording the given ports under its own pid, prints `LOCK_WRITTEN
 * <pid>`, then hangs forever (until the test driver kills it).
 *
 * Resolves once `LOCK_WRITTEN <pid>` is printed; rejects on early exit
 * or timeout.
 */
function spawnLockHolder(adbPort: number, emuPort: number, timeoutMs = 15_000): Promise<LockHolder> {
  const code = `
    const lockModUrl = ${JSON.stringify('file://' + SESSION_LOCK_TS)};
    import(lockModUrl).then((m) => {
      m.acquireSessionLock({
        mcp_pid: process.pid,
        started_at: new Date().toISOString(),
        adb_port: ${adbPort},
        emulator_port: ${emuPort},
        avd_name: 'test-e2e-' + process.pid,
      });
      console.log('LOCK_WRITTEN ' + process.pid);
      setInterval(() => {}, 60_000); // hang
    }).catch((e) => {
      console.error('IMPORT_ERROR ' + (e && e.message || e));
      process.exit(1);
    });
  `;
  const child = spawn('npx', ['--yes', 'tsx', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  return new Promise<LockHolder>((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`spawnLockHolder: timed out after ${timeoutMs}ms waiting for LOCK_WRITTEN`));
    }, timeoutMs);

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += String(chunk);
      const m = stdoutBuf.match(/LOCK_WRITTEN (\d+)/);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ pid: Number.parseInt(m[1], 10), proc: child });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += String(chunk);
    });
    child.on('exit', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(new Error(`subprocess exited early (code=${code}, signal=${signal}). stdout=${stdoutBuf} stderr=${stderrBuf}`));
    });
  });
}

/**
 * Best-effort cleanup: kill a lock holder + unlink its lock. Idempotent
 * — safe to call on an already-dead holder.
 */
function teardownLockHolder(holder: LockHolder | null): void {
  if (!holder) return;
  // Kill BOTH the inner Node (by pid) and the npx wrapper (via the
  // ChildProcess handle). Either alone may leave the other lingering.
  try {
    if (isPidAlive(holder.pid)) process.kill(holder.pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    holder.proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPathForPid(holder.pid));
  } catch {
    /* ignore */
  }
}

describe('session-lock E2E (multi-process parallel-session protocol)', () => {
  let a: LockHolder | null = null;
  let b: LockHolder | null = null;

  beforeEach(() => {
    a = null;
    b = null;
  });

  afterEach(() => {
    teardownLockHolder(a);
    teardownLockHolder(b);
  });

  it('two concurrent subprocesses both acquire distinct locks', async () => {
    a = await spawnLockHolder(TEST_ADB_PORT_A, TEST_EMU_PORT_A);
    b = await spawnLockHolder(TEST_ADB_PORT_B, TEST_EMU_PORT_B);

    // Both PIDs are distinct (OS guarantee for live processes).
    expect(a.pid).not.toBe(b.pid);

    // Both lock files exist.
    expect(fs.existsSync(lockPathForPid(a.pid))).toBe(true);
    expect(fs.existsSync(lockPathForPid(b.pid))).toBe(true);

    // The lock contents match what the subprocess wrote.
    const lockA = JSON.parse(fs.readFileSync(lockPathForPid(a.pid), 'utf8'));
    const lockB = JSON.parse(fs.readFileSync(lockPathForPid(b.pid), 'utf8'));
    expect(lockA.adb_port).toBe(TEST_ADB_PORT_A);
    expect(lockA.emulator_port).toBe(TEST_EMU_PORT_A);
    expect(lockB.adb_port).toBe(TEST_ADB_PORT_B);
    expect(lockB.emulator_port).toBe(TEST_EMU_PORT_B);

    // Both subprocesses are alive per PID-liveness probing.
    expect(isPidAlive(a.pid)).toBe(true);
    expect(isPidAlive(b.pid)).toBe(true);
  });

  it('SIGKILL bypasses signal handlers — lock SURVIVES the kill', async () => {
    a = await spawnLockHolder(TEST_ADB_PORT_A, TEST_EMU_PORT_A);

    expect(fs.existsSync(lockPathForPid(a.pid))).toBe(true);
    expect(isPidAlive(a.pid)).toBe(true);

    // Kill BY PID, not via the ChildProcess handle. The `proc` handle
    // wraps the `npx` wrapper, not the inner Node process whose `pid`
    // we recorded — killing `proc` would leave the inner Node alive.
    // (This is exactly the pattern adb/qemu use: double-fork to escape
    // the parent's lineage — except here we just have one wrapper
    // layer.) `process.kill` with the printed PID hits the real owner.
    process.kill(a.pid, 'SIGKILL');
    // Poll until the PID actually drops off; the OS reap can take ~50ms
    // on macOS after SIGKILL.
    for (let i = 0; i < 50; i++) {
      if (!isPidAlive(a.pid)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isPidAlive(a.pid)).toBe(false);

    // SIGKILL bypassed our SIGTERM handler, so the lock is still there.
    // This is exactly the leak class the reaper is designed for —
    // a dead session whose lock file outlived it.
    expect(fs.existsSync(lockPathForPid(a.pid))).toBe(true);
  });

  it('reaper sweeps the SIGKILLed lock; live sibling lock is preserved', async () => {
    a = await spawnLockHolder(TEST_ADB_PORT_A, TEST_EMU_PORT_A);
    b = await spawnLockHolder(TEST_ADB_PORT_B, TEST_EMU_PORT_B);

    // Both locks present, both alive.
    expect(fs.existsSync(lockPathForPid(a.pid))).toBe(true);
    expect(fs.existsSync(lockPathForPid(b.pid))).toBe(true);

    // Kill A only — by PID (see comment in the SIGKILL test above).
    process.kill(a.pid, 'SIGKILL');
    for (let i = 0; i < 50; i++) {
      if (!isPidAlive(a.pid)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isPidAlive(a.pid)).toBe(false);
    expect(isPidAlive(b.pid)).toBe(true);

    // Sweep. A is dead → reaped. B is alive → surviving.
    const result = reapStaleSessions();
    expect(result.reaped_locks).toContain(`${a.pid}.lock.json`);
    expect(result.surviving_locks).toContain(`${b.pid}.lock.json`);
    expect(fs.existsSync(lockPathForPid(a.pid))).toBe(false);
    expect(fs.existsSync(lockPathForPid(b.pid))).toBe(true);
  });

  it('reaper with --all (all:true) removes EVERY lock including the alive sibling', async () => {
    a = await spawnLockHolder(TEST_ADB_PORT_A, TEST_EMU_PORT_A);
    b = await spawnLockHolder(TEST_ADB_PORT_B, TEST_EMU_PORT_B);

    expect(fs.existsSync(lockPathForPid(a.pid))).toBe(true);
    expect(fs.existsSync(lockPathForPid(b.pid))).toBe(true);

    // Nuclear reap — should clear both regardless of liveness.
    const result = reapStaleSessions({ all: true });
    expect(result.reaped_locks).toContain(`${a.pid}.lock.json`);
    expect(result.reaped_locks).toContain(`${b.pid}.lock.json`);
    expect(fs.existsSync(lockPathForPid(a.pid))).toBe(false);
    expect(fs.existsSync(lockPathForPid(b.pid))).toBe(false);
    // Both subprocesses are still ALIVE — the reaper doesn't kill the
    // owning MCP, only the orphan adb/qemu on its ports (which we don't
    // simulate here). The lock removal is the test signal.
    expect(isPidAlive(a.pid)).toBe(true);
    expect(isPidAlive(b.pid)).toBe(true);
  });
});
