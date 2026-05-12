import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';
import { setSessionBackend, clearSessionBackend } from '../../../mcp/mobile/backend-toggle.js';

function fakeMaestroAndAvd(opts: {
  registerToOtp: 'pass' | 'fail';
  registerFromOtp: 'pass' | 'fail' | 'already';
  otp: string;
}) {
  const avd = {
    ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
    findRunningAvd: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
    setGmsEnabled: vi.fn().mockResolvedValue(undefined),
  } as any;
  const runRecipe = vi.fn().mockImplementation(async (recipePath: string) => {
    if (recipePath.endsWith('connect-register-to-otp.yaml')) {
      return { status: opts.registerToOtp, exitCode: opts.registerToOtp === 'pass' ? 0 : 1, screenshots: [], stdout: '', stderr: '', screenshotsDir: '/tmp' };
    }
    if (recipePath.endsWith('connect-register-from-otp.yaml')) {
      if (opts.registerFromOtp === 'already') {
        return { status: 'fail', exitCode: 2, screenshots: [], stdout: 'PHONE_ALREADY_REGISTERED', stderr: '', screenshotsDir: '/tmp' };
      }
      return { status: opts.registerFromOtp, exitCode: opts.registerFromOtp === 'pass' ? 0 : 1, screenshots: [], stdout: '', stderr: '', screenshotsDir: '/tmp' };
    }
    throw new Error(`unexpected recipe: ${recipePath}`);
  });
  const maestro = { runRecipe } as any;
  return { avd, maestro };
}

describe('MobileClient.registerTestUser', () => {
  it('runs to-otp then from-otp recipes and returns success', async () => {
    const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'pass', otp: '123456' });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: '/static' });

    const r = await client.registerTestUser({
      avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
      pin: '111111', backupCode: '222222', name: 'ACE Test',
    });
    expect(r.alreadyRegistered).toBe(false);
    expect(r.phone).toBe('+74260000001');
    expect(avd.setGmsEnabled).toHaveBeenCalledWith('AVD', true);
    expect(avd.setGmsEnabled).toHaveBeenCalledWith('AVD', false);
  });

  it('detects PHONE_ALREADY_REGISTERED and returns alreadyRegistered=true', async () => {
    const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'already', otp: '123456' });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: '/static' });

    const r = await client.registerTestUser({
      avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
      pin: '111111', backupCode: '222222', name: 'ACE Test',
    });
    expect(r.alreadyRegistered).toBe(true);
  });

  it('returns alreadyRegistered=true without invoking AVD/maestro on cloud backend', async () => {
    const prev = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    try {
      const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'pass', otp: '123456' });
      // Stub the cloud backend so the client constructor doesn't try to hit ace-web env.
      const cloud = {} as any;
      const client = new MobileClient({ avd, maestro, cloud, staticRecipesDir: '/static' });

      const r = await client.registerTestUser({
        avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
        pin: '111111', backupCode: '222222', name: 'ACE Test',
      });
      expect(r.alreadyRegistered).toBe(true);
      expect(r.phone).toBe('+74260000001');
      expect(avd.ensureAvdRunning).not.toHaveBeenCalled();
      expect(maestro.runRecipe).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
      else process.env.ACE_MOBILE_BACKEND = prev;
    }
  });
});

describe('MobileClient.useCloud (dynamic resolution)', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.ACE_MOBILE_BACKEND;
    delete process.env.ACE_MOBILE_BACKEND;
    clearSessionBackend();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = savedEnv;
    clearSessionBackend();
  });

  it('re-resolves between calls — toggling the session file flips routing', () => {
    const avd = {} as any;
    const maestro = {} as any;
    const cloud = {} as any;
    const client = new MobileClient({ avd, maestro, cloud });

    expect(client.useCloud).toBe(false); // default
    setSessionBackend('cloud');
    expect(client.useCloud).toBe(true);  // session file flipped
    setSessionBackend('local');
    expect(client.useCloud).toBe(false); // back to local
  });

  it('throws CLOUD_NOT_CONFIGURED when cloud is selected but client.cloud is null', async () => {
    setSessionBackend('cloud');
    // No cloud option passed → constructor catches the CLOUD_NOT_CONFIGURED
    // error from CloudBackend (no ACE_WEB env) and sets this.cloud = null.
    const prevBase = process.env.ACE_WEB_BASE_URL;
    const prevTok = process.env.ACE_WEB_PAT_TOKEN;
    delete process.env.ACE_WEB_BASE_URL;
    delete process.env.ACE_WEB_PAT_TOKEN;
    try {
      const client = new MobileClient({ avd: {} as any, maestro: {} as any });
      expect(client.cloud).toBeNull();
      // requireCloud throws synchronously — listAvds() itself raises before
      // returning a Promise. Either form (sync throw or Promise rejection)
      // would be valid; this asserts the actual runtime behavior.
      expect(() => client.listAvds()).toThrow(/cloud backend selected but not configured/);
    } finally {
      if (prevBase !== undefined) process.env.ACE_WEB_BASE_URL = prevBase;
      if (prevTok !== undefined) process.env.ACE_WEB_PAT_TOKEN = prevTok;
    }
  });
});

describe('MobileClient.assertMaestroDriverHealthy', () => {
  function makeClient(probeReturns: Array<{ healthy: boolean; reason?: string }>, repairActions: string[] = ['force-stop', 'uninstall']) {
    const probeCalls: number[] = [];
    const avd = {
      ensureAvdRunning: vi.fn(),
      findRunningAvd: vi.fn(),
    } as any;
    const maestro = {
      probeDriver: vi.fn(async (port: number, timeoutMs: number) => {
        probeCalls.push(timeoutMs);
        const next = probeReturns.shift();
        if (!next) throw new Error('probeDriver called more times than scripted');
        return next;
      }),
      repairDriver: vi.fn(async () => repairActions),
    } as any;
    return { client: new MobileClient({ avd, maestro }), probeCalls, maestro };
  }

  it('passes through cleanly when the driver is healthy on the first probe', async () => {
    const { client, probeCalls, maestro } = makeClient([{ healthy: true }]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).resolves.toBeUndefined();
    expect(probeCalls).toEqual([8_000]); // single short-timeout probe
    expect(maestro.repairDriver).not.toHaveBeenCalled();
  });

  it('repairs + re-probes with the longer reinstall timeout when stage 1 fails', async () => {
    const { client, probeCalls, maestro } = makeClient([
      { healthy: false, reason: 'UNAVAILABLE' },
      { healthy: true },
    ]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).resolves.toBeUndefined();
    expect(probeCalls).toEqual([8_000, 90_000]); // 2nd probe gets reinstall budget
    expect(maestro.repairDriver).toHaveBeenCalledTimes(1);
    expect(maestro.repairDriver).toHaveBeenCalledWith('emulator-5554');
  });

  it('throws MaestroDriverError when stage 2 probe still reports unhealthy', async () => {
    const { client } = makeClient([
      { healthy: false, reason: 'UNAVAILABLE' },
      { healthy: false, reason: 'still UNAVAILABLE after reinstall' },
    ]);
    await expect(client.assertMaestroDriverHealthy('emulator-5554')).rejects.toThrow(/Maestro driver.*unhealthy after recovery/);
  });

  it('skips the probe for non-emulator serials (real device)', async () => {
    const { client, maestro } = makeClient([]);
    await expect(client.assertMaestroDriverHealthy('abc123def')).resolves.toBeUndefined();
    expect(maestro.probeDriver).not.toHaveBeenCalled();
    expect(maestro.repairDriver).not.toHaveBeenCalled();
  });
});

describe('MobileClient.ensureAvdRunning', () => {
  it('chains AvdBackend.ensureAvdRunning then assertMaestroDriverHealthy', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    const client = new MobileClient({ avd, maestro });
    const r = await client.ensureAvdRunning('AVD');
    expect(r.serial).toBe('emulator-5554');
    expect(avd.ensureAvdRunning).toHaveBeenCalledWith('AVD');
    expect(maestro.probeDriver).toHaveBeenCalledTimes(1);
  });

  it('propagates MaestroDriverError when the driver heal exhausts', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
    } as any;
    const maestro = {
      probeDriver: vi.fn()
        .mockResolvedValueOnce({ healthy: false, reason: 'UNAVAILABLE' })
        .mockResolvedValueOnce({ healthy: false, reason: 'still UNAVAILABLE' }),
      repairDriver: vi.fn().mockResolvedValue(['force-stop', 'uninstall']),
    } as any;
    const client = new MobileClient({ avd, maestro });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/Maestro driver.*unhealthy after recovery/);
  });
});
