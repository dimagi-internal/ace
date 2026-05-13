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

export type ShellFn = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<ShellResult>;

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
 * Locate the maestro CLI even when the operator's shell rc additions
 * haven't propagated to the spawned MCP server. The official installer
 * drops the launcher at `~/.maestro/bin/maestro` on macOS / Linux and
 * `%USERPROFILE%\.maestro\bin\maestro.bat` on Windows, then tries to
 * append `~/.maestro/bin` to the user's shell rc — which never reaches
 * a Claude-Code-Desktop child process spawned before the install.
 *
 * Resolution order:
 *   1. `MAESTRO_BIN` from process env (operator/CI override wins)
 *   2. `~/.maestro/bin/maestro[.bat]` (official installer default)
 *
 * Returns the path to the bin DIRECTORY (not the binary itself) so
 * shellEnv can prepend it to PATH, or null if nothing matched.
 */
function resolveMaestroBinDir(): string | null {
  if (process.env.MAESTRO_BIN && fs.existsSync(process.env.MAESTRO_BIN)) {
    return path.dirname(process.env.MAESTRO_BIN);
  }
  const homeBin = path.join(os.homedir(), '.maestro', 'bin');
  const launcher = process.platform === 'win32' ? 'maestro.bat' : 'maestro';
  if (fs.existsSync(path.join(homeBin, launcher))) return homeBin;
  return null;
}

/**
 * Build a child-process env that includes a resolved JAVA_HOME and a PATH
 * that contains its bin/. Used by every shell call so maestro/avdmanager
 * Just Work even from a fresh non-login shell.
 */
function shellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const sep = process.platform === 'win32' ? ';' : ':';
  const prepend = (dir: string) => {
    if (!env.PATH || !env.PATH.split(sep).includes(dir)) {
      env.PATH = `${dir}${sep}${env.PATH ?? ''}`;
    }
  };

  const javaHome = resolveJavaHome();
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    prepend(path.join(javaHome, 'bin'));
  }

  const maestroBinDir = resolveMaestroBinDir();
  if (maestroBinDir) prepend(maestroBinDir);

  return env;
}

export const defaultShell: ShellFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: shellEnv(), cwd: opts.cwd });
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
    // ACE_MOBILE_EMULATOR_PORT pins the emulator's console port (and adb-bridge
    // at port+1, serial `emulator-<port>`). Lets two Mac users share one host
    // without their emulators colliding on the auto-incremented 5554/5555 pair.
    // Unset → emulator picks the default 5554 / next-free.
    const args = ['-avd', avdName, '-no-window', '-no-snapshot-save'];
    const port = process.env.ACE_MOBILE_EMULATOR_PORT?.trim();
    if (port) args.push('-port', port);
    const child = spawn('emulator', args, {
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
        await this.assertSerialAuthorized(found.serial);
        await this.runPostBootPrep(found.serial);
        return { ...found, bootTimeMs: Date.now() - start };
      }
    }
    throw new AvdBootError(avdName, `boot timeout after ${AVD_BOOT_TIMEOUT_MS}ms`);
  }

  /**
   * After boot reports complete, verify the device shows up as `device`
   * (authorized) in `adb devices` rather than `unauthorized`. The unauthorized
   * state is its own diagnostic maze: an adb-server holding stale RSA keys
   * (e.g. spawned by a different shell or a previous user on a shared box)
   * sees the freshly-booted emulator's new keys as untrusted, returns
   * `unauthorized`, and silently breaks every downstream `adb -s` call.
   *
   * Self-healing: kill+restart adb-server ONCE and re-check. The restarted
   * server picks up the current user's `~/.android/adbkey` and the emulator's
   * `~/.android/emulator-console-auth-token` and the auth flips to `device`.
   * If a single restart doesn't clear it, we surface a clear actionable error
   * — the operator either has to accept the RSA prompt on the emulator screen
   * or kill a stale emulator owned by a different user.
   */
  private async assertSerialAuthorized(serial: string): Promise<void> {
    const status = await this.adbDeviceStatus(serial);
    if (status === 'device') return;
    if (status === 'unauthorized') {
      // One self-heal attempt: kill and restart adb-server, then re-check.
      await this.shell('adb', ['kill-server']).catch(() => {});
      await this.shell('adb', ['start-server']).catch(() => {});
      // Give the new server a beat to enumerate.
      await new Promise((r) => setTimeout(r, 1500));
      const recheck = await this.adbDeviceStatus(serial);
      if (recheck === 'device') return;
      if (recheck === 'unauthorized') {
        throw new AvdBootError(
          serial,
          `adb device unauthorized — accept the RSA prompt on the emulator screen, ` +
            `or check that no other user has a stale emulator running on this host. ` +
            `Restart of adb-server did not clear the unauthorized state.`,
        );
      }
      // Anything else (offline, missing, etc.) — fall through to the generic
      // error below with whatever the recheck returned.
      throw new AvdBootError(serial, `adb device state after restart: ${recheck ?? 'missing'}`);
    }
    // status is 'offline', null, or some other unexpected value — don't try
    // to "fix" it, just surface what we saw so the operator can act.
    throw new AvdBootError(serial, `adb device state: ${status ?? 'missing'}`);
  }

  /**
   * Look up a single emulator's authorization state. Returns the second
   * column from `adb devices` for that serial — typically `device` (good),
   * `unauthorized`, or `offline`. Returns null if the serial isn't listed.
   */
  private async adbDeviceStatus(serial: string): Promise<string | null> {
    const r = await this.shell('adb', ['devices']);
    for (const line of r.stdout.split('\n').slice(1)) {
      const parts = line.split('\t').map((s) => s.trim());
      if (parts[0] === serial) return parts[1] ?? null;
    }
    return null;
  }

  /**
   * Idempotent post-boot AVD prep for ACE registration:
   *   - waits for sys.boot_completed=1
   *   - disables Google Play Services (so MicroImageActivity falls back to
   *     manual shutter — see Face-capture gate gotcha)
   *   - pre-grants CAMERA permission to org.commcare.dalvik if installed
   *   - dismisses NotificationShade if it's the focused window (a
   *     known-quirk on cold boot of `google_apis*` images on macOS)
   *
   * All steps best-effort. Any single failure logs and continues — the
   * AVD is still usable, just may need manual prep for registration.
   */
  private async runPostBootPrep(serial: string): Promise<void> {
    // Two-phase boot wait. sys.boot_completed=1 is set early; the device
    // is reachable by `adb -s` long before user storage and the launcher
    // are actually ready. Wait for /sdcard to be mounted as the real
    // signal — a stuck-on-NotificationShade boot is exactly the case
    // where boot_completed=1 but /sdcard isn't there yet.
    const bootStart = Date.now();
    while (Date.now() - bootStart < 90_000) {
      const r = await this.shell('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']);
      if (r.stdout.trim() === '1') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    while (Date.now() - bootStart < 120_000) {
      // Use /storage/emulated/0 instead of /sdcard — the latter is a
      // symlink that may not be readable by the shell uid under scoped
      // storage even when user storage is fully mounted.
      const r = await this.shell('adb', ['-s', serial, 'shell', 'test', '-e', '/storage/emulated/0']).catch(() => null);
      if (r && r.exitCode === 0) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    // GMS state is NOT touched here. Older versions of this prep
    // unconditionally `pm disable-user com.google.android.gms` so that
    // CommCare's MicroImageActivity falls back to ManualMode for face
    // capture. CommCare 2.62.0 tightened its launch-time GMS check —
    // a disabled GMS now triggers a blocking "Enable Google Play
    // services" dialog that has only an ENABLE button, killing the
    // recipe before phone entry. Live-reproduced 2026-05-01 on a
    // freshly `-wipe-data`'d AVD.
    //
    // Resolution: orchestrate GMS state at the recipe-pair boundary
    // instead. `MobileClient.registerTestUser` ensures GMS is enabled
    // before part A (so CommCare launches), then disables it between
    // part A and part B (so the in-app face-capture path picks up
    // ManualMode). Doing this here at boot would re-introduce the
    // launch-block class. See `setGmsEnabled` below.

    // Grant CAMERA only if commcare is installed; pm grant fails noisily
    // for missing packages, and most of the time it's not installed yet
    // when ensure-running fires (the bootstrap installs it later).
    const list = await this.shell('adb', ['-s', serial, 'shell', 'pm', 'list', 'packages', 'org.commcare.dalvik']).catch(() => null);
    if (list && list.stdout.includes('package:org.commcare.dalvik')) {
      await this.shell('adb', ['-s', serial, 'shell', 'pm', 'grant', 'org.commcare.dalvik', 'android.permission.CAMERA']).catch(() => {});
    }

    // Some `google_apis*` AVD cold boots leave SystemUI with
    // NotificationShade as the focused window — keys go to the shade and
    // maestro can't drive flows. We try every common recovery path in
    // sequence: cmd statusbar collapse (Android 11+), service call 2
    // (statusbar collapse legacy), wm dismiss-keyguard, KEYCODE_HOME.
    // Only run if we detect the stuck state, since on a healthy boot
    // this is a no-op.
    for (let attempt = 0; attempt < 3; attempt++) {
      const focus = await this.shell('adb', ['-s', serial, 'shell', 'dumpsys', 'window']).catch(() => null);
      if (!focus || !/mCurrentFocus=Window\{[^}]*NotificationShade/.test(focus.stdout)) return;
      await this.shell('adb', ['-s', serial, 'shell', 'cmd', 'statusbar', 'collapse']).catch(() => {});
      await this.shell('adb', ['-s', serial, 'shell', 'service', 'call', 'statusbar', '2']).catch(() => {});
      await this.shell('adb', ['-s', serial, 'shell', 'wm', 'dismiss-keyguard']).catch(() => {});
      await this.shell('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /**
   * Toggle Google Play Services on a running AVD. ACE registration
   * recipes need GMS *enabled* during CommCare launch (CommCare 2.62.0+
   * shows a blocking "Enable Google Play services" dialog if it sees
   * GMS disabled at startup) and *disabled* during face-capture (so
   * MicroImageActivity falls back to FaceCaptureView.CaptureMode.ManualMode
   * — the emulated front camera can never satisfy ML Kit face detection).
   *
   * `pm enable` and `pm disable-user --user 0` are both idempotent, so
   * calling this with the same value twice is a no-op. Best-effort:
   * failures are swallowed to keep the registration flow moving (a
   * stale GMS state will surface as a maestro selector miss, not a
   * silent corruption).
   */
  async setGmsEnabled(avdName: string, enabled: boolean): Promise<void> {
    const found = await this.findRunningAvd(avdName);
    if (!found) return;
    const args = enabled
      ? ['-s', found.serial, 'shell', 'pm', 'enable', 'com.google.android.gms']
      : ['-s', found.serial, 'shell', 'pm', 'disable-user', '--user', '0', 'com.google.android.gms'];
    await this.shell('adb', args).catch(() => {});
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

  /**
   * Derive the adbd TCP port from an `emulator-NNNN` serial. The Android
   * emulator uses port pairs: `NNNN` is the qemu console port (telnet),
   * `NNNN+1` is the adbd port that dadb / adb client speak the wire
   * protocol against. Used to wire `maestro --host=localhost --port=<X>`
   * for direct-dadb runs that bypass the local adb server. Returns null
   * if the serial doesn't match `emulator-<digits>`.
   */
  static adbPortFromSerial(serial: string): number | null {
    const m = serial.match(/^emulator-(\d+)$/);
    if (!m) return null;
    return parseInt(m[1], 10) + 1;
  }

  async findRunningAvd(avdName: string): Promise<AvdInfo | null> {
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

  /**
   * Read the focused-activity line from `dumpsys activity activities`.
   * Returns the trimmed `mResumedActivity ...` line (empty string if no
   * match). Cheap probe used by the device-user-state classifier in
   * `MobileClient` to detect first-launch / "Enter Code" state
   * (CommCareSetupActivity foregrounded).
   */
  async getFocusedActivity(avdName: string): Promise<string> {
    const avd = await this.ensureAvdRunning(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'shell', 'dumpsys', 'activity', 'activities']);
    const line = r.stdout.split('\n').find((l) => l.includes('mResumedActivity')) ?? '';
    return line.trim();
  }

  /**
   * List installed packages on the AVD, optionally filtered to a prefix.
   * Pass `org.commcare.dalvik` to confirm the CommCare-with-Connect client
   * is installed; CommCare 2.62.0+ IS the Connect client (no separate
   * `connect`-named package — grep'ing for `connect` returns nothing
   * even on a healthy install, which is what landed the inverted-
   * conclusion misdiagnosis on turmeric run 20260513-0616).
   */
  async listPackages(avdName: string, filter?: string): Promise<string[]> {
    const avd = await this.ensureAvdRunning(avdName);
    const args = ['-s', avd.serial, 'shell', 'pm', 'list', 'packages'];
    if (filter) args.push(filter);
    const r = await this.shell('adb', args);
    return r.stdout
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter(Boolean);
  }

  async captureUiDump(avdName: string): Promise<UiDumpResult> {
    const avd = await this.ensureAvdRunning(avdName);
    // Pass an explicit /data/local/tmp path. The default `uiautomator dump`
    // (no path arg) writes "/sdcard/window_dump.xml" per its CLI help, but
    // on API 34 Pixel AVDs `/sdcard/` is a FUSE-backed user-space mount that
    // the `shell` user cannot read back via `cat /sdcard/...` even though
    // the dump command reports success. Verified live in
    // turmeric-20260429-2330 Phase 6 / D-step probe (2026-04-30):
    // /sdcard/ → "No such file or directory" on read,
    // /data/local/tmp/ → file readable, dump valid.
    const dumpPath = '/data/local/tmp/window_dump.xml';
    await this.shell('adb', ['-s', avd.serial, 'shell', 'uiautomator', 'dump', dumpPath]);
    const xmlR = await this.shell('adb', ['-s', avd.serial, 'exec-out', 'cat', dumpPath]);
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
