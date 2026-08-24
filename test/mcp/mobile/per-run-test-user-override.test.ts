/**
 * dimagi-internal/ace#1289 — optional per-run test-user credential override on
 * `mobile_ensure_avd_running` / `MobileClient.runLocalBootstrap`.
 *
 * The whole safety argument for shipping this before the camera-id calibration
 * is that it is **inert while `ACE_PER_RUN_TEST_USER` is off**. Off means no
 * caller passes `opts`, so the load-bearing assertion is the first one below:
 * with `opts` omitted, the credentials handed to registration are the
 * env-derived object ITSELF — same reference, not merely a deep-equal copy.
 * A reference check is what makes "byte-identical" testable rather than
 * asserted.
 */
import { describe, it, expect, vi } from 'vitest';

import { MobileClient, mergeTestUserOverride } from '../../../mcp/mobile/client.js';
import { TEST_PHONE, TEST_PHONE_LOCAL } from '../../fixtures/test-phone.js';
import { derivePerRunTestUser } from '../../../lib/per-run-test-user.js';

const AVD = { name: 'AVD', serial: 'emulator-5554', status: 'booted' as const };
const VALIDATED = 'NetworkAgentInfo{ Capabilities: INTERNET VALIDATED NOT_METERED }';

const ENV_TEST_USER = {
  phone: TEST_PHONE,
  phoneLocal: TEST_PHONE_LOCAL,
  countryCode: '+7',
  pin: '1234',
  backupCode: '123456789012',
  name: 'ACE Test',
};

function makeClient() {
  const shell = vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes('connectivity')) return { stdout: VALIDATED, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const avd: any = {
    getAdbShell: () => shell,
    listPackages: vi.fn().mockResolvedValue(['org.commcare.dalvik']),
    clearConnectAppData: vi.fn().mockResolvedValue(true),
    applyEnvironmentBaseline: vi.fn().mockResolvedValue('fp'),
    getFocusedActivity: vi.fn().mockResolvedValue(''),
    captureUiDump: vi.fn().mockResolvedValue(''),
  };
  const client = new MobileClient({
    avd,
    bootstrapConfig: { apkVersion: '2.63.2', testUser: ENV_TEST_USER } as any,
  });
  const registerTestUser = vi.fn().mockResolvedValue({ alreadyRegistered: false });
  (client as any).registerTestUser = registerTestUser;
  (client as any).probeDeviceUserState = vi
    .fn()
    .mockResolvedValue({ classified_as: 'ready', focused_activity: '', ui_dump_signal: undefined });
  return { client, registerTestUser };
}

describe('mergeTestUserOverride — inert without an override', () => {
  it('returns the base object BY REFERENCE when no override is given', () => {
    expect(mergeTestUserOverride(ENV_TEST_USER)).toBe(ENV_TEST_USER);
    expect(mergeTestUserOverride(ENV_TEST_USER, undefined)).toBe(ENV_TEST_USER);
  });

  it('overrides only the keys supplied, leaving the rest env-derived', () => {
    const merged = mergeTestUserOverride(ENV_TEST_USER, { phone: '+74263120415', name: 'Run User' });
    expect(merged.phone).toBe('+74263120415');
    expect(merged.name).toBe('Run User');
    expect(merged.pin).toBe(ENV_TEST_USER.pin);
    expect(merged.backupCode).toBe(ENV_TEST_USER.backupCode);
    expect(merged.phoneLocal).toBe(ENV_TEST_USER.phoneLocal);
  });

  it('ignores empty strings — an unset env var read by a caller must not blank a credential', () => {
    const merged = mergeTestUserOverride(ENV_TEST_USER, { phone: '', pin: '' });
    expect(merged.phone).toBe(ENV_TEST_USER.phone);
    expect(merged.pin).toBe(ENV_TEST_USER.pin);
  });

  it('never mutates the base object', () => {
    const snapshot = { ...ENV_TEST_USER };
    mergeTestUserOverride(ENV_TEST_USER, { phone: '+74269999999' });
    expect(ENV_TEST_USER).toEqual(snapshot);
  });
});

describe('runLocalBootstrap — the switch-off path is byte-identical', () => {
  it('registers the env-derived user when no override is passed', async () => {
    const { client, registerTestUser } = makeClient();
    await (client as any).runLocalBootstrap(AVD);
    expect(registerTestUser).toHaveBeenCalledWith({ avdName: 'AVD', ...ENV_TEST_USER });
  });

  it('registers the env-derived user when opts is present but carries no testUser', async () => {
    const { client, registerTestUser } = makeClient();
    await (client as any).runLocalBootstrap(AVD, {});
    expect(registerTestUser).toHaveBeenCalledWith({ avdName: 'AVD', ...ENV_TEST_USER });
  });
});

describe('runLocalBootstrap — the switch-on path registers the minted user', () => {
  it('registers the per-run phone, keeping the env pin + backup code', async () => {
    const { client, registerTestUser } = makeClient();
    const perRun = derivePerRunTestUser('20260823-1412');
    await (client as any).runLocalBootstrap(AVD, { testUser: perRun });
    expect(registerTestUser).toHaveBeenCalledWith({
      avdName: 'AVD',
      phone: perRun.phone,
      phoneLocal: perRun.phoneLocal,
      countryCode: perRun.countryCode,
      name: perRun.name,
      pin: ENV_TEST_USER.pin,
      backupCode: ENV_TEST_USER.backupCode,
    });
    // The number that reaches the device still carries the demo prefix — losing
    // it converts a demo registration into a real one (SMS OTP that never
    // arrives + Play Integrity rejection on an emulator).
    expect(registerTestUser.mock.calls[0][0].phone.startsWith('+7426')).toBe(true);
  });

  it('threads the override from ensureAvdRunning through restoreDeviceUserState', async () => {
    const { client, registerTestUser } = makeClient();
    const perRun = derivePerRunTestUser('20260702-1456');
    await client.restoreDeviceUserState(AVD as any, { testUser: perRun });
    expect(registerTestUser.mock.calls[0][0].phone).toBe(perRun.phone);
  });

  it('restoreDeviceUserState without opts still registers the env user', async () => {
    const { client, registerTestUser } = makeClient();
    await client.restoreDeviceUserState(AVD as any);
    expect(registerTestUser.mock.calls[0][0].phone).toBe(ENV_TEST_USER.phone);
  });
});

describe('cloud backend is explicitly OUT OF SCOPE and fails loud', () => {
  it('throws rather than silently registering the env user under a per-run caller', async () => {
    const { client } = makeClient();
    // Route to cloud without touching the real toggle plumbing.
    Object.defineProperty(client, 'useCloud', { get: () => true });
    (client as any).cloud = { ensureAvdRunning: vi.fn() };
    await expect(
      client.ensureAvdRunning('AVD', { testUser: derivePerRunTestUser('20260823-1412') }),
    ).rejects.toThrow(/not supported on the cloud backend/);
  });
});
