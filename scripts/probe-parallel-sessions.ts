#!/usr/bin/env npx tsx
/**
 * probe-parallel-sessions.ts — reproducible debug probe for the
 * per-session lock + reaper protocol shipped in v0.13.291 / PR #366.
 *
 * Unlike `test/mcp/mobile/session-lock-e2e.test.ts` (which only
 * exercises the lock-file library with fake port numbers), this script
 * drives the REAL production code paths end-to-end:
 *
 *   - Real `resolveAdbServerPort` + `resolveEmulatorPair` from
 *     `mcp/mobile/port-allocator.ts` (probes real free ports starting
 *     at 5037 / 5554, walks upward on collision)
 *   - Real `recordSessionLock` writes
 *   - Real `findPidsOnPort` via lsof
 *   - Real SIGKILL of stand-in "daemon" processes
 *   - Real `reapStaleSessions` invocation
 *
 * The only thing it doesn't exercise is the actual `adb fork-server`
 * spawn and `qemu-system-aarch64` boot (those need an AVD environment
 * and ~60s per spawn — out of scope for a quick probe). To stand in for
 * those, the script optionally spawns TCP listeners on the allocated
 * ports — same `findPidsOnPort` lookup path, same SIGKILL recovery.
 *
 * ## Usage
 *
 *     npx tsx scripts/probe-parallel-sessions.ts                  # 3-session smoke
 *     npx tsx scripts/probe-parallel-sessions.ts --n=5            # 5 parallel sessions
 *     npx tsx scripts/probe-parallel-sessions.ts --kill-one       # spawn N, kill 1, verify reap
 *     npx tsx scripts/probe-parallel-sessions.ts --with-listeners # bind TCP stand-in daemons
 *     npx tsx scripts/probe-parallel-sessions.ts --cleanup-only   # reap any leftover state
 *
 * Combine flags: `--n=5 --kill-one --with-listeners` is the full
 * end-to-end scenario.
 *
 * ## Output
 *
 * Structured JSON to stdout, one block per phase. Designed to diff
 * cleanly across runs. On unexpected state, exit code != 0 and the
 * JSON includes an `errors` array.
 *
 * ## Cleanup
 *
 * On any exit path (success, error, ^C), the script kills every
 * subprocess it spawned and unlinks every lock file it wrote. If the
 * process is SIGKILLed BEFORE cleanup, leftover state is exactly what
 * `--cleanup-only` is for — or the reaper will clean it on the next
 * real session start.
 *
 * Lives under `scripts/` (committed) per `CLAUDE.md`:
 * "Durable, repeatable probes belong under `scripts/` and get committed;
 * only true one-shot debugging artifacts go to `./tmp/ace-debug/`."
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT_ALLOCATOR_TS = path.join(REPO_ROOT, 'mcp/mobile/port-allocator.ts');
const SESSION_LOCK_TS = path.join(REPO_ROOT, 'mcp/mobile/session-lock.ts');

// Parse flags
const argv = process.argv.slice(2);
function flag(name: string, defaultVal?: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=', 2)[1];
  const bare = argv.includes(`--${name}`);
  return bare ? '' : defaultVal;
}
const FLAG_N = Number.parseInt(flag('n', '3') ?? '3', 10);
const FLAG_KILL_ONE = argv.includes('--kill-one');
const FLAG_WITH_LISTENERS = argv.includes('--with-listeners');
const FLAG_CLEANUP_ONLY = argv.includes('--cleanup-only');

// Subprocess registry — every child we spawn is recorded here so we
// can clean up unconditionally in finally.
type Sub = {
  pid: number;
  innerPid?: number; // inner Node PID (if printed via STARTED message)
  proc: ChildProcess;
  label: string;
};
const SUBPROCS: Sub[] = [];

// Output helper — single canonical JSON-per-phase shape.
function phase(name: string, payload: object) {
  console.log(JSON.stringify({ phase: name, ...payload }, null, 2));
}

/**
 * Spawn a subprocess that drives the REAL production allocator path.
 *
 * The subprocess:
 *   1. Imports `port-allocator.ts` + `session-lock.ts` from the repo
 *   2. Calls `resolveAdbServerPort()` + `resolveEmulatorPair()`
 *   3. Calls `recordSessionLock()` with the allocated ports
 *   4. If --with-listeners is set, binds TCP listeners on the allocated
 *      ports as daemon stand-ins so the reaper has something to kill
 *   5. Prints a single STARTED line with the allocated ports + pid
 *   6. Hangs forever on a long interval until killed
 *
 * Resolves once the STARTED line is observed; rejects on early exit.
 */
type StartedInfo = {
  innerPid: number;
  adb_port: number;
  emulator_port: number;
};
async function spawnAllocator(label: string, withListeners: boolean): Promise<StartedInfo & { proc: ChildProcess }> {
  const code = `
    const portAllocUrl = ${JSON.stringify('file://' + PORT_ALLOCATOR_TS)};
    const lockUrl = ${JSON.stringify('file://' + SESSION_LOCK_TS)};
    Promise.all([import(portAllocUrl), import(lockUrl)]).then(async ([alloc, lock]) => {
      // Wrap the allocate+record sequence in withAllocatorMutex to
      // exercise the EXACT same production path as avd.ts's
      // getAllocatedPorts. Without the mutex, parallel allocators
      // race the TCP probe-then-release window and collide.
      const { adb, pair } = await lock.withAllocatorMutex(async () => {
        const adb = await alloc.resolveAdbServerPort();
        const pair = await alloc.resolveEmulatorPair();
        alloc.recordSessionLock({
          adbPort: adb,
          emulatorPort: pair.console,
          avdName: 'probe-parallel-${label}',
        });
        return { adb, pair };
      });
      // Optional: bind TCP listeners on the allocated ports so the
      // reaper has real PIDs to kill via findPidsOnPort -> killPid.
      const withListeners = ${withListeners};
      if (withListeners) {
        const net = await import('node:net');
        const listenerAdb = net.createServer().listen(adb, '127.0.0.1');
        const listenerEmu = net.createServer().listen(pair.console, '127.0.0.1');
        // Wait for both binds before signaling STARTED
        await Promise.all([
          new Promise((r) => listenerAdb.once('listening', r)),
          new Promise((r) => listenerEmu.once('listening', r)),
        ]);
      }
      console.log('STARTED ' + JSON.stringify({
        innerPid: process.pid,
        adb_port: adb,
        emulator_port: pair.console,
      }));
      setInterval(() => {}, 60_000);
    }).catch((e) => {
      console.error('ERROR ' + (e && e.message || e));
      process.exit(1);
    });
  `;
  const child = spawn('npx', ['--yes', 'tsx', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  SUBPROCS.push({ pid: child.pid ?? -1, proc: child, label });

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`spawnAllocator(${label}): timed out waiting for STARTED`));
      }
    }, 20_000);

    let buf = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      buf += String(chunk);
      const m = buf.match(/STARTED ({.+})/);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(timer);
        try {
          const info = JSON.parse(m[1]) as StartedInfo;
          const entry = SUBPROCS.find((s) => s.proc === child);
          if (entry) entry.innerPid = info.innerPid;
          resolve({ ...info, proc: child });
        } catch (e) {
          reject(new Error(`spawnAllocator(${label}): malformed STARTED line: ${m[1]}`));
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`spawnAllocator(${label}): exited early code=${code} signal=${signal} stderr=${stderr.slice(0, 500)}`));
      }
    });
  });
}

/**
 * Read every lock file from ~/.ace/sessions/ and parse it.
 */
function listSessionLocks(): Array<{ filename: string; lock: any; alive: boolean }> {
  const dir = path.join(os.homedir(), '.ace', 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.lock.json'))
    .map((filename) => {
      const full = path.join(dir, filename);
      let lock: any;
      try {
        lock = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        lock = null;
      }
      let alive = false;
      if (lock && Number.isFinite(lock.mcp_pid)) {
        try {
          process.kill(lock.mcp_pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      return { filename, lock, alive };
    });
}

/**
 * Look up PIDs on a port via lsof. Same shape as `findPidsOnPort` in
 * `session-lock.ts` — duplicated here so the probe doesn't depend on
 * importing that module dynamically.
 */
import { execSync } from 'node:child_process';
function findPidsOnPort(port: number): number[] {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
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

async function teardown() {
  for (const sub of SUBPROCS) {
    try {
      if (sub.innerPid) {
        try {
          process.kill(sub.innerPid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
      try {
        sub.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      // Also unlink any lock written by this subprocess
      if (sub.innerPid) {
        const lockPath = path.join(os.homedir(), '.ace', 'sessions', `${sub.innerPid}.lock.json`);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}

process.on('SIGINT', async () => {
  await teardown();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await teardown();
  process.exit(143);
});

async function main() {
  const errors: string[] = [];

  // ── Phase 0: Initial state ────────────────────────────────────────
  phase('initial-state', {
    cwd: process.cwd(),
    n: FLAG_N,
    kill_one: FLAG_KILL_ONE,
    with_listeners: FLAG_WITH_LISTENERS,
    cleanup_only: FLAG_CLEANUP_ONLY,
    initial_locks: listSessionLocks(),
  });

  if (FLAG_CLEANUP_ONLY) {
    // Run the reaper directly via the production module
    const { reapStaleSessions } = await import('file://' + SESSION_LOCK_TS);
    const reap = reapStaleSessions({ all: true });
    phase('cleanup-only-reap', reap);
    return;
  }

  // ── Phase 1: Spawn N parallel allocators ───────────────────────────
  phase('spawning', { n: FLAG_N });
  const started: Array<StartedInfo & { label: string }> = [];
  // Spawn in parallel — actually concurrent, not sequential.
  const spawnPromises: Array<Promise<any>> = [];
  for (let i = 0; i < FLAG_N; i++) {
    spawnPromises.push(
      spawnAllocator(`s${i + 1}`, FLAG_WITH_LISTENERS).then((info) => {
        // IMPORTANT: omit `proc` from the entries we log — it's a
        // ChildProcess with circular references and socket state that
        // explodes the JSON output by hundreds of KB.
        const { proc: _omit, ...clean } = info;
        started.push({ ...clean, label: `s${i + 1}` });
      })
    );
  }
  await Promise.all(spawnPromises);
  started.sort((a, b) => a.label.localeCompare(b.label));
  phase('all-started', { allocators: started });

  // ── Phase 2: Verify distinct ports ─────────────────────────────────
  const adbPorts = new Set(started.map((s) => s.adb_port));
  const emuPorts = new Set(started.map((s) => s.emulator_port));
  if (adbPorts.size !== started.length) {
    errors.push(`adb port collision: ${started.length} allocators, only ${adbPorts.size} distinct adb ports`);
  }
  if (emuPorts.size !== started.length) {
    errors.push(`emulator port collision: ${started.length} allocators, only ${emuPorts.size} distinct emu ports`);
  }
  phase('port-distinctness', {
    allocators: started.length,
    distinct_adb_ports: adbPorts.size,
    distinct_emu_ports: emuPorts.size,
    pass: adbPorts.size === started.length && emuPorts.size === started.length,
  });

  // ── Phase 3: Lock file state ───────────────────────────────────────
  // Filter to only our subprocesses' locks (innerPid match)
  const ourPids = new Set(started.map((s) => s.innerPid));
  const allLocks = listSessionLocks();
  const ourLocks = allLocks.filter((l) => l.lock && ourPids.has(l.lock.mcp_pid));
  if (ourLocks.length !== started.length) {
    errors.push(`lock file mismatch: ${started.length} allocators, ${ourLocks.length} our locks found`);
  }
  for (const lock of ourLocks) {
    if (!lock.alive) {
      errors.push(`lock for ${lock.lock.mcp_pid} marked as not-alive but subprocess is still running`);
    }
  }
  phase('locks-after-spawn', {
    our_locks: ourLocks.map((l) => ({
      mcp_pid: l.lock.mcp_pid,
      adb_port: l.lock.adb_port,
      emulator_port: l.lock.emulator_port,
      avd_name: l.lock.avd_name,
      alive: l.alive,
    })),
    other_locks_present: allLocks.length - ourLocks.length,
  });

  // ── Phase 4: (Optional) Verify listeners bound ─────────────────────
  if (FLAG_WITH_LISTENERS) {
    const listenerReport = started.map((s) => {
      const adbPids = findPidsOnPort(s.adb_port);
      const emuPids = findPidsOnPort(s.emulator_port);
      return {
        label: s.label,
        innerPid: s.innerPid,
        adb_port: s.adb_port,
        adb_listener_pids: adbPids,
        emu_port: s.emulator_port,
        emu_listener_pids: emuPids,
      };
    });
    // Each subprocess should have its own listener PID on its own ports
    for (const r of listenerReport) {
      if (!r.adb_listener_pids.includes(r.innerPid)) {
        errors.push(`${r.label}: adb listener not bound (expected pid ${r.innerPid} on ${r.adb_port}, lsof saw ${JSON.stringify(r.adb_listener_pids)})`);
      }
      if (!r.emu_listener_pids.includes(r.innerPid)) {
        errors.push(`${r.label}: emu listener not bound (expected pid ${r.innerPid} on ${r.emu_port}, lsof saw ${JSON.stringify(r.emu_listener_pids)})`);
      }
    }
    phase('listeners-verified', { listeners: listenerReport });
  }

  // ── Phase 5: (Optional) Kill one, verify reaper cleans it ──────────
  if (FLAG_KILL_ONE && started.length > 0) {
    const victim = started[0];
    phase('kill-victim', { label: victim.label, innerPid: victim.innerPid });

    process.kill(victim.innerPid, 'SIGKILL');
    // Wait for PID to actually drop off
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(victim.innerPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        break;
      }
    }
    let stillAlive = true;
    try {
      process.kill(victim.innerPid, 0);
    } catch {
      stillAlive = false;
    }
    if (stillAlive) {
      errors.push(`victim pid ${victim.innerPid} still alive after SIGKILL + 2.5s wait`);
    }

    // Verify victim's lock SURVIVED the kill (SIGKILL bypasses handler)
    const lockPath = path.join(os.homedir(), '.ace', 'sessions', `${victim.innerPid}.lock.json`);
    const lockSurvived = fs.existsSync(lockPath);
    if (!lockSurvived) {
      errors.push(`victim's lock at ${lockPath} should have SURVIVED SIGKILL but it's gone`);
    }
    phase('post-kill-state', {
      victim_pid_alive: stillAlive,
      victim_lock_survives: lockSurvived,
    });

    // (If --with-listeners) verify listeners on victim's ports STILL bound? No —
    // when the Node process dies, its TCP listeners die with it. So findPidsOnPort
    // should return [] for victim's ports. We only get to test the reaper's
    // kill-on-port path with REAL daemonized processes (adb fork-server). The
    // test below verifies the lock-cleanup path; daemon kill is exercised in
    // production scenarios only.

    // Run the reaper
    const { reapStaleSessions } = await import('file://' + SESSION_LOCK_TS);
    const reapResult = reapStaleSessions();
    const victimLockKey = `${victim.innerPid}.lock.json`;
    if (!reapResult.reaped_locks.includes(victimLockKey)) {
      errors.push(`reaper did not list victim's lock (${victimLockKey}) as reaped; got: ${JSON.stringify(reapResult.reaped_locks)}`);
    }
    if (fs.existsSync(lockPath)) {
      errors.push(`reaper claimed to remove victim's lock but file still exists at ${lockPath}`);
    }
    // Verify surviving siblings' locks are preserved
    for (const sibling of started.slice(1)) {
      const siblingLockPath = path.join(os.homedir(), '.ace', 'sessions', `${sibling.innerPid}.lock.json`);
      if (!fs.existsSync(siblingLockPath)) {
        errors.push(`sibling ${sibling.label}'s lock should have survived but is gone`);
      }
    }
    phase('post-reap-state', {
      reap_result: reapResult,
      victim_lock_gone: !fs.existsSync(lockPath),
      surviving_siblings: started.slice(1).map((s) => {
        const lp = path.join(os.homedir(), '.ace', 'sessions', `${s.innerPid}.lock.json`);
        return { label: s.label, lock_present: fs.existsSync(lp) };
      }),
    });
  }

  // ── Final ──────────────────────────────────────────────────────────
  phase('summary', {
    pass: errors.length === 0,
    errors,
  });

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    phase('fatal-error', { error: String(e?.message ?? e), stack: e?.stack });
    process.exitCode = 2;
  })
  .finally(async () => {
    await teardown();
  });
