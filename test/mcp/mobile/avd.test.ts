import { describe, it, expect, vi } from 'vitest';
import { AvdBackend } from '../../../mcp/mobile/backends/avd.js';

function fakeShell(scripted: Record<string, { stdout: string; stderr?: string; code?: number }>) {
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    const r = scripted[key];
    if (!r) throw new Error(`Unscripted shell call: ${key}`);
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.code ?? 0 };
  });
}

import { AvdBootError } from '../../../mcp/mobile/errors.js';

describe('AvdBackend.listAvds', () => {
  it('parses emulator -list-avds output', async () => {
    const shell = fakeShell({
      'emulator -list-avds': { stdout: 'ACE_Pixel_API_34\nOther_AVD\n' },
    });
    const backend = new AvdBackend({ shell });
    const result = await backend.listAvds();
    expect(result).toEqual(['ACE_Pixel_API_34', 'Other_AVD']);
  });

  it('returns empty array when no AVDs', async () => {
    const shell = fakeShell({ 'emulator -list-avds': { stdout: '' } });
    const backend = new AvdBackend({ shell });
    expect(await backend.listAvds()).toEqual([]);
  });
});

describe('AvdBackend.ensureAvdRunning', () => {
  it('returns existing serial if AVD already booted', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
    });
    const backend = new AvdBackend({ shell });
    const info = await backend.ensureAvdRunning('ACE_Pixel_API_34');
    expect(info).toMatchObject({ name: 'ACE_Pixel_API_34', serial: 'emulator-5554', status: 'booted' });
  });

  it('throws AvdBootError if AVD does not exist', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\n' },
      'emulator -list-avds': { stdout: 'Other_AVD\n' },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.ensureAvdRunning('ACE_Pixel_API_34')).rejects.toBeInstanceOf(AvdBootError);
  });
});

describe('AvdBackend.stopAvd', () => {
  it('shells adb emu kill against the matching device', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu kill': { stdout: '' },
    });
    const backend = new AvdBackend({ shell });
    await backend.stopAvd('ACE_Pixel_API_34');
    expect(shell).toHaveBeenCalledWith('adb', ['-s', 'emulator-5554', 'emu', 'kill']);
  });
});

describe('AvdBackend.installApk', () => {
  it('shells adb install -r and parses package info via aapt', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 install -r /tmp/foo.apk': { stdout: 'Performing Streamed Install\nSuccess\n' },
      'aapt dump badging /tmp/foo.apk': {
        stdout: `package: name='org.commcare.dalvik' versionCode='2550' versionName='2.55'\n`,
      },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.installApk('ACE_Pixel_API_34', '/tmp/foo.apk');
    expect(r).toEqual({
      packageId: 'org.commcare.dalvik',
      versionName: '2.55',
      versionCode: 2550,
      path: '/tmp/foo.apk',
    });
  });
});
