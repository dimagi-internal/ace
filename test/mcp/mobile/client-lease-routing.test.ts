// MobileClient routes to the lease backend when ACE_MOBILE_BACKEND=lease (or
// the deprecated `cloud` alias): the lease registers live every time (its
// machine is fresh from the image), honours a per-run test-user override, and
// supports set_location.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';
import { TEST_PHONE, TEST_PHONE_LOCAL } from '../../fixtures/test-phone.js';

const ENV_TEST_USER = {
  phone: TEST_PHONE,
  phoneLocal: TEST_PHONE_LOCAL,
  countryCode: '+7',
  pin: '1234',
  backupCode: '123456789012',
  name: 'ACE Test',
};

function fakeLease() {
  return {
    ensureAvdRunning: vi.fn().mockResolvedValue({ name: 'cc-2.63.0', serial: 'lease:i-1', status: 'booted' }),
    clearAppData: vi.fn().mockResolvedValue(true),
    registerTestUser: vi.fn().mockResolvedValue({ alreadyRegistered: false, phone: TEST_PHONE }),
    setLocation: vi.fn().mockResolvedValue({ applied: true }),
    diagnose: vi.fn().mockResolvedValue({ lease: null, note: 'none' }),
    stopAvd: vi.fn().mockResolvedValue(undefined),
    listAvds: vi.fn().mockResolvedValue(['cc-2.62.0', 'cc-2.63.0']),
  };
}

function makeClient(lease: ReturnType<typeof fakeLease> | null = fakeLease()) {
  const avd: any = { ensureAvdRunning: vi.fn(), setLocation: vi.fn(), diagnose: vi.fn() };
  const client = new MobileClient({
    avd,
    lease: lease as any,
    bootstrapConfig: { apkVersion: '2.63.2', testUser: ENV_TEST_USER } as any,
  });
  return { client, avd, lease };
}

describe('MobileClient on the lease backend', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'lease';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = prev;
  });

  it('useLease is true; nothing reaches local', async () => {
    const { client, avd, lease } = makeClient();
    expect(client.useLease).toBe(true);
    await client.stopAvd('x');
    expect(await client.listAvds()).toEqual(['cc-2.62.0', 'cc-2.63.0']);
    expect(lease!.stopAvd).toHaveBeenCalled();
    expect(avd.ensureAvdRunning).not.toHaveBeenCalled();
  });

  it('ensureAvdRunning acquires, then ALWAYS live-registers', async () => {
    {
      const { client, lease } = makeClient();
      const info = await client.ensureAvdRunning('cc-2.63.0');
      expect(lease!.ensureAvdRunning).toHaveBeenCalledWith('cc-2.63.0');
      expect(lease!.clearAppData).toHaveBeenCalledWith('org.commcare.dalvik');
      expect(lease!.registerTestUser).toHaveBeenCalledTimes(1);
      const reg = lease!.registerTestUser.mock.calls[0][0];
      expect(reg.phone).toBe(TEST_PHONE);
      expect(reg.toOtpRecipe).toBe('connect-register-to-otp.yaml');
      expect(reg.paletteTarB64.length).toBeGreaterThan(0);
      expect(info.heal?.deviceUserState).toMatchObject({
        healed_via: 'lease-bootstrap',
        bootstrap_steps: ['app-data-cleared', 'registered-unverified'],
      });
    }
  });

  it('honours a per-run test-user override', async () => {
    const { client, lease } = makeClient();
    await client.ensureAvdRunning('cc-2.63.0', { testUser: { phone: '+74269990001', name: 'Run User' } });
    const reg = lease!.registerTestUser.mock.calls[0][0];
    expect(reg.phone).toBe('+74269990001');
    expect(reg.name).toBe('Run User');
    expect(reg.pin).toBe(ENV_TEST_USER.pin);
  });

  it('set_location routes to the lease', async () => {
    const { client, lease } = makeClient();
    await client.setLocation('x', 36.8, -1.3);
    expect(lease!.setLocation).toHaveBeenCalledWith('x', 36.8, -1.3, undefined, undefined);
  });

  it('diagnose is tagged backend: lease', async () => {
    const { client } = makeClient();
    expect(await client.diagnose()).toMatchObject({ backend: 'lease', lease: null });
  });

  it('a missing PAT fails loud with LEASE_NOT_CONFIGURED before any boot', async () => {
    const { client, avd } = makeClient(null);
    await expect(client.ensureAvdRunning('cc-2.63.0')).rejects.toMatchObject({ code: 'LEASE_NOT_CONFIGURED' });
    expect(avd.ensureAvdRunning).not.toHaveBeenCalled();
  });
});

describe('MobileClient on the deprecated cloud alias routes to the lease', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ACE_MOBILE_BACKEND;
    process.env.ACE_MOBILE_BACKEND = 'cloud';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ACE_MOBILE_BACKEND;
    else process.env.ACE_MOBILE_BACKEND = prev;
  });

  it('useLease is true and set_location reaches the lease', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client, lease } = makeClient();
      expect(client.useLease).toBe(true);
      await client.setLocation('x', 1, 2);
      expect(lease!.setLocation).toHaveBeenCalledWith('x', 1, 2, undefined, undefined);
    } finally {
      warn.mockRestore();
    }
  });
});
