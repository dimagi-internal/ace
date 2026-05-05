import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

describe('AvdBackend.ensureFrontCameraEmulated', () => {
  let tmpAvdHome: string;
  let oldEnv: string | undefined;

  beforeEach(() => {
    tmpAvdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-test-'));
    oldEnv = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_AVD_HOME = tmpAvdHome;
  });
  afterEach(() => {
    if (oldEnv === undefined) delete process.env.ANDROID_AVD_HOME;
    else process.env.ANDROID_AVD_HOME = oldEnv;
    fs.rmSync(tmpAvdHome, { recursive: true, force: true });
  });

  function writeConfig(name: string, contents: string) {
    const dir = path.join(tmpAvdHome, `${name}.avd`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.ini'), contents);
  }

  function readConfig(name: string): string {
    return fs.readFileSync(path.join(tmpAvdHome, `${name}.avd`, 'config.ini'), 'utf8');
  }

  it('rewrites hw.camera.front=none to emulated', () => {
    writeConfig('AvdA', 'hw.camera.back=emulated\nhw.camera.front=none\nhw.gps=yes\n');
    const backend = new AvdBackend();
    expect(backend.ensureFrontCameraEmulated('AvdA')).toBe(true);
    expect(readConfig('AvdA')).toContain('hw.camera.front=emulated');
    expect(readConfig('AvdA')).not.toContain('hw.camera.front=none');
  });

  it('appends hw.camera.front=emulated when key missing', () => {
    writeConfig('AvdB', 'hw.camera.back=emulated\nhw.gps=yes\n');
    const backend = new AvdBackend();
    expect(backend.ensureFrontCameraEmulated('AvdB')).toBe(true);
    expect(readConfig('AvdB')).toMatch(/hw\.camera\.front=emulated\s*$/);
  });

  it('is a no-op when already set to emulated (idempotent)', () => {
    writeConfig('AvdC', 'hw.camera.front=emulated\n');
    const backend = new AvdBackend();
    expect(backend.ensureFrontCameraEmulated('AvdC')).toBe(false);
    // Original content preserved.
    expect(readConfig('AvdC')).toBe('hw.camera.front=emulated\n');
  });

  it('returns false when config.ini does not exist', () => {
    const backend = new AvdBackend();
    expect(backend.ensureFrontCameraEmulated('NonexistentAvd')).toBe(false);
  });
});

describe('AvdBackend.saveSnapshot / loadSnapshot', () => {
  it('shells adb emu avd snapshot save', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu avd snapshot save registered_user': { stdout: 'OK\n' },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.saveSnapshot('ACE_Pixel_API_34', 'registered_user');
    expect(r).toMatchObject({
      avdName: 'ACE_Pixel_API_34',
      snapshotName: 'registered_user',
      saved: true,
    });
  });

  it('shells adb emu avd snapshot load', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu avd snapshot load registered_user': { stdout: 'OK\n' },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.loadSnapshot('ACE_Pixel_API_34', 'registered_user');
    expect(r.saved).toBe(true);
  });

  it('reports saved=false when adb prints an error', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 emu avd snapshot load missing': {
        stdout: 'KO: error: snapshot not found\n',
      },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.loadSnapshot('ACE_Pixel_API_34', 'missing');
    expect(r.saved).toBe(false);
  });
});

describe('AvdBackend.captureUiDump', () => {
  it('runs uiautomator dump, pulls XML, parses elements', async () => {
    const xml = `<hierarchy><node resource-id="login_btn" text="Sign in" class="android.widget.Button" bounds="[0,0][100,50]"/></hierarchy>`;
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 shell uiautomator dump /data/local/tmp/window_dump.xml': { stdout: 'UI hierarchy dumped\n' },
      'adb -s emulator-5554 exec-out cat /data/local/tmp/window_dump.xml': { stdout: xml },
    });
    const backend = new AvdBackend({ shell });
    const r = await backend.captureUiDump('ACE_Pixel_API_34');
    expect(r.xml).toBe(xml);
    expect(r.elements).toContainEqual(
      expect.objectContaining({ id: 'login_btn', text: 'Sign in', class: 'android.widget.Button' }),
    );
  });
});

describe('AvdBackend.adbPortFromSerial', () => {
  it('derives the adbd port for a standard emulator serial', () => {
    expect(AvdBackend.adbPortFromSerial('emulator-5554')).toBe(5555);
    expect(AvdBackend.adbPortFromSerial('emulator-5558')).toBe(5559);
  });

  it('returns null for non-emulator serials', () => {
    expect(AvdBackend.adbPortFromSerial('127.0.0.1:5555')).toBeNull();
    expect(AvdBackend.adbPortFromSerial('R5CMA0BARRP')).toBeNull();
    expect(AvdBackend.adbPortFromSerial('')).toBeNull();
  });
});

describe('AvdBackend.setGmsEnabled', () => {
  it('runs `pm enable` against the matching device when enabled=true', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 shell pm enable com.google.android.gms': {
        stdout: 'Package com.google.android.gms new state: enabled\n',
      },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.setGmsEnabled('ACE_Pixel_API_34', true)).resolves.toBeUndefined();
  });

  it('runs `pm disable-user --user 0` when enabled=false', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
      'adb -s emulator-5554 emu avd name': { stdout: 'ACE_Pixel_API_34\nOK\n' },
      'adb -s emulator-5554 shell pm disable-user --user 0 com.google.android.gms': {
        stdout: 'Package com.google.android.gms new state: disabled-user\n',
      },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.setGmsEnabled('ACE_Pixel_API_34', false)).resolves.toBeUndefined();
  });

  it('is a no-op when the AVD is not running', async () => {
    const shell = fakeShell({
      'adb devices': { stdout: 'List of devices attached\n' },
    });
    const backend = new AvdBackend({ shell });
    await expect(backend.setGmsEnabled('ACE_Pixel_API_34', true)).resolves.toBeUndefined();
  });
});
