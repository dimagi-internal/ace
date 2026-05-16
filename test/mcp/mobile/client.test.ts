import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  classifyDeviceUserState,
  MobileClient,
  bootstrapConfigFromEnv,
  missingBootstrapEnvVars,
} from '../../../mcp/mobile/client.js';
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
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
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
    // Post-2026-05-14: heal always runs runLocalBootstrap; needs
    // bootstrapConfig + the AvdBackend methods bootstrap calls.
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'AVD', serial: 'emulator-5554', status: 'booted' }),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      clearConnectAppData: vi.fn().mockResolvedValue(true),
      getFocusedActivity: vi.fn().mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      saveSnapshot: vi.fn().mockResolvedValue({ avdName: 'AVD', snapshotName: 'registered-test-user', saved: true, output: 'OK' }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: '/tmp/', screenshots: [],
      }),
    } as any;
    const bootstrapConfig = {
      apkVersion: '2.62.0',
      testUser: {
        phone: '+74260000100', phoneLocal: '4260000100', countryCode: '7',
        pin: '1234', backupCode: 'backup', name: 'ACE Test',
      },
    };
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
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

  it('returns needs-personal-id when CommCareSetupActivity foregrounded AND no Connect nav drawer (unregistered)', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: ActivityRecord{... CommCareSetupActivity}', '<dump/>', [
        'org.commcare.dalvik',
      ]),
    ).toBe('needs-personal-id');
  });

  it('returns needs-personal-id when the dump shows the Enter Code screen AND no Connect nav', () => {
    expect(
      classifyDeviceUserState('mResumedActivity: SomeUnknownActivity', '<node text="Enter Code"/>', [
        'org.commcare.dalvik',
      ]),
    ).toBe('needs-personal-id');
  });

  it('returns ready for the post-register, pre-claim state (CommCareSetupActivity + Connect nav drawer items)', () => {
    // Live state after registerTestUser succeeds on a fresh AVD:
    // CommCare app slot still on first-start "Enter Code" screen, but
    // Connect nav drawer has the registered user's items. Phase 6
    // recipes (connect-login + connect-claim-opp) advance from here.
    const drawer = '<node text="ACE Test"/><node text="Opportunities"/><node text="Work History"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: ActivityRecord{... CommCareSetupActivity}', drawer, [
        'org.commcare.dalvik',
      ]),
    ).toBe('ready');
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

describe('MobileClient.restoreDeviceUserState (post-2026-05-14: always-bootstrap)', () => {
  const readyAvd = { name: 'AVD', serial: 'emulator-5554', status: 'booted' } as const;

  // The 2026-05-14 refactor dropped snapshot-load tier-1 from the heal
  // path entirely. Every dispatch runs the deterministic bootstrap:
  // pm clear Connect's app data + registerTestUser. See
  // docs/learnings/2026-05-14-demo-user-no-otp.md for the rationale.

  function makeBootstrapAvd(opts: {
    apkInstalled?: boolean;
    clearOk?: boolean;
    postRegisterReady?: boolean;
  } = {}) {
    const apkInstalled = opts.apkInstalled ?? true;
    const clearOk = opts.clearOk ?? true;
    const postRegisterReady = opts.postRegisterReady ?? true;

    return {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi
        .fn()
        .mockResolvedValue(apkInstalled ? ['org.commcare.dalvik'] : []),
      clearConnectAppData: vi.fn().mockResolvedValue(clearOk),
      getFocusedActivity: vi.fn().mockResolvedValue(
        postRegisterReady
          ? 'mResumedActivity: ActivityRecord{... OpportunitiesActivity}'
          : 'mResumedActivity: CommCareSetupActivity',
      ),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      installApk: vi.fn().mockResolvedValue({
        packageId: 'org.commcare.dalvik', versionName: '2.62.0', versionCode: 1, path: '/tmp/apk',
      }),
      saveSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD', snapshotName: 'registered-test-user', saved: true, output: 'OK',
      }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
      adbPortFromSerial: () => 5554,
      // loadSnapshot intentionally absent — the heal must never call it.
    } as any;
  }

  function makeMaestro() {
    return {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: '/tmp/', screenshots: [],
      }),
    } as any;
  }

  const bootstrapConfig = {
    apkVersion: '2.62.0',
    testUser: {
      phone: '+74260000100', phoneLocal: '4260000100', countryCode: '7',
      pin: '1234', backupCode: 'backup', name: 'ACE Test',
    },
  };

  it('always runs the deterministic bootstrap (no snapshot tier-1)', async () => {
    const avd = makeBootstrapAvd();
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
    const r = await client.ensureAvdRunning('AVD');
    // The heal NEVER calls loadSnapshot — there's no fast path anymore.
    expect(avd.loadSnapshot).toBeUndefined(); // method not even mocked
    // It DOES wipe app data + register fresh:
    expect(avd.clearConnectAppData).toHaveBeenCalledWith('AVD');
    expect(maestro.runRecipe).toHaveBeenCalled();
    expect(r.heal?.deviceUserState).toMatchObject({
      attempted: true,
      healed_via: 'local-bootstrap',
      verified_as: 'ready',
    });
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('app-data-cleared');
  });

  it('skips pm clear when APK was just freshly installed (no data to wipe)', async () => {
    const fakeApkBytes = new Uint8Array(2_000_000);
    fakeApkBytes[0] = 0x50; fakeApkBytes[1] = 0x4b; fakeApkBytes[2] = 0x03; fakeApkBytes[3] = 0x04;
    const uniqueVersion = `test-skip-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => fakeApkBytes.buffer,
    });
    const avd = makeBootstrapAvd();
    // First listPackages call (start of bootstrap): APK NOT installed.
    // Second listPackages call (post-bootstrap probe): APK present.
    avd.listPackages = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['org.commcare.dalvik']);
    const maestro = makeMaestro();
    const client = new MobileClient({
      avd, maestro, fetchImpl,
      bootstrapConfig: { ...bootstrapConfig, apkVersion: uniqueVersion },
    });
    const r = await client.ensureAvdRunning('AVD');
    expect(avd.installApk).toHaveBeenCalledTimes(1);
    // pm clear is skipped — the fresh install IS clean state.
    expect(avd.clearConnectAppData).not.toHaveBeenCalled();
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('apk-installed');
    expect(r.heal?.deviceUserState?.bootstrap_steps).not.toContain('app-data-cleared');
  });

  it('throws when bootstrapConfig is absent', async () => {
    const avd = makeBootstrapAvd();
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig: null });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*bootstrapConfig:absent/,
    );
  });

  it('throws with verify class when bootstrap completes but post-probe still wiped', async () => {
    const avd = makeBootstrapAvd({ postRegisterReady: false });
    avd.captureUiDump = vi
      .fn()
      .mockResolvedValue({ xml: '<node text="Logged out of PersonalID"/>', elements: [] });
    const maestro = makeMaestro();
    const client = new MobileClient({ avd, maestro, bootstrapConfig });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*needs-personal-id.*verify:needs-personal-id/,
    );
  });

  it.skip('legacy: always loads the snapshot, even when the AVD already appears ready', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi
        .fn()
        .mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
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
    expect(avd.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(avd.loadSnapshot).toHaveBeenCalledWith('AVD', 'registered-test-user');
    expect(r.heal?.deviceUserState).toMatchObject({
      classified_as: 'ready',
      attempted: true,
      healed_via: 'snapshot-load',
      verified_as: 'ready',
    });
  });

  it.skip('legacy: restores a wiped state (needs-personal-id) via loadSnapshot + verification', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi
        .fn()
        .mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
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
    // Same path as "already ready" — the contract is identical regardless
    // of starting state; the snapshot replaces RAM state deterministically.
    expect(avd.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(r.heal?.deviceUserState?.healed_via).toBe('snapshot-load');
    expect(r.heal?.deviceUserState?.verified_as).toBe('ready');
  });

  it.skip('legacy: throws snapshot-load-failed when loadSnapshot fails AND no bootstrap config available', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn(),
      captureUiDump: vi.fn(),
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
    // Explicit `bootstrapConfig: null` disables tier-2 — restores
    // pre-0.13.203 "throw immediately" behavior.
    const client = new MobileClient({ avd, maestro, bootstrapConfig: null });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*loadSnapshot:fail.*bootstrapConfig:absent/,
    );
    // The post-load probe shouldn't even fire when tier-1 load itself failed.
    expect(avd.getFocusedActivity).not.toHaveBeenCalled();
  });

  it.skip('legacy: throws when loadSnapshot throws AND no bootstrap config', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn(),
      getFocusedActivity: vi.fn(),
      captureUiDump: vi.fn(),
      loadSnapshot: vi.fn().mockRejectedValue(new Error('emulator console unavailable')),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    const client = new MobileClient({ avd, maestro, bootstrapConfig: null });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*loadSnapshot:throw.*bootstrapConfig:absent/,
    );
  });

  it.skip('legacy: tier-2: runs local bootstrap when loadSnapshot fails AND bootstrap config IS available', async () => {
    // Use a unique version string per test invocation so we never hit
    // the on-disk APK cache from a prior run/test (the cache lives at
    // `<tmp>/ace-mobile-apk-cache/commcare-<version>.apk` and persists
    // across vitest invocations by design — fine for production, just
    // needs uniqueness here).
    const uniqueVersion = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bootstrapConfig = {
      apkVersion: uniqueVersion,
      testUser: {
        phone: '+74260000100',
        phoneLocal: '4260000100',
        countryCode: '7',
        pin: '1234',
        backupCode: 'backup',
        name: 'ACE Test',
      },
    };
    // Mock fetch to skip the network APK download. Bytes start with the
    // ZIP local-file-header magic (PK\x03\x04) so they pass
    // `isApkZipMagic` — APKs are signed JARs are ZIPs.
    const fakeApkBytes = new Uint8Array(2_000_000); // > 1MB cache sanity threshold
    fakeApkBytes[0] = 0x50;
    fakeApkBytes[1] = 0x4b;
    fakeApkBytes[2] = 0x03;
    fakeApkBytes[3] = 0x04;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => fakeApkBytes.buffer,
    });
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi
        .fn()
        // First call (inside tier-2 runLocalBootstrap): APK NOT installed.
        .mockResolvedValueOnce([])
        // Second call (post-bootstrap probeDeviceUserState): APK present.
        .mockResolvedValueOnce(['org.commcare.dalvik']),
      getFocusedActivity: vi
        .fn()
        .mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      loadSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: false,
        output: 'error: snapshot does not exist',
      }),
      installApk: vi.fn().mockResolvedValue({ packageId: 'org.commcare.dalvik', versionName: '2.62.0', versionCode: 1, path: '/tmp/apk' }),
      saveSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: true,
        output: 'OK',
      }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
      adbPortFromSerial: () => 5554,
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass',
        exitCode: 0,
        stdout: 'PHONE_ALREADY_REGISTERED',
        stderr: '',
        screenshotsDir: '/tmp/',
        screenshots: [],
      }),
    } as any;
    const client = new MobileClient({ avd, maestro, bootstrapConfig, fetchImpl });
    const r = await client.ensureAvdRunning('AVD');
    // Tier-2 sequence executed:
    expect(fetchImpl).toHaveBeenCalledTimes(1); // APK download
    expect(avd.installApk).toHaveBeenCalledTimes(1);
    expect(avd.saveSnapshot).toHaveBeenCalledWith('AVD', 'registered-test-user');
    // Heal log surfaces what happened:
    expect(r.heal?.deviceUserState).toMatchObject({
      attempted: true,
      healed_via: 'local-bootstrap',
      verified_as: 'ready',
    });
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('apk-installed');
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('snapshot-saved');
  });

  it.skip('legacy: tier-2: skips APK install when already present, still registers + saves snapshot', async () => {
    const bootstrapConfig = {
      apkVersion: '2.62.0',
      testUser: {
        phone: '+74260000100',
        phoneLocal: '4260000100',
        countryCode: '7',
        pin: '1234',
        backupCode: 'backup',
        name: 'ACE Test',
      },
    };
    const fetchImpl = vi.fn(); // should NOT be called
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      // Both calls (tier-2 + post-probe) see APK installed.
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi
        .fn()
        .mockResolvedValue('mResumedActivity: ActivityRecord{... OpportunitiesActivity}'),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      loadSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: false,
        output: 'error: snapshot does not exist',
      }),
      installApk: vi.fn(),
      saveSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: true,
        output: 'OK',
      }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass',
        exitCode: 0,
        stdout: 'PHONE_ALREADY_REGISTERED',
        stderr: '',
        screenshotsDir: '/tmp/',
        screenshots: [],
      }),
    } as any;
    const client = new MobileClient({ avd, maestro, bootstrapConfig, fetchImpl });
    const r = await client.ensureAvdRunning('AVD');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(avd.installApk).not.toHaveBeenCalled();
    expect(avd.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('apk-present');
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('snapshot-saved');
  });

  it.skip('legacy: throws with the precise verify class when snapshot loads but state is still wiped AND no bootstrap config', async () => {
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
    // Disable tier-2 to confirm the throw shape includes the verify class.
    const client = new MobileClient({ avd, maestro, bootstrapConfig: null });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(
      /AVD per-user state is unhealthy.*needs-personal-id.*verify:needs-personal-id/,
    );
  });

  it.skip('legacy: tier-2 escalates when snapshot loads BUT content is stale (verify-wiped class — snapshot corruption)', async () => {
    // The bug surfaced live in turmeric run 20260513-0616 Phase 6 retry
    // on v0.13.203: snapshot existed and loadSnapshot returned saved:true,
    // but the snapshot itself had been saved at a moment when the device
    // was already PersonalID-logged-out. Pre-this-fix, restoreDeviceUserState
    // threw on verify-wiped instead of escalating to tier-2 to re-register
    // and re-snapshot.
    const bootstrapConfig = {
      apkVersion: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      testUser: {
        phone: '+74260000100',
        phoneLocal: '4260000100',
        countryCode: '7',
        pin: '1234',
        backupCode: 'backup',
        name: 'ACE Test',
      },
    };
    const fetchImpl = vi.fn(); // APK already installed, fetch shouldn't fire
    // First captureUiDump = post-load verify (stale snapshot, PersonalID drawer
    // visible). Second captureUiDump = post-bootstrap verify (ready).
    const captureUiDump = vi
      .fn()
      .mockResolvedValueOnce({ xml: '<node text="Logged out of PersonalID"/>', elements: [] })
      .mockResolvedValueOnce({ xml: '', elements: [] });
    const getFocusedActivity = vi
      .fn()
      .mockResolvedValueOnce('mResumedActivity: CommCareSetupActivity')
      .mockResolvedValueOnce('mResumedActivity: ActivityRecord{... OpportunitiesActivity}');
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity,
      captureUiDump,
      loadSnapshot: vi
        .fn()
        .mockResolvedValue({ avdName: 'AVD', snapshotName: 'registered-test-user', saved: true, output: 'OK' }),
      installApk: vi.fn(),
      saveSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: true,
        output: 'OK',
      }),
      setGmsEnabled: vi.fn().mockResolvedValue(undefined),
    disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass',
        exitCode: 0,
        stdout: 'PHONE_ALREADY_REGISTERED',
        stderr: '',
        screenshotsDir: '/tmp/',
        screenshots: [],
      }),
    } as any;
    const client = new MobileClient({ avd, maestro, bootstrapConfig, fetchImpl });
    const r = await client.ensureAvdRunning('AVD');
    // Tier-1 fired (loadSnapshot succeeded) but verify caught the stale
    // content → escalated to tier-2 which re-registered + re-saved.
    expect(avd.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(avd.saveSnapshot).toHaveBeenCalledWith('AVD', 'registered-test-user');
    expect(r.heal?.deviceUserState).toMatchObject({
      attempted: true,
      healed_via: 'local-bootstrap',
      verified_as: 'ready',
    });
    expect(r.heal?.deviceUserState?.bootstrap_steps).toContain('snapshot-saved');
  });

  it('cloud backend short-circuits (cold-boot semantics are the restore mechanism)', async () => {
    setSessionBackend('cloud');
    try {
      const cloud = {
        ensureAvdRunning: vi
          .fn()
          .mockResolvedValue({ name: 'cloud', serial: 'cloud:i-abc', status: 'booted' }),
      } as any;
      // No-op local backends — should not be touched on cloud routing.
      const avd = { loadSnapshot: vi.fn() } as any;
      const maestro = {} as any;
      const client = new MobileClient({ avd, maestro, cloud });
      const r = await client.ensureAvdRunning('cloud');
      expect(cloud.ensureAvdRunning).toHaveBeenCalledWith('cloud');
      // No local snapshot-load on cloud — cold-boot is the equivalent
      // restore mechanism (see backends/cloud.ts header).
      expect(avd.loadSnapshot).not.toHaveBeenCalled();
      expect(r.serial).toBe('cloud:i-abc');
      // Symmetric heal shape with local: callers that read
      // `result.heal.deviceUserState` on the mobile_ensure_avd_running
      // result must see the same shape across backends. Cloud populates
      // a stub so the field isn't undefined.
      expect(r.heal?.deviceUserState).toEqual({
        classified_as: 'unknown',
        attempted: false,
      });
    } finally {
      clearSessionBackend();
    }
  });
});

describe('missingBootstrapEnvVars + bootstrapConfigFromEnv', () => {
  const KEYS = [
    'ACE_CONNECT_APK_VERSION',
    'ACE_E2E_PHONE',
    'ACE_E2E_PHONE_LOCAL',
    'ACE_E2E_COUNTRY_CODE',
    'ACE_E2E_PIN',
    'ACE_E2E_BACKUP_CODE',
    'ACE_E2E_NAME',
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns ALL seven names when none are set', () => {
    expect(missingBootstrapEnvVars().sort()).toEqual([...KEYS].sort());
    expect(bootstrapConfigFromEnv()).toBeNull();
  });

  it('returns only the missing names when some are set', () => {
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    process.env.ACE_E2E_PHONE = '+74260000100';
    process.env.ACE_E2E_PHONE_LOCAL = '4260000100';
    // PIN, NAME, COUNTRY_CODE, BACKUP_CODE still missing
    expect(missingBootstrapEnvVars().sort()).toEqual(
      ['ACE_E2E_COUNTRY_CODE', 'ACE_E2E_PIN', 'ACE_E2E_BACKUP_CODE', 'ACE_E2E_NAME'].sort(),
    );
    expect(bootstrapConfigFromEnv()).toBeNull();
  });

  it('returns [] and a populated config when all seven are set', () => {
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    process.env.ACE_E2E_PHONE = '+74260000100';
    process.env.ACE_E2E_PHONE_LOCAL = '4260000100';
    process.env.ACE_E2E_COUNTRY_CODE = '7';
    process.env.ACE_E2E_PIN = '1234';
    process.env.ACE_E2E_BACKUP_CODE = 'BACKUP1';
    process.env.ACE_E2E_NAME = 'ACE Test';
    expect(missingBootstrapEnvVars()).toEqual([]);
    expect(bootstrapConfigFromEnv()).toEqual({
      apkVersion: '2.62.0',
      testUser: {
        phone: '+74260000100',
        phoneLocal: '4260000100',
        countryCode: '7',
        pin: '1234',
        backupCode: 'BACKUP1',
        name: 'ACE Test',
      },
    });
  });

  it('treats empty-string env vars the same as unset (missing)', () => {
    for (const k of KEYS) process.env[k] = 'x';
    process.env.ACE_E2E_PIN = '';
    expect(missingBootstrapEnvVars()).toEqual(['ACE_E2E_PIN']);
    expect(bootstrapConfigFromEnv()).toBeNull();
  });
});

describe('restoreDeviceUserState: bootstrapConfig-absent error names specific missing vars', () => {
  const readyAvd = { name: 'AVD', serial: 'emulator-5554', status: 'booted' } as const;
  const KEYS = [
    'ACE_CONNECT_APK_VERSION',
    'ACE_E2E_PHONE',
    'ACE_E2E_PHONE_LOCAL',
    'ACE_E2E_COUNTRY_CODE',
    'ACE_E2E_PIN',
    'ACE_E2E_BACKUP_CODE',
    'ACE_E2E_NAME',
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('enumerates the specific missing env var names when tier-1 fails and env is partial', async () => {
    // Set 6 of 7 so the failure surfaces a single name. The previous
    // "bootstrapConfig:absent" message gave an operator no signal about
    // which env var was missing — required a manual diff against .env.tpl.
    process.env.ACE_CONNECT_APK_VERSION = '2.62.0';
    process.env.ACE_E2E_PHONE = '+74260000100';
    process.env.ACE_E2E_PHONE_LOCAL = '4260000100';
    process.env.ACE_E2E_COUNTRY_CODE = '7';
    process.env.ACE_E2E_PIN = '1234';
    process.env.ACE_E2E_BACKUP_CODE = 'BACKUP1';
    // ACE_E2E_NAME intentionally omitted.
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn(),
      captureUiDump: vi.fn(),
      loadSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: false,
        output: 'snapshot does not exist',
      }),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    // Default ctor reads env — so bootstrapConfig will be null because
    // ACE_E2E_NAME is missing, but the error message must say so.
    const client = new MobileClient({ avd, maestro });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/missing env: ACE_E2E_NAME/);
  });

  it('explicit null bootstrapConfig surfaces "explicitly disabled by caller" — distinct from env-missing', async () => {
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
      getFocusedActivity: vi.fn(),
      captureUiDump: vi.fn(),
      loadSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: false,
        output: 'snapshot does not exist',
      }),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
    } as any;
    // All env vars populated → bootstrapConfigFromEnv would succeed, but
    // caller explicitly overrides to null.
    for (const k of KEYS) process.env[k] = 'x';
    const client = new MobileClient({ avd, maestro, bootstrapConfig: null });
    await expect(client.ensureAvdRunning('AVD')).rejects.toThrow(/explicitly disabled by caller/);
  });
});

describe('classifyDeviceUserState: scoped regexes reject deeply-nested false positives', () => {
  it('does NOT false-positive on "Reconfigure" appearing in a non-text attribute or deep node body', () => {
    // Pre-scoping, the regex `/Reconfigure/i` would match anywhere in
    // the XML — including a Help dialog's accessibility content or a
    // settings tooltip. Both of those are real strings CommCare could
    // surface in unrelated dialogs; the scoped regex requires the
    // string be inside `text="..."` or `content-desc="..."`.
    const dump = `<hierarchy>
      <!-- Reconfigure mentioned in a comment, NOT a UI element -->
      <node class="android.widget.HelpDialog" help-target="something Reconfigure"/>
      <node text="Welcome" />
      <node text="OK" />
    </hierarchy>`;
    expect(classifyDeviceUserState('mResumedActivity: Launcher', dump, ['org.commcare.dalvik'])).toBe(
      'unknown',
    );
  });

  it('still classifies needs-personal-id when "Reconfigure" appears in a text attribute (real wipe banner)', () => {
    const dump = '<node text="Reconfigure" resource-id="reconfigure_button"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', dump, ['org.commcare.dalvik']),
    ).toBe('needs-personal-id');
  });

  it('still classifies needs-personal-id when the wipe phrase is in content-desc (accessibility-only label)', () => {
    const dump = '<node content-desc="Logged out of PersonalID"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: CommCareSetupActivity', dump, ['org.commcare.dalvik']),
    ).toBe('needs-personal-id');
  });

  it('PersonalID-wipe banner takes precedence over positive Connect-nav signals (stacked-state real case)', () => {
    // The drawer can still show cached nav items briefly after a
    // server-side wipe lands the banner. The wipe banner must win.
    const dump =
      '<node text="Logged out of PersonalID"/><node text="Opportunities"/><node text="Work History"/>';
    expect(
      classifyDeviceUserState('mResumedActivity: HomeActivity', dump, ['org.commcare.dalvik']),
    ).toBe('needs-personal-id');
  });
});

describe('registerTestUser: tempdir lifecycle', () => {
  it('cleans up the temp registration dir on success', async () => {
    const tmpRoot = os.tmpdir();
    const before = new Set(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('ace-mobile-reg-')));
    const { avd, maestro } = fakeMaestroAndAvd({
      registerToOtp: 'pass',
      registerFromOtp: 'pass',
      otp: '123456',
    });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: '/static' });
    await client.registerTestUser({
      avdName: 'AVD',
      phone: '+74260000001',
      phoneLocal: '4260000001',
      countryCode: '+7',
      pin: '111111',
      backupCode: '222222',
      name: 'ACE Test',
    });
    const after = new Set(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('ace-mobile-reg-')));
    // The new dir created during this call must have been removed.
    const created = [...after].filter((f) => !before.has(f));
    expect(created).toEqual([]);
  });

  it('keeps the temp registration dir on failure for post-mortem', async () => {
    const tmpRoot = os.tmpdir();
    const before = new Set(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('ace-mobile-reg-')));
    const { avd, maestro } = fakeMaestroAndAvd({
      registerToOtp: 'fail', // part A fails — registration throws
      registerFromOtp: 'pass',
      otp: '123456',
    });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: '/static' });
    await expect(
      client.registerTestUser({
        avdName: 'AVD',
        phone: '+74260000001',
        phoneLocal: '4260000001',
        countryCode: '+7',
        pin: '111111',
        backupCode: '222222',
        name: 'ACE Test',
      }),
    ).rejects.toThrow(/register_test_user part A failed/);
    const after = new Set(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('ace-mobile-reg-')));
    const created = [...after].filter((f) => !before.has(f));
    // Exactly one new dir kept, for the failed call.
    expect(created.length).toBe(1);
    // Best-effort cleanup so the test itself doesn't leak.
    for (const c of created) {
      try {
        fs.rmSync(path.join(tmpRoot, c), { recursive: true, force: true });
      } catch {
        /* leave it; harmless */
      }
    }
  });
});

describe('ensureCommCareApkCached: integrity-checked cache', () => {
  // The cache lives at <os.tmpdir()>/ace-mobile-apk-cache/. We use a
  // unique APK version per assertion to avoid colliding with the real
  // cache or with other tests.
  const cacheDir = path.join(os.tmpdir(), 'ace-mobile-apk-cache');
  beforeEach(() => {
    fs.mkdirSync(cacheDir, { recursive: true });
  });

  // Helper: a 2MB byte array starting with ZIP magic.
  function fakeApkBuffer(version: string): Uint8Array {
    const buf = new Uint8Array(2_000_000);
    buf[0] = 0x50;
    buf[1] = 0x4b;
    buf[2] = 0x03;
    buf[3] = 0x04;
    // Mix the version into the body so different versions have
    // different SHAs (otherwise multiple tests would write byte-identical
    // payloads and the test wouldn't distinguish them).
    for (let i = 0; i < version.length && i < 64; i++) buf[100 + i] = version.charCodeAt(i);
    return buf;
  }

  it('downloads + writes both .apk and .sha256 sidecar on cache miss', async () => {
    const version = `test-sha-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;
    const bytes = fakeApkBuffer(version);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const avd = { listPackages: vi.fn().mockResolvedValue([]), installApk: vi.fn() } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: '+74260000100',
          phoneLocal: '4260000100',
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    // runLocalBootstrap → ensureCommCareApkCached path
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow(); // registerTestUser will fail on the no-op maestro mock — fine.

    expect(fs.existsSync(apkPath)).toBe(true);
    expect(fs.existsSync(shaPath)).toBe(true);
    const sidecarSha = fs.readFileSync(shaPath, 'utf8').trim();
    const actualSha = crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex');
    expect(sidecarSha).toBe(actualSha);

    // Cleanup so we don't pollute the cache across CI runs.
    try {
      fs.unlinkSync(apkPath);
      fs.unlinkSync(shaPath);
    } catch {
      /* leave */
    }
  });

  it('rejects a download that lacks ZIP magic (truncated or HTML error page)', async () => {
    const version = `test-bad-magic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    try {
      fs.unlinkSync(apkPath);
    } catch {
      /* fine */
    }
    // 2MB of zeros — passes size sanity check but has no ZIP magic.
    const bytes = new Uint8Array(2_000_000);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    });
    const avd = { listPackages: vi.fn().mockResolvedValue([]) } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: '+74260000100',
          phoneLocal: '4260000100',
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow(/not a valid APK \(missing ZIP magic bytes\)/);
    // Must NOT have written the bad bytes — magic-check happens before write.
    expect(fs.existsSync(apkPath)).toBe(false);
  });

  it('rejects a truncated download (under the 1MB size floor)', async () => {
    const version = `test-too-small-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bytes = new Uint8Array(500_000); // < 1MB
    bytes[0] = 0x50;
    bytes[1] = 0x4b;
    bytes[2] = 0x03;
    bytes[3] = 0x04;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    });
    const avd = { listPackages: vi.fn().mockResolvedValue([]) } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: '+74260000100',
          phoneLocal: '4260000100',
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow(/too small.*likely truncated/);
  });

  it('treats cache SHA mismatch as a miss and re-downloads (catches in-place corruption)', async () => {
    const version = `test-sha-mismatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;
    // Seed cache with bytes A but a sidecar SHA for non-A → on next
    // call the SHAs won't match → must re-download from fetchImpl.
    const seededBytes = fakeApkBuffer(version);
    fs.writeFileSync(apkPath, Buffer.from(seededBytes));
    fs.writeFileSync(shaPath, 'a'.repeat(64)); // bogus stored SHA
    // Fresh download bytes (different content via a different version
    // suffix in the body) so we can prove fetchImpl was invoked.
    const freshBytes = fakeApkBuffer(`${version}-FRESH`);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        freshBytes.buffer.slice(freshBytes.byteOffset, freshBytes.byteOffset + freshBytes.byteLength),
    });
    const avd = { listPackages: vi.fn().mockResolvedValue([]) } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: '+74260000100',
          phoneLocal: '4260000100',
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow();
    // Fetch DID fire (cache mismatch → re-download).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Sidecar now matches the fresh bytes on disk.
    const onDisk = fs.readFileSync(apkPath);
    const sidecarSha = fs.readFileSync(shaPath, 'utf8').trim();
    const actualSha = crypto.createHash('sha256').update(onDisk).digest('hex');
    expect(sidecarSha).toBe(actualSha);
    // Cleanup.
    try {
      fs.unlinkSync(apkPath);
      fs.unlinkSync(shaPath);
    } catch {
      /* leave */
    }
  });

  it('adopts a sidecar-less legacy cache entry (writes the sidecar on the fly without re-downloading)', async () => {
    const version = `test-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const apkPath = path.join(cacheDir, `commcare-${version}.apk`);
    const shaPath = `${apkPath}.sha256`;
    // Seed APK with no sidecar — simulates a cache populated by a
    // pre-sidecar version of this method.
    const legacyBytes = fakeApkBuffer(version);
    fs.writeFileSync(apkPath, Buffer.from(legacyBytes));
    try {
      fs.unlinkSync(shaPath);
    } catch {
      /* fine */
    }
    const fetchImpl = vi.fn(); // must NOT be called — adopt path
    const avd = { listPackages: vi.fn().mockResolvedValue([]) } as any;
    const maestro = {} as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: '+74260000100',
          phoneLocal: '4260000100',
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Sidecar should have been written on adoption.
    expect(fs.existsSync(shaPath)).toBe(true);
    const sidecarSha = fs.readFileSync(shaPath, 'utf8').trim();
    const actualSha = crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex');
    expect(sidecarSha).toBe(actualSha);
    // Cleanup.
    try {
      fs.unlinkSync(apkPath);
      fs.unlinkSync(shaPath);
    } catch {
      /* leave */
    }
  });
});

describe('runLocalBootstrap: SNAPSHOT_SAVE_FAILED surfaces "registered but not persisted"', () => {
  const readyAvd = { name: 'AVD', serial: 'emulator-5554', status: 'booted' } as const;

  it('error message tells the operator: device is usable for this dispatch; just re-save next time', async () => {
    const version = `test-save-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bytes = new Uint8Array(2_000_000);
    bytes[0] = 0x50;
    bytes[1] = 0x4b;
    bytes[2] = 0x03;
    bytes[3] = 0x04;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    });
    const avd = {
      ensureAvdRunning: vi.fn().mockResolvedValue(readyAvd),
      listPackages: vi.fn().mockResolvedValue([]),
      getFocusedActivity: vi.fn(),
      captureUiDump: vi.fn().mockResolvedValue({ xml: '', elements: [] }),
      loadSnapshot: vi.fn(),
      installApk: vi.fn().mockResolvedValue({
        packageId: 'org.commcare.dalvik',
        versionName: version,
        versionCode: 1,
        path: '/tmp/apk',
      }),
      // KEY: saveSnapshot REPORTS failure — register succeeded, but persist did not.
      saveSnapshot: vi.fn().mockResolvedValue({
        avdName: 'AVD',
        snapshotName: 'registered-test-user',
        saved: false,
        output: 'disk full',
      }),
      setGmsEnabled: vi.fn(),
      disableHeadsUpNotifications: vi.fn().mockResolvedValue(undefined),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('abc123def456'),
    } as any;
    const maestro = {
      probeDriver: vi.fn().mockResolvedValue({ healthy: true }),
      repairDriver: vi.fn(),
      runRecipe: vi.fn().mockResolvedValue({
        status: 'pass',
        exitCode: 0,
        stdout: 'PHONE_ALREADY_REGISTERED',
        stderr: '',
        screenshotsDir: '/tmp/',
        screenshots: [],
      }),
    } as any;
    const client = new MobileClient({
      avd,
      maestro,
      fetchImpl,
      bootstrapConfig: {
        apkVersion: version,
        testUser: {
          phone: '+74260000100',
          phoneLocal: '4260000100',
          countryCode: '7',
          pin: '1234',
          backupCode: 'b',
          name: 'n',
        },
      },
    });
    await expect(
      client.runLocalBootstrap({ name: 'AVD', serial: 'emulator-5554', status: 'booted' } as any),
    ).rejects.toThrow(/device IS registered and usable for this dispatch/);
  });
});
