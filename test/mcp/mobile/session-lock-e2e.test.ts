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
  acquireSessionLock,
  lockPathForPid,
  reapStaleSessions,
  reapOrphanScaffolds,
  ORPHAN_SCAFFOLD_PATTERN,
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
  // `detached: true` puts the npx wrapper in its OWN process group,
  // which lets `teardownLockHolder` use `process.kill(-pid, 'SIGKILL')`
  // to nuke the whole subprocess tree (npx wrapper + tsx loader child
  // + node --eval grandchild) in one signal. Without this, a SIGKILL of
  // the wrapper leaves the loader+eval children alive and reparented to
  // init — they then hang on `setInterval` until the host is rebooted.
  // Discovered live on malaria-rdt run 20260522-1002 Phase 6 attempt 2:
  // a sibling `avd-yt6cu` worktree's aborted test suite left 10 such
  // orphans (5 wrapper + 5 child pairs) blocking AVD allocation.
  const child = spawn('npx', ['--yes', 'tsx', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
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
  // Process-group kill first — `spawnLockHolder` spawns with
  // `detached: true` so `holder.proc.pid` is the head of its own pgid.
  // `process.kill(-pgid, 'SIGKILL')` nukes the npx wrapper AND every
  // descendant (tsx loader child, node --eval grandchild) in one
  // signal. Falls back to per-PID kills if the group kill fails (e.g.
  // the wrapper already exited).
  try {
    if (holder.proc.pid && isPidAlive(holder.proc.pid)) {
      process.kill(-holder.proc.pid, 'SIGKILL');
    }
  } catch {
    /* fall through to per-pid kills */
  }
  // Per-pid kills as defense in depth — catches cases where the group
  // kill found no group (process not detached, or already exited).
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
    // Assertions check END STATE (lock files + B's liveness) rather
    // than this specific call's `reaped_locks` / `surviving_locks`
    // arrays — those arrays only capture what THIS call did, and a
    // parallel test file's `reapStaleSessions` (running concurrently
    // by default under vitest) can reap A's lock before this call
    // reaches it. The invariant we care about is structural: A's
    // lock is gone, B's lock is preserved, B is still alive. The
    // racy intermediate (who reaped A) doesn't matter.
    reapStaleSessions();
    expect(fs.existsSync(lockPathForPid(a.pid))).toBe(false);
    expect(fs.existsSync(lockPathForPid(b.pid))).toBe(true);
    expect(isPidAlive(b.pid)).toBe(true);
  });

  it('SIGTERM-driven cleanup kills daemons on lock ports before releasing the lock', async () => {
    // This test models the exact production scenario: a subprocess
    // (the "MCP") acquires a lock, then spawns a "daemon" subprocess
    // that survives independently (mimicking adb fork-server's
    // double-fork behavior). On SIGTERM, the MCP runs cleanupSessionDaemons
    // which looks up live PIDs on its lock's ports, SIGKILLs them,
    // then removes the lock.
    //
    // We can't test the *actual* mobile-server.ts SIGTERM handler
    // without spinning up the full MCP stdio protocol. Instead we
    // spawn a subprocess that calls cleanupSessionDaemons directly,
    // which is what the SIGTERM handler in mobile-server.ts does.
    const TEST_PORT = 60100;

    // Step 1: spawn a "daemon" — a detached subprocess that binds the
    // test port and survives independent of any parent.
    const daemonProc = spawn(
      'npx',
      [
        '--yes',
        'tsx',
        '-e',
        `
          import * as net from 'node:net';
          const server = net.createServer().listen(${TEST_PORT}, '127.0.0.1', () => {
            console.log('DAEMON_LISTENING ' + process.pid);
          });
          setInterval(() => {}, 60_000);
        `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    daemonProc.unref();
    let daemonPid = -1;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon never reported LISTENING')), 10_000);
      daemonProc.stdout?.on('data', (chunk) => {
        const m = String(chunk).match(/DAEMON_LISTENING (\d+)/);
        if (m) {
          clearTimeout(timer);
          daemonPid = Number.parseInt(m[1], 10);
          resolve();
        }
      });
    });
    expect(isPidAlive(daemonPid)).toBe(true);
    // Brief settle so lsof sees the listener — listen() resolves
    // before the kernel publishes the binding for cross-process
    // queries on some macOS versions.
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Step 2: write a lock for ourselves pointing at the daemon's port
      const FAKE_MCP_PID = process.pid; // use our pid so cleanup is self-targeted
      acquireSessionLock({
        mcp_pid: FAKE_MCP_PID,
        started_at: new Date().toISOString(),
        adb_port: TEST_PORT,
        emulator_port: TEST_PORT + 1, // unused, but lock requires it
        avd_name: 'sigterm-test',
      });
      expect(fs.existsSync(lockPathForPid(FAKE_MCP_PID))).toBe(true);

      // Step 3: invoke cleanupSessionDaemons — same code the SIGTERM
      // handler in mobile-server.ts calls.
      const { cleanupSessionDaemons } = await import('../../../mcp/mobile/session-lock.js');
      const result = cleanupSessionDaemons(FAKE_MCP_PID);

      // Step 4: verify daemon was killed
      expect(result.killed_pids).toContain(daemonPid);
      // Wait for OS reap
      for (let i = 0; i < 50; i++) {
        if (!isPidAlive(daemonPid)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(isPidAlive(daemonPid)).toBe(false);

      // Step 5: verify lock was removed
      expect(result.lock_removed).toBe(true);
      expect(fs.existsSync(lockPathForPid(FAKE_MCP_PID))).toBe(false);
    } finally {
      // Belt+braces cleanup
      try {
        if (daemonPid > 0 && isPidAlive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      try {
        daemonProc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
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
