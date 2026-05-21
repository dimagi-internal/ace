/**
 * Port allocation for the local AVD backend.
 *
 * Two concurrent `/ace:run` cycles on the same laptop both default to
 * `adb` on TCP 5037 and `emulator` on console 5554 / adb-bridge 5555.
 * They collide: the second emulator boot fails or attaches to the first
 * session's adb-server. This module probes for free ports by binding a
 * real `net.Server`, walking upward until a free pair is found.
 *
 * Why not `lsof` / `ss`? Race condition — the port can be claimed
 * between the probe and the bind. `net.createServer().listen(port)`
 * with the port returned only on success is the only race-free probe.
 *
 * Port semantics:
 *   - adb-server: a single TCP port (default 5037, env
 *     `ANDROID_ADB_SERVER_PORT`).
 *   - emulator: a CONSOLE port (telnet) + adb-bridge port (always
 *     console+1). Console is even, adb-bridge is the next odd. Android
 *     allocates from 5554 upward in steps of 2; valid range is
 *     5554..5680 inclusive (emulator binary refuses outside). We mirror
 *     that here so we don't pick a pair the emulator will reject.
 */
import * as net from 'node:net';
import { acquireSessionLock, getReservedPorts, type SessionLock } from './session-lock.js';

export const DEFAULT_ADB_PORT = 5037;
export const DEFAULT_EMULATOR_CONSOLE_PORT = 5554;
export const MIN_EMULATOR_CONSOLE_PORT = 5554;
export const MAX_EMULATOR_CONSOLE_PORT = 5680; // emulator binary's hard cap

/**
 * Probe a single TCP port by attempting to bind a server on
 * `127.0.0.1:port`. Resolves to true if the port is available, false
 * if it's already in use or the bind otherwise fails. Closes the
 * server immediately on success.
 *
 * The bind targets loopback specifically because adb-server and the
 * emulator console both listen on loopback by default, and probing the
 * wildcard interface would falsely report "free" when the loopback
 * binding it actually races against is already taken.
 */
export async function isTcpPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let resolved = false;
    const settle = (free: boolean) => {
      if (resolved) return;
      resolved = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(free);
    };
    server.once('error', () => settle(false));
    server.once('listening', () => settle(true));
    try {
      server.listen(port, host);
    } catch {
      settle(false);
    }
  });
}

/**
 * Find the next free TCP port at or above `start`, walking by 1 until
 * `start + maxAttempts`. Used for the adb-server port — there's no
 * pairing constraint, just "any free port".
 *
 * A port is "free" iff both:
 *   1. `isTcpPortFree(p)` (no live listener)
 *   2. NOT listed in any live session lock's `adb_port` field
 *
 * Condition 2 covers the TOCTOU race where two parallel allocators
 * both probe the same port in the same instant: with the global
 * allocator mutex held (see `withAllocatorMutex`), only one of them
 * can write a lock at a time; subsequent allocators see the claimed
 * port in their `reservedAdb` set and skip it.
 *
 * Throws if nothing is free in the search window. The window is
 * deliberately small (32) — if 32 sequential ports are all taken
 * something is structurally wrong on the host, not a normal collision.
 */
export async function findFreeTcpPort(start: number, maxAttempts = 32): Promise<number> {
  const { adb: reservedAdb } = getReservedPorts();
  for (let p = start; p < start + maxAttempts; p++) {
    if (reservedAdb.has(p)) continue;
    if (await isTcpPortFree(p)) return p;
  }
  throw new Error(
    `findFreeTcpPort: no free TCP port in [${start}, ${start + maxAttempts}) ` +
      `(reserved by live locks: ${[...reservedAdb].sort().join(',') || 'none'}). ` +
      `Something else is squatting an unusual number of ports — investigate before retrying.`,
  );
}

/**
 * Find the next free emulator port pair (console + adb-bridge) at or
 * above `startConsole`, walking by 2 (emulator console ports must be
 * even). Both ports of a candidate pair must be free before claiming.
 *
 * Returns `{ console, adbBridge }` where `adbBridge === console + 1`.
 *
 * Bounded by `MAX_EMULATOR_CONSOLE_PORT` (5680) — the emulator binary
 * refuses higher ports, so picking one is worse than failing here.
 * Throws on exhaustion.
 */
export async function findFreeEmulatorPair(
  startConsole: number = DEFAULT_EMULATOR_CONSOLE_PORT,
): Promise<{ console: number; adbBridge: number }> {
  // Snap odd starts up to the next even — emulator only accepts even
  // console ports.
  let p = startConsole % 2 === 0 ? startConsole : startConsole + 1;
  const { emulator: reservedEmu } = getReservedPorts();
  for (; p <= MAX_EMULATOR_CONSOLE_PORT; p += 2) {
    if (reservedEmu.has(p) || reservedEmu.has(p + 1)) continue;
    if ((await isTcpPortFree(p)) && (await isTcpPortFree(p + 1))) {
      return { console: p, adbBridge: p + 1 };
    }
  }
  throw new Error(
    `findFreeEmulatorPair: no free emulator console+adb-bridge pair in ` +
      `[${startConsole}, ${MAX_EMULATOR_CONSOLE_PORT}] ` +
      `(reserved by live locks: ${[...reservedEmu].sort().join(',') || 'none'}). ` +
      `Stop unused emulators with \`adb -s emulator-<port> emu kill\` or restart the host.`,
  );
}

/**
 * Resolve the adb-server port: env var wins; otherwise probe-and-pick
 * starting at the default 5037.
 *
 * **Stale-session reaping.** Before probing, walk `~/.ace/sessions/` and
 * SIGKILL any adb daemons whose owning MCP subprocess is dead. This is
 * what makes parallel `/ace:run` sessions resilient: without the reap
 * step, daemons leak across sessions and accumulate as orphans on
 * 5037..5043+ over a day of dogfooding, racing emulator-adbd ownership
 * and producing the `dadb Broken pipe` failure class
 * (`docs/learnings/2026-05-21-parallel-session-adb-leak.md`). Idempotent
 * + best-effort — a failed reap doesn't block allocation.
 */
export async function resolveAdbServerPort(): Promise<number> {
  // No explicit reap here — `findFreeTcpPort` calls `getReservedPorts`
  // which reaps before reading live locks, and the AVD backend wraps
  // this whole sequence in `withAllocatorMutex` for cross-process
  // atomicity.
  const envVal = process.env.ANDROID_ADB_SERVER_PORT?.trim();
  if (envVal) {
    const n = Number.parseInt(envVal, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      throw new Error(
        `ANDROID_ADB_SERVER_PORT='${envVal}' is not a valid TCP port (1-65535).`,
      );
    }
    return n;
  }
  return findFreeTcpPort(DEFAULT_ADB_PORT);
}

/**
 * Resolve the emulator console+adb-bridge pair: env var wins;
 * otherwise probe-and-pick starting at the default 5554.
 *
 * **Stale-session reaping.** Mirrors `resolveAdbServerPort` — sweeps
 * `~/.ace/sessions/` for dead-MCP locks and SIGKILLs any orphan qemu
 * emulators on the freed ports before probing. See `resolveAdbServerPort`
 * for the full rationale.
 */
export async function resolveEmulatorPair(): Promise<{ console: number; adbBridge: number }> {
  // No explicit reap here — see `resolveAdbServerPort` for the
  // rationale (mutex + getReservedPorts handles it).
  const envVal = process.env.ACE_MOBILE_EMULATOR_PORT?.trim();
  if (envVal) {
    const n = Number.parseInt(envVal, 10);
    if (!Number.isFinite(n) || n < MIN_EMULATOR_CONSOLE_PORT || n > MAX_EMULATOR_CONSOLE_PORT) {
      throw new Error(
        `ACE_MOBILE_EMULATOR_PORT='${envVal}' is outside the emulator's accepted ` +
          `console-port range [${MIN_EMULATOR_CONSOLE_PORT}, ${MAX_EMULATOR_CONSOLE_PORT}].`,
      );
    }
    if (n % 2 !== 0) {
      throw new Error(
        `ACE_MOBILE_EMULATOR_PORT='${envVal}' must be EVEN — emulator allocates ` +
          `console+adb-bridge as a consecutive even/odd pair.`,
      );
    }
    return { console: n, adbBridge: n + 1 };
  }
  return findFreeEmulatorPair();
}

/**
 * Write this MCP session's lock file recording its allocated ports.
 * Called by the AVD backend after both `resolveAdbServerPort` and
 * `resolveEmulatorPair` succeed, when the spawn of adb/qemu is about
 * to happen. The lock file ties the MCP subprocess's PID (the lifetime
 * trigger) to the ports it owns; future MCP sessions' `reapStaleSessions`
 * calls will SIGKILL processes on these ports if our PID dies.
 *
 * Idempotent — safe to call repeatedly with the same args.
 */
export function recordSessionLock(args: {
  adbPort: number;
  emulatorPort: number;
  avdName?: string;
}): void {
  const lock: SessionLock = {
    mcp_pid: process.pid,
    started_at: new Date().toISOString(),
    adb_port: args.adbPort,
    emulator_port: args.emulatorPort,
    avd_name: args.avdName,
  };
  acquireSessionLock(lock);
}
