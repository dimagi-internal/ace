import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyDeviceUserState, MobileClient } from '../../../mcp/mobile/client.js';
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

describe('MobileClient cloud-only diagnostic atoms', () => {
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

  function fakeCloud() {
    return {
      diagnose: vi.fn().mockResolvedValue({ ssm_ok: true, adb_devices: [] }),
      restartRunner: vi.fn().mockResolvedValue({ ssm_ok: true }),
      patchLaunchScript: vi.fn().mockResolvedValue({ sha256: 'x' }),
    } as any;
  }

  it('routes diagnose / restartRunner / patchLaunchScript to the cloud backend when cloud is active', async () => {
    setSessionBackend('cloud');
    const cloud = fakeCloud();
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud });

    await client.diagnose();
    expect(cloud.diagnose).toHaveBeenCalledTimes(1);

    await client.restartRunner({ waitForReady: false });
    expect(cloud.restartRunner).toHaveBeenCalledWith({ waitForReady: false });

    await client.patchLaunchScript({ scriptBody: '#!/bin/bash\n', restartRunner: false });
    expect(cloud.patchLaunchScript).toHaveBeenCalledWith({
      scriptBody: '#!/bin/bash\n',
      restartRunner: false,
    });
  });

  it('throws CLOUD_ONLY_OPERATION when active backend is local', async () => {
    // Default is local (no session file, no env).
    const client = new MobileClient({ avd: {} as any, maestro: {} as any, cloud: fakeCloud() });
    expect(client.useCloud).toBe(false);

    // requireCloudOnly throws synchronously before returning a Promise,
    // matching the pattern used by listAvds (see useCloud test above).
    expect(() => client.diagnose()).toThrow(/only available on the cloud/);
    expect(() => client.restartRunner()).toThrow(/only available on the cloud/);
    expect(() => client.patchLaunchScript({ scriptBody: '#!/bin/bash\n' })).toThrow(
      /only available on the cloud/,
    );
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
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn().mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      loadSnapshot: vi.fn(),
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
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn().mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      loadSnapshot: vi.fn(),
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

describe('classifyDeviceUserState', () => {
  it('returns commcare-not-installed when org.commcare.dalvik is absent', () => {
    expect(classifyDeviceUserState('mResumedActivity: Launcher', '<dump/>', [])).toBe(
      'commcare-not-installed',
    );
  });

  it('returns needs-personal-id when the PersonalID drawer is showing', () => {
    const ui = '<node text="Logged out of PersonalID"/><node text="Reconfigure"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', ui, ['org.commcare.dalvik']),
    ).toBe('needs-personal-id');
  });

  it('returns needs-app-config when the setup activity is foregrounded without PersonalID drawer', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: ActivityRecord{... CommCareSetupActivity}', '<dump/>', [
        'org.commcare.dalvik',
      ]),
    ).toBe('needs-app-config');
  });

  it('returns needs-app-config when the dump shows the Enter Code screen', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: SomeUnknownActivity', '<node text="Enter Code"/>', [
        'org.commcare.dalvik',
      ]),
    ).toBe('needs-app-config');
  });

  it('returns ready when the home/opp tile activity is foregrounded', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: ActivityRecord{... OpportunitiesActivity}', '', [
        'org.commcare.dalvik',
      ]),
    ).toBe('ready');
  });

  it('returns unknown when no markers match', () => {
    expect(classifyDeviceUserState('mResumedActivity: SomethingElse', '', ['org.commcare.dalvik'])).toBe(
      'unknown',
    );
  });

  it('prefers PersonalID drawer over CommCareSetupActivity (stacked-state case)', () => {
    const stacked = '<node text="Logged out of PersonalID"/>';
    expect(
      classifyDeviceUserState(
        'mResumedActivity: ActivityRecord{... CommCareSetupActivity}',
        stacked,
        ['org.commcare.dalvik'],
      ),
    ).toBe('needs-personal-id');
  });
});

describe('MobileClient.assertDeviceUserStateHealthy', () => {
  const readyAvd = { name: 'AVD', serial: 'emulator-5554', status: 'booted' } as const;

  it('skips heal when state is ready', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi
        .fn()
        .mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      loadSnapshot: vi.fn(),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    const client = new MobileClient({ avd, maestro });
    const r = await client.ensureAvdRunning('AVD');
    expect(r.heal?.deviceUserState?.classified_as).toBe('ready');
    expect(r.heal?.deviceUserState?.attempted).toBe(false);
    expect(avd.loadSnapshot).not.toHaveBeenCalled();
  });

  it('recovers from needs-personal-id via loadSnapshot', async () => {
    const focused = vi
      .fn()
      .mockResolvedValueOnce('mResumedActivity: CommCareSetupActivity')
      .mockResolvedValueOnce('mResumedActivity: ActivityRecord{... OpportunitiesActivity}');
    const dump = vi
      .fn()
      .mockResolvedValueOnce({ xml: '<node text="Logged out of PersonalID"/>', elements: [] })
      .mockResolvedValueOnce({ xml: '', elements: [] });
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: focused,
      captureUiDump: dump,
      loadSnapshot: vi
        .fn()
        .mockResolvedValue({ avdName: 'AVD', snapshotName: 'registered-test-user', saved: true, output: 'OK' }),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    const client = new MobileClient({ avd, maestro });
    const r = await client.ensureAvdRunning('AVD');
    expect(avd.loadSnapshot).toHaveBeenCalledWith('AVD', 'registered-test-user');
    expect(r.heal?.deviceUserState).toMatchObject({
      classified_as: 'needs-personal-id',
      attempted: true,
      healed_via: 'snapshot-load',
      verified_as: 'ready',
    });
  });

  it('throws DeviceUserStateError when loadSnapshot fails (saved=false)', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn().mockResolvedValue('mResumedActivity: CommCareSetupActivity'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      loadSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: false,
        output: 'error: snapshot does not exist',
      }),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    const client = new MobileClient({ avd, maestro });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*needs-app-config.*loadSnapshot:fail/,
    );
  });

  it('throws DeviceUserStateError when re-probe after loadSnapshot still shows a wiped state', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn().mockResolvedValue('mResumedActivity: CommCareSetupActivity'),
      captureUiDump: vi.fn().mockResolvedValue({
        xml: '<node text="Logged out of PersonalID"/>',
        elements: [],
      }),
      loadSnapshot: vi
        .fn()
        .mockResolvedValue({ avdName: 'AVD', snapshotName: 'registered-test-user', saved: true, output: 'OK' }),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    const client = new MobileClient({ avd, maestro });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*probe2:needs-personal-id/,
    );
  });

  it('exhausts immediately for commcare-not-installed (no snapshot can install an APK)', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue([]),
      getFocusedActivity: vi.fn().mockResolvedValue('mResumedActivity: Launcher'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      loadSnapshot: vi.fn(),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    const client = new MobileClient({ avd, maestro });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*commcare-not-installed.*loadSnapshot:skipped/,
    );
    expect(avd.loadSnapshot).not.toHaveBeenCalled();
  });
});
