import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShellFn } from '../../../mcp/mobile/backends/avd.js';

/**
 * dimagi-internal/ace#2793 — group-payment-test/20261007-1700 Phase 6.
 *
 * `MobileClient` built its `MaestroBackend` on bare `defaultShell`, so the
 * driver-install gate (`waitForDeviceBooted` → `adb -s <serial> get-state`)
 * talked to the DEFAULT adb server (5037). On a contended host 5037 belongs
 * to another macOS account; this session's emulator registered on its
 * ALLOCATED server (5040 in the repro) and was `device` within 27s, yet the
 * gate failed five heals in a row at 180s with "device not found".
 *
 * The shell below simulates that host: only a call carrying
 * `ANDROID_ADB_SERVER_PORT=5040` can see the emulator. The negative control
 * is the pre-fix construction (`new MaestroBackend()`), which must fail
 * exactly the way the run did.
 */

const ALLOCATED = 5040;
const SERIAL = 'emulator-5558';
const calls: Array<{ cmd: string; args: string[]; port: string | undefined }> = [];

/** A host where 5037 is someone else's server and ours is ALLOCATED. */
const contendedHostShell: ShellFn = async (cmd, args, opts) => {
  const port = opts?.env?.ANDROID_ADB_SERVER_PORT;
  calls.push({ cmd, args, port });
  if (cmd !== 'adb') return { stdout: '', stderr: '', exitCode: 0 };
  if (port !== String(ALLOCATED)) {
    return { stdout: '', stderr: `error: device '${SERIAL}' not found`, exitCode: 1 };
  }
  if (args.includes('get-state')) return { stdout: 'device\n', stderr: '', exitCode: 0 };
  if (args.includes('sys.boot_completed')) return { stdout: '1\n', stderr: '', exitCode: 0 };
  return { stdout: '', stderr: '', exitCode: 0 };
};

vi.mock('../../../mcp/mobile/backends/avd.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../mcp/mobile/backends/avd.js')>();
  return { ...orig, defaultShell: (...a: Parameters<ShellFn>) => contendedHostShell(...a) };
});

const { MobileClient } = await import('../../../mcp/mobile/client.js');
const { MaestroBackend } = await import('../../../mcp/mobile/backends/maestro.js');
const { pinAdbServerPort } = await import('../../../mcp/mobile/backends/avd.js');

function fakeAvd() {
  return {
    getAllocatedPorts: vi.fn(async () => ({ adbServerPort: ALLOCATED })),
  } as any;
}

beforeEach(() => {
  calls.length = 0;
});

describe('MobileClient pins the Maestro backend to the allocated adb server (ace#2793)', () => {
  it('the driver-install gate sees the device on the allocated port', async () => {
    const client = new MobileClient({ avd: fakeAvd(), bootstrapConfig: null });
    await (client.maestro as any).waitForDeviceBooted(SERIAL, 5_000);

    const adbCalls = calls.filter((c) => c.cmd === 'adb');
    expect(adbCalls.length).toBeGreaterThan(0);
    for (const c of adbCalls) expect(c.port).toBe(String(ALLOCATED));
  });

  it('negative control: the pre-fix bare MaestroBackend polls 5037 and times out like the run did', async () => {
    const bare = new MaestroBackend();
    await expect((bare as any).waitForDeviceBooted(SERIAL, 50)).rejects.toThrow(
      /never appeared on the adb server.*device 'emulator-5558' not found/,
    );
    const adbCalls = calls.filter((c) => c.cmd === 'adb');
    expect(adbCalls.length).toBeGreaterThan(0);
    for (const c of adbCalls) expect(c.port).toBeUndefined();
  });

  it('an injected maestro backend is left alone', () => {
    const maestro = new MaestroBackend({ shell: contendedHostShell });
    const client = new MobileClient({ avd: fakeAvd(), maestro, bootstrapConfig: null });
    expect(client.maestro).toBe(maestro);
  });
});

describe('pinAdbServerPort', () => {
  it('adds ANDROID_ADB_SERVER_PORT to adb calls only', async () => {
    const inner = vi.fn<ShellFn>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const shell = pinAdbServerPort(inner, async () => 5039);

    await shell('adb', ['devices'], { timeoutMs: 1_000 });
    await shell('maestro', ['test', 'x.yaml'], { cwd: '/tmp' });

    expect(inner.mock.calls[0][2]).toEqual({ timeoutMs: 1_000, env: { ANDROID_ADB_SERVER_PORT: '5039' } });
    expect(inner.mock.calls[1][2]).toEqual({ cwd: '/tmp' });
  });

  it("keeps a caller's explicit per-call port and other env keys", async () => {
    const inner = vi.fn<ShellFn>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const shell = pinAdbServerPort(inner, async () => 5039);

    await shell('adb', ['devices'], { env: { ANDROID_ADB_SERVER_PORT: '5041', FOO: 'bar' } });

    expect(inner.mock.calls[0][2]?.env).toEqual({ ANDROID_ADB_SERVER_PORT: '5041', FOO: 'bar' });
  });

  it('does not mutate process.env', async () => {
    const before = process.env.ANDROID_ADB_SERVER_PORT;
    const shell = pinAdbServerPort(async () => {
      expect(process.env.ANDROID_ADB_SERVER_PORT).toBe(before);
      return { stdout: '', stderr: '', exitCode: 0 };
    }, async () => 5039);
    await shell('adb', ['devices']);
    expect(process.env.ANDROID_ADB_SERVER_PORT).toBe(before);
  });
});
