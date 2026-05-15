import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import {
  isTcpPortFree,
  findFreeTcpPort,
  findFreeEmulatorPair,
  resolveAdbServerPort,
  resolveEmulatorPair,
  MIN_EMULATOR_CONSOLE_PORT,
  MAX_EMULATOR_CONSOLE_PORT,
} from '../../../mcp/mobile/port-allocator.js';

/**
 * Helper: bind a real loopback socket on `port` so the probe sees it as
 * "in use". Returns the server so the test can close it on teardown.
 */
function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => resolve(server));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Helper: ask the OS for an ephemeral port we know is free, return it,
 * then close. There IS a tiny race window between this returning and a
 * test rebinding the port — kept narrow by avoiding any awaits between
 * the lookup and the test's bind.
 */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close();
        reject(new Error('unexpected address shape'));
      }
    });
  });
}

describe('port-allocator: isTcpPortFree', () => {
  const openServers: net.Server[] = [];
  afterEach(() => {
    for (const s of openServers) s.close();
    openServers.length = 0;
  });

  it('returns true for a port nothing has bound', async () => {
    const port = await ephemeralPort();
    expect(await isTcpPortFree(port)).toBe(true);
  });

  it('returns false for a port a real socket is bound to', async () => {
    const port = await ephemeralPort();
    const server = await occupyPort(port);
    openServers.push(server);
    expect(await isTcpPortFree(port)).toBe(false);
  });
});

describe('port-allocator: findFreeTcpPort', () => {
  const openServers: net.Server[] = [];
  afterEach(() => {
    for (const s of openServers) s.close();
    openServers.length = 0;
  });

  it('returns the start port when free', async () => {
    const port = await ephemeralPort();
    const found = await findFreeTcpPort(port);
    expect(found).toBe(port);
  });

  it('walks upward when start is occupied', async () => {
    const start = await ephemeralPort();
    const server = await occupyPort(start);
    openServers.push(server);
    const found = await findFreeTcpPort(start);
    expect(found).toBeGreaterThan(start);
    expect(found).toBeLessThan(start + 32);
  });

  it('throws when nothing is free in the search window', async () => {
    // Force exhaustion by giving an unreachable start (port 0 is reserved
    // and the OS returns an ephemeral port on bind, so probes succeed —
    // we instead occupy a small window and pass a tiny maxAttempts).
    const start = await ephemeralPort();
    const server = await occupyPort(start);
    openServers.push(server);
    // maxAttempts=1 → only check `start` itself, which is occupied.
    await expect(findFreeTcpPort(start, 1)).rejects.toThrow(/no free TCP port/);
  });
});

describe('port-allocator: findFreeEmulatorPair', () => {
  const openServers: net.Server[] = [];
  afterEach(() => {
    for (const s of openServers) s.close();
    openServers.length = 0;
  });

  it('requires BOTH ports of a candidate pair to be free', async () => {
    // Find a free even console port in the emulator-valid range, then
    // occupy ONLY its odd adb-bridge sibling. The allocator must
    // skip past it to the next pair.
    let candidate = MIN_EMULATOR_CONSOLE_PORT;
    while (candidate <= MAX_EMULATOR_CONSOLE_PORT - 4) {
      if ((await isTcpPortFree(candidate)) && (await isTcpPortFree(candidate + 1))) break;
      candidate += 2;
    }
    // Occupy the odd adb-bridge sibling so the candidate console port is
    // "free" but the pair is not.
    const bridge = await occupyPort(candidate + 1);
    openServers.push(bridge);

    const found = await findFreeEmulatorPair(candidate);
    // Must NOT have returned `candidate` even though `candidate` itself
    // is free — the pair-completeness check is the whole point.
    expect(found.console).not.toBe(candidate);
    expect(found.console).toBeGreaterThanOrEqual(candidate + 2);
    expect(found.adbBridge).toBe(found.console + 1);
    // Console port must remain in the emulator-valid range.
    expect(found.console).toBeGreaterThanOrEqual(MIN_EMULATOR_CONSOLE_PORT);
    expect(found.console).toBeLessThanOrEqual(MAX_EMULATOR_CONSOLE_PORT);
    expect(found.console % 2).toBe(0);
  });

  it('snaps an odd start up to the next even', async () => {
    // We can't easily assert which port is returned (depends on host
    // state), but we CAN assert the returned console port is even.
    const found = await findFreeEmulatorPair(MIN_EMULATOR_CONSOLE_PORT + 1);
    expect(found.console % 2).toBe(0);
    expect(found.console).toBeGreaterThanOrEqual(MIN_EMULATOR_CONSOLE_PORT);
  });
});

describe('port-allocator: env override resolvers', () => {
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

  it('resolveAdbServerPort: env value wins over auto-probe', async () => {
    process.env.ANDROID_ADB_SERVER_PORT = '5099';
    expect(await resolveAdbServerPort()).toBe(5099);
  });

  it('resolveAdbServerPort: rejects non-numeric env', async () => {
    process.env.ANDROID_ADB_SERVER_PORT = 'not-a-port';
    await expect(resolveAdbServerPort()).rejects.toThrow(/not a valid TCP port/);
  });

  it('resolveAdbServerPort: auto-probes when env unset', async () => {
    delete process.env.ANDROID_ADB_SERVER_PORT;
    const port = await resolveAdbServerPort();
    expect(port).toBeGreaterThanOrEqual(5037);
    expect(port).toBeLessThan(5037 + 32);
  });

  it('resolveEmulatorPair: env value wins over auto-probe', async () => {
    process.env.ACE_MOBILE_EMULATOR_PORT = '5580';
    const pair = await resolveEmulatorPair();
    expect(pair).toEqual({ console: 5580, adbBridge: 5581 });
  });

  it('resolveEmulatorPair: rejects odd env value', async () => {
    process.env.ACE_MOBILE_EMULATOR_PORT = '5555';
    await expect(resolveEmulatorPair()).rejects.toThrow(/must be EVEN/);
  });

  it('resolveEmulatorPair: rejects out-of-range env value', async () => {
    process.env.ACE_MOBILE_EMULATOR_PORT = '4000';
    await expect(resolveEmulatorPair()).rejects.toThrow(/outside the emulator/);
  });

  it('resolveEmulatorPair: auto-probes when env unset', async () => {
    delete process.env.ACE_MOBILE_EMULATOR_PORT;
    const pair = await resolveEmulatorPair();
    expect(pair.console).toBeGreaterThanOrEqual(MIN_EMULATOR_CONSOLE_PORT);
    expect(pair.console).toBeLessThanOrEqual(MAX_EMULATOR_CONSOLE_PORT);
    expect(pair.console % 2).toBe(0);
    expect(pair.adbBridge).toBe(pair.console + 1);
  });
});
