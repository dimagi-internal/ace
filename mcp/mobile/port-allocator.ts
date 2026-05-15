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
 * Throws if nothing is free in the search window. The window is
 * deliberately small (32) — if 32 sequential ports are all taken
 * something is structurally wrong on the host, not a normal collision.
 */
export async function findFreeTcpPort(start: number, maxAttempts = 32): Promise<number> {
  for (let p = start; p < start + maxAttempts; p++) {
    if (await isTcpPortFree(p)) return p;
  }
  throw new Error(
    `findFreeTcpPort: no free TCP port in [${start}, ${start + maxAttempts}). ` +
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
  for (; p <= MAX_EMULATOR_CONSOLE_PORT; p += 2) {
    if ((await isTcpPortFree(p)) && (await isTcpPortFree(p + 1))) {
      return { console: p, adbBridge: p + 1 };
    }
  }
  throw new Error(
    `findFreeEmulatorPair: no free emulator console+adb-bridge pair in ` +
      `[${startConsole}, ${MAX_EMULATOR_CONSOLE_PORT}]. ` +
      `Stop unused emulators with \`adb -s emulator-<port> emu kill\` or restart the host.`,
  );
}

/**
 * Resolve the adb-server port: env var wins; otherwise probe-and-pick
 * starting at the default 5037.
 */
export async function resolveAdbServerPort(): Promise<number> {
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
 */
export async function resolveEmulatorPair(): Promise<{ console: number; adbBridge: number }> {
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
