import { spawn } from 'node:child_process';
import { AvdBootError, AdbError } from '../errors.js';
import type { AvdInfo, ApkInfo, UiDumpResult } from '../types.js';

const AVD_BOOT_TIMEOUT_MS = 120_000;
const AVD_BOOT_POLL_MS = 2_000;

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ShellFn = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ShellResult>;

export const defaultShell: ShellFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`shell timeout: ${cmd} ${args.join(' ')}`));
        }, opts.timeoutMs)
      : null;
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
  });

export interface AvdBackendOpts {
  shell?: ShellFn;
}

export class AvdBackend {
  private shell: ShellFn;
  constructor(opts: AvdBackendOpts = {}) {
    this.shell = opts.shell ?? defaultShell;
  }

  async listAvds(): Promise<string[]> {
    const r = await this.shell('emulator', ['-list-avds']);
    return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  async ensureAvdRunning(avdName: string): Promise<AvdInfo> {
    const existing = await this.findRunningAvd(avdName);
    if (existing) return existing;

    const known = await this.listAvds();
    if (!known.includes(avdName)) {
      throw new AvdBootError(avdName, `AVD '${avdName}' not in emulator -list-avds output`);
    }

    // Boot in detached background process; do NOT await it.
    const child = spawn('emulator', ['-avd', avdName, '-no-window', '-no-snapshot-save'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const start = Date.now();
    while (Date.now() - start < AVD_BOOT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, AVD_BOOT_POLL_MS));
      const found = await this.findRunningAvd(avdName);
      if (found) {
        return { ...found, bootTimeMs: Date.now() - start };
      }
    }
    throw new AvdBootError(avdName, `boot timeout after ${AVD_BOOT_TIMEOUT_MS}ms`);
  }

  async stopAvd(avdName: string): Promise<void> {
    const found = await this.findRunningAvd(avdName);
    if (!found) return;
    await this.shell('adb', ['-s', found.serial, 'emu', 'kill']);
  }

  async installApk(avdName: string, apkPath: string): Promise<ApkInfo> {
    const avd = await this.ensureAvdRunning(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'install', '-r', apkPath]);
    if (r.exitCode !== 0 || !r.stdout.includes('Success')) {
      throw new AdbError('install', r.exitCode, r.stderr || r.stdout);
    }
    return this.parseApkInfo(apkPath);
  }

  async uninstallApk(avdName: string, packageId: string): Promise<{ uninstalled: boolean }> {
    const avd = await this.ensureAvdRunning(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'uninstall', packageId]);
    return { uninstalled: r.stdout.includes('Success') };
  }

  private async parseApkInfo(apkPath: string): Promise<ApkInfo> {
    const r = await this.shell('aapt', ['dump', 'badging', apkPath]);
    const m = r.stdout.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
    if (!m) throw new AdbError('aapt', 0, `could not parse apk metadata for ${apkPath}`);
    return { packageId: m[1], versionCode: parseInt(m[2], 10), versionName: m[3], path: apkPath };
  }

  private async findRunningAvd(avdName: string): Promise<AvdInfo | null> {
    const devices = await this.shell('adb', ['devices']);
    const serials = devices.stdout
      .split('\n')
      .slice(1)
      .map((line) => line.split('\t')[0].trim())
      .filter((s) => s.startsWith('emulator-'));

    for (const serial of serials) {
      const r = await this.shell('adb', ['-s', serial, 'emu', 'avd', 'name']);
      const name = r.stdout.split('\n')[0].trim();
      if (name === avdName) return { name, serial, status: 'booted' };
    }
    return null;
  }

  async captureUiDump(avdName: string): Promise<UiDumpResult> {
    const avd = await this.ensureAvdRunning(avdName);
    await this.shell('adb', ['-s', avd.serial, 'shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
    const xmlR = await this.shell('adb', ['-s', avd.serial, 'exec-out', 'cat', '/sdcard/window_dump.xml']);
    return { xml: xmlR.stdout, elements: this.parseHierarchy(xmlR.stdout) };
  }

  private parseHierarchy(xml: string): UiDumpResult['elements'] {
    const out: UiDumpResult['elements'] = [];
    const nodeRe = /<node\s+([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(xml)) !== null) {
      const attrs = m[1];
      const get = (k: string) => {
        const am = attrs.match(new RegExp(`${k}="([^"]*)"`));
        return am ? am[1] : undefined;
      };
      out.push({
        id: get('resource-id') || undefined,
        text: get('text') || undefined,
        class: get('class') || undefined,
        bounds: get('bounds') || undefined,
      });
    }
    return out;
  }
}
