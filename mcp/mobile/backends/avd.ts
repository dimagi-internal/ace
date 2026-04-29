import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AvdBootError, AdbError } from '../errors.js';
import type { AvdInfo, ApkInfo, UiDumpResult, SnapshotResult } from '../types.js';

const AVD_BOOT_TIMEOUT_MS = 120_000;
const AVD_BOOT_POLL_MS = 2_000;

/**
 * Where AVDs live on disk, per platform.
 *
 * The convention: `$ANDROID_AVD_HOME` if set, else `$ANDROID_SDK_HOME/.android/avd`,
 * else `~/.android/avd` (the default Android Studio drops them in on every OS).
 * This path is the same on macOS, Linux, and Windows under WSL2; on native
 * Windows it's `%USERPROFILE%\.android\avd\`, which Node's path APIs handle
 * transparently via `os.homedir()`.
 */
function avdHomeDir(): string {
  if (process.env.ANDROID_AVD_HOME) return process.env.ANDROID_AVD_HOME;
  if (process.env.ANDROID_SDK_HOME) return path.join(process.env.ANDROID_SDK_HOME, '.android', 'avd');
  return path.join(os.homedir(), '.android', 'avd');
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ShellFn = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ShellResult>;

/**
 * Resolve a `JAVA_HOME` for the current platform if the user hasn't already
 * exported one. Maestro and avdmanager both need a JDK 17+ on the path; the
 * common operator stumbling block on a fresh shell is that `which java`
 * resolves to the macOS stub at `/usr/bin/java` which prints
 * "Unable to locate a Java Runtime" because no JDK is installed at the
 * system path.
 *
 * Resolution order:
 *   1. `JAVA_HOME` from process env (operator/CI override wins)
 *   2. `/usr/libexec/java_home` (macOS only — picks the highest version)
 *   3. Homebrew prefix on Apple Silicon (`/opt/homebrew/opt/openjdk@17`)
 *   4. Homebrew prefix on Intel Mac (`/usr/local/opt/openjdk@17`)
 *   5. Common Linux paths (`/usr/lib/jvm/java-17-openjdk*`)
 *   6. Windows: `%ProgramFiles%\Eclipse Adoptium\jdk-17.*` glob
 *
 * Returns the resolved path or `null` if nothing matched. The caller adds
 * `<JAVA_HOME>/bin` to PATH before spawning.
 */
function resolveJavaHome(): string | null {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;

  // macOS: java_home is bundled with every macOS build, even without a JDK.
  if (process.platform === 'darwin') {
    try {
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      const out = execSync('/usr/libexec/java_home -v 17 2>/dev/null', { encoding: 'utf8' }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch { /* fall through */ }
    for (const candidate of [
      '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
      '/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } else if (process.platform === 'linux') {
    for (const candidate of [
      '/usr/lib/jvm/java-17-openjdk-amd64',
      '/usr/lib/jvm/java-17-openjdk-arm64',
      '/usr/lib/jvm/temurin-17-jdk',
      '/usr/lib/jvm/default-java',
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } else if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    for (const dir of [
      path.join(pf, 'Eclipse Adoptium'),
      path.join(pf, 'Java'),
    ]) {
      if (!fs.existsSync(dir)) continue;
      const matches = fs.readdirSync(dir).filter((n) => /jdk-?17/i.test(n));
      if (matches.length) return path.join(dir, matches[0]);
    }
  }
  return null;
}

/**
 * Build a child-process env that includes a resolved JAVA_HOME and a PATH
 * that contains its bin/. Used by every shell call so maestro/avdmanager
 * Just Work even from a fresh non-login shell.
 */
function shellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const javaHome = resolveJavaHome();
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    const sep = process.platform === 'win32' ? ';' : ':';
    const javaBin = path.join(javaHome, 'bin');
    if (!env.PATH || !env.PATH.split(sep).includes(javaBin)) {
      env.PATH = `${javaBin}${sep}${env.PATH ?? ''}`;
    }
  }
  return env;
}

export const defaultShell: ShellFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: shellEnv() });
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

    // Patch the AVD config to ensure a front camera is available before boot.
    // CommCare's photo capture step uses CameraX with LENS_FACING_FRONT; the
    // default Pixel 7 template ships hw.camera.front=none, which makes the
    // selfie step silently no-op (CameraX validation fails). Idempotent.
    this.ensureFrontCameraEmulated(avdName);

    // Boot in detached background process; do NOT await it.
    const child = spawn('emulator', ['-avd', avdName, '-no-window', '-no-snapshot-save'], {
      detached: true,
      stdio: 'ignore',
      env: shellEnv(),
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

  /**
   * Ensure `hw.camera.front=emulated` in the AVD's config.ini.
   *
   * Idempotent: returns true if a write happened (i.e., a cold boot is needed
   * to pick the change up — which `emulator -no-snapshot-load` would handle,
   * but `ensureAvdRunning` doesn't pass that flag yet, so callers should
   * `mobile_stop_avd` + cold-boot when this returns true on a running AVD).
   *
   * Returns false if the file already declared an emulated front camera or
   * if the config file doesn't exist (newly-created AVDs may take a beat).
   */
  ensureFrontCameraEmulated(avdName: string): boolean {
    const cfg = path.join(avdHomeDir(), `${avdName}.avd`, 'config.ini');
    if (!fs.existsSync(cfg)) return false;
    const content = fs.readFileSync(cfg, 'utf8');
    if (/^\s*hw\.camera\.front\s*=\s*emulated\s*$/m.test(content)) return false;

    let next: string;
    if (/^\s*hw\.camera\.front\s*=/m.test(content)) {
      next = content.replace(/^\s*hw\.camera\.front\s*=.*$/m, 'hw.camera.front=emulated');
    } else {
      next = content.replace(/\n*$/, '\n') + 'hw.camera.front=emulated\n';
    }
    fs.writeFileSync(cfg, next);
    return true;
  }

  /**
   * Save the current state of a running AVD as a named snapshot. The snapshot
   * lives under `<AVD home>/<avd>.avd/snapshots/<name>/` and can be restored
   * later via `loadSnapshot`. Useful for "register the test user once, then
   * restore from snapshot on every test run" workflows.
   */
  async saveSnapshot(avdName: string, snapshotName: string): Promise<SnapshotResult> {
    const avd = await this.ensureAvdRunning(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'emu', 'avd', 'snapshot', 'save', snapshotName]);
    return {
      avdName,
      snapshotName,
      saved: r.exitCode === 0 && !/error/i.test(r.stdout + r.stderr),
      output: (r.stdout + r.stderr).trim(),
    };
  }

  async loadSnapshot(avdName: string, snapshotName: string): Promise<SnapshotResult> {
    const avd = await this.ensureAvdRunning(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'emu', 'avd', 'snapshot', 'load', snapshotName]);
    return {
      avdName,
      snapshotName,
      saved: r.exitCode === 0 && !/error/i.test(r.stdout + r.stderr),
      output: (r.stdout + r.stderr).trim(),
    };
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
