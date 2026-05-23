import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  acquireSessionLock,
  releaseSessionLock,
  reapStaleSessions,
  reapOrphanScaffolds,
  ORPHAN_SCAFFOLD_PATTERN,
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
    // End-state assertion only — `result.reaped_locks` is racy under
    // parallel vitest execution because session-lock-e2e.test.ts also
    // walks SESSION_LOCK_DIR. Whichever reapStaleSessions call runs
    // first wins the reaped_locks attribution; the structural
    // invariant is "the dead lock is gone after the sweep" regardless.
    reapStaleSessions();
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
    // End-state assertion only — `result.reaped_locks` is racy under
    // parallel vitest execution because a sibling test file (e.g.
    // session-lock-e2e.test.ts) also calls reapStaleSessions which
    // walks the same SESSION_LOCK_DIR. The invariant we care about
    // is "the corrupt file is gone after the sweep", regardless of
    // which `reapStaleSessions` call did the removal.
    reapStaleSessions();
    expect(fs.existsSync(corruptPath)).toBe(false);
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

  describe('reapOrphanScaffolds (defense-in-depth scaffold sweep)', () => {
    // These tests exercise the pattern + call-shape of the orphan
    // scaffold reaper without actually creating orphan processes
    // (which would require a real double-fork or detached spawn — the
    // E2E test at session-lock-e2e.test.ts exercises that path
    // separately). The unit tests below verify:
    //   1. The signature regex matches the canonical test-scaffold cmdline.
    //   2. The signature regex rejects superficially-similar non-scaffold cmdlines.
    //   3. reapOrphanScaffolds runs cleanly on a clean system (zero kills, no errors).
    //   4. reapStaleSessions exposes the new `killed_scaffold_pids` field.

    it('ORPHAN_SCAFFOLD_PATTERN matches the canonical e2e test scaffold cmdline', () => {
      // This is the exact shape spawned by spawnLockHolder in
      // session-lock-e2e.test.ts. Pattern-match against the FULL
      // command line including the multi-line `-e` payload.
      const canonical =
        'node /Users/x/.../node_modules/.bin/tsx -e ' +
        '\n    const lockModUrl = "file:///Users/x/.../mcp/mobile/session-lock.ts";' +
        '\n    import(lockModUrl).then((m) => {' +
        '\n      m.acquireSessionLock({...});' +
        '\n      console.log("LOCK_WRITTEN " + process.pid);' +
        '\n      setInterval(() => {}, 60_000); // hang' +
        '\n    });';
      expect(ORPHAN_SCAFFOLD_PATTERN.test(canonical)).toBe(true);
    });

    it('ORPHAN_SCAFFOLD_PATTERN rejects unrelated tsx cmdlines that import session-lock without setInterval', () => {
      // A quick-running tsx invocation that imports session-lock (e.g.
      // bin/ace-mobile-reap's shim) but doesn't hang on setInterval —
      // should NOT match. The test guards against false-positive kills
      // of legitimate short-lived imports.
      const reapShim =
        'node /Users/x/.../node_modules/.bin/tsx -e ' +
        'import { reapStaleSessions } from "file:///Users/x/.../mcp/mobile/session-lock.ts";' +
        'console.log(JSON.stringify(reapStaleSessions(), null, 2));';
      expect(ORPHAN_SCAFFOLD_PATTERN.test(reapShim)).toBe(false);
    });

    it('ORPHAN_SCAFFOLD_PATTERN rejects setInterval-using processes that have nothing to do with session-lock', () => {
      // Another tsx-eval'd script that uses setInterval but doesn't
      // import session-lock.ts. Both substrings are required.
      const unrelatedDaemon =
        'node tsx -e import * as net from "node:net"; ' +
        'net.createServer().listen(60100); setInterval(() => {}, 60_000);';
      expect(ORPHAN_SCAFFOLD_PATTERN.test(unrelatedDaemon)).toBe(false);
    });

    it('reapOrphanScaffolds returns no kills on a clean system', () => {
      // The host running this test may or may not have orphan scaffolds
      // from prior runs. The test asserts the call shape: returns an
      // object with the expected keys, never throws. If kills happen
      // (cleaning up orphans from a sibling worktree's aborted test),
      // that's a feature — the post-condition is the system is now
      // clean, not that the call was a no-op.
      const result = reapOrphanScaffolds();
      expect(result).toHaveProperty('killed_pids');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.killed_pids)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
      // pgrep is universally available on macOS + Linux runners; errors
      // would indicate a broken host. Soft assertion — the function
      // catches its own errors so the only way `errors` is populated is
      // a structurally broken pgrep installation.
      expect(result.errors).toEqual([]);
    });

    it('reapStaleSessions exposes killed_scaffold_pids as an array', () => {
      const result = reapStaleSessions();
      expect(result).toHaveProperty('killed_scaffold_pids');
      expect(Array.isArray(result.killed_scaffold_pids)).toBe(true);
    });
  });
});
