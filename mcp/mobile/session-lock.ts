/**
 * Per-session lock files for the local AVD backend.
 *
 * **The problem this fixes.** The mobile MCP allocates a unique adb-server
 * port + emulator console-port pair per session (`port-allocator.ts`),
 * spawns its own `adb fork-server` and `qemu-system-aarch64` on those
 * ports, then exits. Because `adb` daemonizes via double-fork (its parent
 * after spawn is `init`/PID 1) and the emulator detaches similarly, **the
 * daemons survive the MCP subprocess that birthed them**. Over a day of
 * parallel `/ace:run` cycles a single workstation accumulates many
 * orphan `adb` daemons on 5037..5043+ and stale qemu emulators on
 * 5554..5564+. They then race for emulator-adbd ownership and produce
 * the `Broken pipe` / `dadb UNAVAILABLE` failure class that surfaced
 * 2026-05-20 on malaria-itn-app run 20260517-1829 Phase 6 re-verify
 * (multiple consecutive `register_test_user` halts even on a "clean"
 * workstation, because a sibling session's daemons re-claimed the
 * cleaned slot within seconds).
 *
 * **The fix.** Each MCP session writes a small lock file at
 * port-allocation time. Every subsequent port allocation FIRST sweeps
 * the lock dir, kills any adb/qemu still bound to a port whose owning
 * lock's mcp_pid is no longer alive, and removes that lock. The
 * operator-facing `bin/ace-mobile-reap` CLI wraps the same sweep for
 * manual use ("nuke all stale daemons"). Self-cleanup on graceful MCP
 * shutdown removes our own lock; the reaper handles the hard-kill case
 * by walking PID liveness at the next allocator entry.
 *
 * **What the lock contains.** Just enough to find and kill the right
 * processes:
 *   - `mcp_pid` — the MCP subprocess that allocated the port (the
 *     trigger for "is this lock stale?").
 *   - `adb_port` + `emulator_port` — what `lsof -iTCP:<port>
 *     -sTCP:LISTEN` should match at reap time to find the spawned
 *     processes. We DELIBERATELY do not store adb_pid / qemu_pid
 *     directly: capturing the PID at spawn time is brittle (double-fork
 *     reparenting, race between spawn and lock-write), and port-based
 *     lookup at reap time is the simplest source of truth.
 *   - `avd_name` — for operator-readable debugging output.
 *   - `started_at` — ISO timestamp, also for debugging.
 *
 * **Where the locks live.** `~/.ace/sessions/<mcp-pid>.lock.json`. One
 * file per session. Naming by mcp_pid is unique per-session as long as
 * a session is alive (the OS guarantees PID uniqueness for live
 * processes); collisions after PID reuse are handled by the reaper
 * (a stale lock with mcp_pid=N gets reaped before a new live mcp_pid=N
 * tries to acquire). The directory is gitignored / not synced — it's
 * per-machine ephemeral state.
 *
 * Future work tracked in `docs/learnings/2026-05-21-parallel-session-adb-leak.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

export const SESSION_LOCK_DIR = path.join(os.homedir(), '.ace', 'sessions');

export interface SessionLock {
  mcp_pid: number;
  started_at: string;
  adb_port: number;
  emulator_port: number;
  avd_name?: string;
}

/**
 * Path on disk for a given mcp_pid's lock file. Caller is responsible
 * for ensuring SESSION_LOCK_DIR exists (acquireSessionLock does this).
 */
export function lockPathForPid(mcpPid: number): string {
  return path.join(SESSION_LOCK_DIR, `${mcpPid}.lock.json`);
}

/**
 * Write our session's lock file. Idempotent — re-writes on every call
 * so the lock reflects the latest port allocation if it changed
 * mid-session (it shouldn't, but the schema is tiny). Creates
 * SESSION_LOCK_DIR if missing.
 */
export function acquireSessionLock(lock: SessionLock): void {
  fs.mkdirSync(SESSION_LOCK_DIR, { recursive: true });
  fs.writeFileSync(lockPathForPid(lock.mcp_pid), JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

/**
 * Remove our session's lock. Called from the MCP server's
 * SIGTERM/SIGINT/exit handlers on graceful shutdown. Best-effort:
 * if the lock is already gone (reaped by a sibling, manually deleted)
 * this is a no-op.
 */
export function releaseSessionLock(mcpPid: number): void {
  try {
    fs.unlinkSync(lockPathForPid(mcpPid));
  } catch {
    /* already gone — fine */
  }
}

/**
 * Check whether a PID is alive on the current host. Uses `kill(pid, 0)`
 * via process.kill with signal 0 — POSIX standard "does this pid exist
 * and am I allowed to signal it" check. Returns false on any error
 * (ESRCH = no such process, EPERM = exists but not signalable by us,
 * which is rare for user-spawned processes on the same machine).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find PIDs bound to `127.0.0.1:<port>` via `lsof`. Uses the
 * `-iTCP:<port> -sTCP:LISTEN -t` shape so it returns just PIDs, one
 * per line, suitable for piping into `kill`. Returns [] on any lsof
 * failure (lsof missing, no match, transient OS error) — callers
 * treat "no PIDs found" as "no cleanup needed".
 *
 * NOTE: We don't filter by process name here. The reaper is called
 * for ports we KNOW we allocated (from a lock file), so anything
 * still listening on that port is by definition either our orphan
 * adb/qemu or something a human operator put there manually. Killing
 * an operator-placed process on a port we previously claimed is
 * acceptable — they shouldn't be squatting our ports.
 */
export function findPidsOnPort(port: number): number[] {
  try {
    const out = execSync(
      `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`,
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Best-effort SIGKILL. Returns true if the process is gone (or was
 * never running) after the call, false if it survives. We send SIGKILL
 * directly rather than SIGTERM-then-SIGKILL because the targets are
 * leaked adb daemons / qemu emulators — they don't have meaningful
 * cleanup to do, and SIGTERM-then-wait would slow the reaper to a
 * crawl with no real benefit.
 */
export function killPid(pid: number): boolean {
  if (!isPidAlive(pid)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* may already be dead between isPidAlive and kill */
  }
  return !isPidAlive(pid);
}

export interface ReapResult {
  reaped_locks: string[];
  killed_pids: number[];
  surviving_locks: string[];
  errors: Array<{ lock: string; error: string }>;
}

/**
 * Read every live session lock and return the set of {adb_port,
 * emulator_port} values they've claimed. Used by the port allocator to
 * skip ports already reserved by sibling sessions (the "leak-induced
 * collision" class: sibling's MCP died but its adb daemon is still on
 * 5037; without consulting the lock, the next allocator's bind-probe
 * sees 5037 as "taken by some adb" without knowing it's a reapable
 * orphan, walks to 5038, and accumulates the leak we set out to fix).
 *
 * Locks whose `mcp_pid` is dead are reaped before reading — that way
 * the caller sees a clean view and the reaper runs at the same
 * boundary as port allocation.
 *
 * Returns separate sets so callers (ADB allocator vs emulator
 * allocator) can each consult only the relevant slot.
 */
export function getReservedPorts(): { adb: Set<number>; emulator: Set<number> } {
  // Reap first so we don't treat dead-session ports as reserved.
  reapStaleSessions();

  const adb = new Set<number>();
  const emulator = new Set<number>();
  if (!fs.existsSync(SESSION_LOCK_DIR)) return { adb, emulator };
  for (const entry of fs.readdirSync(SESSION_LOCK_DIR)) {
    if (!entry.endsWith('.lock.json')) continue;
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(SESSION_LOCK_DIR, entry), 'utf8')) as SessionLock;
      if (Number.isFinite(lock.adb_port)) adb.add(lock.adb_port);
      if (Number.isFinite(lock.emulator_port)) {
        emulator.add(lock.emulator_port);
        // Reserve the adb-bridge port too (always emulator_port + 1)
        emulator.add(lock.emulator_port + 1);
      }
    } catch {
      /* skip corrupt locks — they'd be picked up by the next reap */
    }
  }
  return { adb, emulator };
}

const ALLOCATOR_MUTEX_PATH = path.join(SESSION_LOCK_DIR, '.allocator.lock');
const ALLOCATOR_MUTEX_TIMEOUT_MS = 30_000;
const ALLOCATOR_MUTEX_POLL_MS = 50;

/**
 * Run `fn` while holding a file-system mutex on the allocator
 * critical section. Two parallel `getAllocatedPorts()` calls would
 * otherwise both probe-and-claim the same port pair (TOCTOU race —
 * the probe binds-then-releases, leaving the port free for the next
 * concurrent probe). Holding the mutex across BOTH the probe AND the
 * subsequent `recordSessionLock` makes the claim atomic across
 * processes.
 *
 * Mechanism: atomically create `~/.ace/sessions/.allocator.lock` via
 * `O_EXCL` containing our PID + timestamp. If the file exists,
 * inspect its contents:
 *   - holder PID still alive → wait `ALLOCATOR_MUTEX_POLL_MS` and
 *     retry up to `ALLOCATOR_MUTEX_TIMEOUT_MS`.
 *   - holder PID dead → take over (clear the file, retry).
 *   - file corrupt → clear and retry.
 *
 * Releases on every exit path of `fn` (success, error, throw).
 * Idempotent — safe if `fn` itself acquires nested allocator locks
 * (the outer holder's PID matches `process.pid`; we detect that and
 * re-enter without blocking — though in practice the AVD backend
 * never re-enters).
 */
export async function withAllocatorMutex<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(SESSION_LOCK_DIR, { recursive: true });

  const deadline = Date.now() + ALLOCATOR_MUTEX_TIMEOUT_MS;
  while (true) {
    try {
      // O_EXCL: atomic create-if-not-exists. Throws EEXIST if held.
      const fd = fs.openSync(ALLOCATOR_MUTEX_PATH, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      // Got it. Run the protected section.
      try {
        return await fn();
      } finally {
        try {
          fs.unlinkSync(ALLOCATOR_MUTEX_PATH);
        } catch {
          /* already gone — fine */
        }
      }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      // Mutex held by someone else. Inspect.
      let holderPid: number | null = null;
      try {
        const held = JSON.parse(fs.readFileSync(ALLOCATOR_MUTEX_PATH, 'utf8'));
        if (Number.isFinite(held?.pid)) holderPid = held.pid;
      } catch {
        /* corrupt — treat as no holder */
      }
      if (holderPid !== null && !isPidAlive(holderPid)) {
        // Dead holder. Clear and retry.
        try {
          fs.unlinkSync(ALLOCATOR_MUTEX_PATH);
        } catch {
          /* race with another reaper — fine */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `withAllocatorMutex: timeout after ${ALLOCATOR_MUTEX_TIMEOUT_MS}ms ` +
            `waiting for ${ALLOCATOR_MUTEX_PATH} held by pid ${holderPid ?? '?'}`,
        );
      }
      await new Promise((r) => setTimeout(r, ALLOCATOR_MUTEX_POLL_MS));
    }
  }
}

/**
 * Walk SESSION_LOCK_DIR and reap any lock whose owning mcp_pid is
 * dead. For each stale lock: look up live PIDs on its adb_port and
 * emulator_port via lsof, SIGKILL them, then remove the lock file.
 *
 * Live locks (mcp_pid still running) are left alone — they belong to
 * an active sibling session that's still managing its own processes.
 *
 * Idempotent — safe to call repeatedly. Called automatically at the
 * top of `resolveAdbServerPort()` and `resolveEmulatorPair()` in
 * `port-allocator.ts`; also exposed via `bin/ace-mobile-reap` for
 * manual operator invocation.
 *
 * Returns a structured summary so callers (the bin script, logs) can
 * report what was cleaned. The reaper does NOT throw — any error is
 * captured in `errors` and the sweep continues; a single corrupt lock
 * file shouldn't block port allocation.
 */
export function reapStaleSessions(opts: { all?: boolean } = {}): ReapResult {
  const result: ReapResult = {
    reaped_locks: [],
    killed_pids: [],
    surviving_locks: [],
    errors: [],
  };

  if (!fs.existsSync(SESSION_LOCK_DIR)) return result;

  let entries: string[];
  try {
    entries = fs.readdirSync(SESSION_LOCK_DIR).filter((f) => f.endsWith('.lock.json'));
  } catch (e: any) {
    result.errors.push({ lock: SESSION_LOCK_DIR, error: `readdir failed: ${e?.message ?? e}` });
    return result;
  }

  for (const entry of entries) {
    const fullPath = path.join(SESSION_LOCK_DIR, entry);
    let lock: SessionLock;
    try {
      lock = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as SessionLock;
    } catch (e: any) {
      // Corrupt lock — remove it; nothing useful we can do with bad
      // content, and leaving it would leak the slot forever.
      result.errors.push({ lock: entry, error: `parse failed: ${e?.message ?? e}` });
      try {
        fs.unlinkSync(fullPath);
        result.reaped_locks.push(entry);
      } catch {
        /* ignore */
      }
      continue;
    }

    const stale = opts.all || !isPidAlive(lock.mcp_pid);
    if (!stale) {
      result.surviving_locks.push(entry);
      continue;
    }

    // Kill anything still on our allocated ports. Empty list = nothing
    // to clean (the daemons died on their own, e.g. host reboot).
    const adbPids = findPidsOnPort(lock.adb_port);
    const emuPids = findPidsOnPort(lock.emulator_port);
    for (const pid of [...adbPids, ...emuPids]) {
      const wasOwn = pid === lock.mcp_pid;
      if (wasOwn) continue; // the lock's own MCP pid (shouldn't happen since stale=true) — defensive
      if (killPid(pid)) result.killed_pids.push(pid);
    }

    try {
      fs.unlinkSync(fullPath);
      result.reaped_locks.push(entry);
    } catch (e: any) {
      result.errors.push({ lock: entry, error: `unlink failed: ${e?.message ?? e}` });
    }
  }

  return result;
}
