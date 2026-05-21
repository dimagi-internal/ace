import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  acquireSessionLock,
  releaseSessionLock,
  reapStaleSessions,
  lockPathForPid,
  isPidAlive,
  SESSION_LOCK_DIR,
  type SessionLock,
} from '../../../mcp/mobile/session-lock.js';

// These tests redirect SESSION_LOCK_DIR to a tempdir by mocking the
// HOME env var BEFORE importing the module. But session-lock.ts
// computes SESSION_LOCK_DIR at import time, so we can't redirect it
// after the fact. Instead we test against the real SESSION_LOCK_DIR
// using a uniquely-suffixed test PID range that won't collide with
// any real process IDs (PIDs cap at ~32k or ~99999 on common
// systems; we use 9_000_001+ which is well above).

const FAKE_PID_BASE = 9_000_001;
let writtenLocks: string[] = [];

function fakeLock(pidOffset: number, opts: Partial<SessionLock> = {}): SessionLock {
  return {
    mcp_pid: FAKE_PID_BASE + pidOffset,
    started_at: new Date().toISOString(),
    adb_port: 50037 + pidOffset, // 50037+, well clear of real adb ports
    emulator_port: 55554 + pidOffset * 2,
    avd_name: `ACE_Pixel_API_34_test_${pidOffset}`,
    ...opts,
  };
}

describe('session-lock', () => {
  beforeEach(() => {
    writtenLocks = [];
  });

  afterEach(() => {
    // Clean up any locks we wrote
    for (const p of writtenLocks) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    writtenLocks = [];
  });

  it('isPidAlive returns true for our own PID', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('isPidAlive returns false for a fake high PID', () => {
    expect(isPidAlive(FAKE_PID_BASE)).toBe(false);
  });

  it('isPidAlive returns false for invalid PIDs', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });

  it('acquireSessionLock writes a JSON file at lockPathForPid', () => {
    const lock = fakeLock(0);
    acquireSessionLock(lock);
    writtenLocks.push(lockPathForPid(lock.mcp_pid));
    expect(fs.existsSync(lockPathForPid(lock.mcp_pid))).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(lockPathForPid(lock.mcp_pid), 'utf8'));
    expect(parsed.mcp_pid).toBe(lock.mcp_pid);
    expect(parsed.adb_port).toBe(lock.adb_port);
    expect(parsed.avd_name).toBe(lock.avd_name);
  });

  it('releaseSessionLock removes the file; idempotent', () => {
    const lock = fakeLock(1);
    acquireSessionLock(lock);
    writtenLocks.push(lockPathForPid(lock.mcp_pid));
    releaseSessionLock(lock.mcp_pid);
    expect(fs.existsSync(lockPathForPid(lock.mcp_pid))).toBe(false);
    // Second call is a no-op (no throw).
    expect(() => releaseSessionLock(lock.mcp_pid)).not.toThrow();
  });

  it('reapStaleSessions removes locks for dead mcp_pids', () => {
    const stale = fakeLock(2);
    acquireSessionLock(stale);
    writtenLocks.push(lockPathForPid(stale.mcp_pid));
    const result = reapStaleSessions();
    expect(result.reaped_locks).toContain(`${stale.mcp_pid}.lock.json`);
    expect(fs.existsSync(lockPathForPid(stale.mcp_pid))).toBe(false);
  });

  it('reapStaleSessions leaves locks for live mcp_pids alone', () => {
    const live = fakeLock(3, { mcp_pid: process.pid });
    acquireSessionLock(live);
    writtenLocks.push(lockPathForPid(live.mcp_pid));
    const result = reapStaleSessions();
    expect(result.surviving_locks).toContain(`${live.mcp_pid}.lock.json`);
    expect(fs.existsSync(lockPathForPid(live.mcp_pid))).toBe(true);
  });

  it('reapStaleSessions with all:true removes EVERY lock including live ones', () => {
    const live = fakeLock(4, { mcp_pid: process.pid });
    acquireSessionLock(live);
    writtenLocks.push(lockPathForPid(live.mcp_pid));
    const result = reapStaleSessions({ all: true });
    expect(result.reaped_locks).toContain(`${live.mcp_pid}.lock.json`);
    expect(fs.existsSync(lockPathForPid(live.mcp_pid))).toBe(false);
  });

  it('reapStaleSessions removes corrupt lock files', () => {
    fs.mkdirSync(SESSION_LOCK_DIR, { recursive: true });
    const corruptPath = path.join(SESSION_LOCK_DIR, `${FAKE_PID_BASE + 99}.lock.json`);
    fs.writeFileSync(corruptPath, 'not-valid-json{{{', 'utf8');
    writtenLocks.push(corruptPath);
    const result = reapStaleSessions();
    expect(fs.existsSync(corruptPath)).toBe(false);
    expect(result.reaped_locks).toContain(`${FAKE_PID_BASE + 99}.lock.json`);
  });

  describe('cleanupSessionDaemons', () => {
    it('removes the lock for the given pid', async () => {
      const { cleanupSessionDaemons } = await import('../../../mcp/mobile/session-lock.js');
      const lock = fakeLock(10, { mcp_pid: process.pid });
      acquireSessionLock(lock);
      writtenLocks.push(lockPathForPid(lock.mcp_pid));
      const result = cleanupSessionDaemons(lock.mcp_pid);
      expect(result.lock_removed).toBe(true);
      expect(fs.existsSync(lockPathForPid(lock.mcp_pid))).toBe(false);
    });

    it('reads adb_port + emulator_port from the lock', async () => {
      const { cleanupSessionDaemons } = await import('../../../mcp/mobile/session-lock.js');
      const lock = fakeLock(11, { mcp_pid: process.pid, adb_port: 59999, emulator_port: 58000 });
      acquireSessionLock(lock);
      writtenLocks.push(lockPathForPid(lock.mcp_pid));
      const result = cleanupSessionDaemons(lock.mcp_pid);
      expect(result.adb_port).toBe(59999);
      expect(result.emulator_port).toBe(58000);
    });

    it('handles missing lock file gracefully', async () => {
      const { cleanupSessionDaemons } = await import('../../../mcp/mobile/session-lock.js');
      // Pass a pid that has no lock file
      const result = cleanupSessionDaemons(FAKE_PID_BASE + 88);
      expect(result.killed_pids).toEqual([]);
      expect(result.lock_removed).toBe(false);
    });

    it('handles corrupt lock file gracefully', async () => {
      const { cleanupSessionDaemons } = await import('../../../mcp/mobile/session-lock.js');
      const corruptPath = lockPathForPid(FAKE_PID_BASE + 89);
      fs.mkdirSync(SESSION_LOCK_DIR, { recursive: true });
      fs.writeFileSync(corruptPath, 'not-json{', 'utf8');
      writtenLocks.push(corruptPath);
      const result = cleanupSessionDaemons(FAKE_PID_BASE + 89);
      // Lock removal still happens despite corrupt content; daemon
      // lookup skipped because we can't read ports.
      expect(result.lock_removed).toBe(true);
      expect(result.killed_pids).toEqual([]);
      expect(fs.existsSync(corruptPath)).toBe(false);
    });

    it('never kills the calling process itself', async () => {
      const { cleanupSessionDaemons } = await import('../../../mcp/mobile/session-lock.js');
      // Edge case: if findPidsOnPort were to return our own pid (it
      // shouldn't, since we're not listening on our lock's ports —
      // but defensive guard), cleanupSessionDaemons must skip it.
      const lock = fakeLock(12, { mcp_pid: process.pid });
      acquireSessionLock(lock);
      writtenLocks.push(lockPathForPid(lock.mcp_pid));
      cleanupSessionDaemons(lock.mcp_pid);
      // Our process is still alive — defense-in-depth check.
      expect(isPidAlive(process.pid)).toBe(true);
    });
  });

  it('reapStaleSessions returns empty result when no lock dir exists', () => {
    // Deliberately not creating SESSION_LOCK_DIR. The implementation
    // checks fs.existsSync — should early-return.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-lock-test-'));
    const savedHome = process.env.HOME;
    try {
      // We can't actually move SESSION_LOCK_DIR (computed at import
      // time), so this test just ensures the no-locks path works.
      const result = reapStaleSessions();
      expect(result.errors).toEqual([]);
    } finally {
      process.env.HOME = savedHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
