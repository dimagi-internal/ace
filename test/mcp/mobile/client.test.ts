import { describe, it, expect, vi } from 'vitest';
import { MobileClient } from '../../../mcp/mobile/client.js';

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
  it('runs to-otp, fetches OTP, runs from-otp, returns success', async () => {
    const { avd, maestro } = fakeMaestroAndAvd({ registerToOtp: 'pass', registerFromOtp: 'pass', otp: '123456' });
    const client = new MobileClient({ avd, maestro, staticRecipesDir: '/static', playwrightUserDataDir: '/ud' });
    (client as any).fetchOtp = vi.fn().mockResolvedValue({ phone: '+74260000001', otp: '123456', fetchedAt: 't' });

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
    const client = new MobileClient({ avd, maestro, staticRecipesDir: '/static', playwrightUserDataDir: '/ud' });
    (client as any).fetchOtp = vi.fn().mockResolvedValue({ phone: '+74260000001', otp: '123456', fetchedAt: 't' });

    const r = await client.registerTestUser({
      avdName: 'AVD', phone: '+74260000001', phoneLocal: '4260000001', countryCode: '+7',
      pin: '111111', backupCode: '222222', name: 'ACE Test',
    });
    expect(r.alreadyRegistered).toBe(true);
  });
});
