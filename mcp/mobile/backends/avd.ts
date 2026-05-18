import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AvdBootError, AvdBootTimeoutError, AdbError } from '../errors.js';
import type { AvdInfo, ApkInfo, UiDumpResult, SnapshotResult } from '../types.js';
import { resolveAdbServerPort, resolveEmulatorPair } from '../port-allocator.js';

// Per-phase budgets for the post-spawn three-phase boot wait.
//
// Phase A — adb-register: serial appears in `adb devices` with state `device`.
//   On a fresh `-wipe-data` cold-boot, the serial pops in the list within ~5s
//   as `offline`, then flips to `device` ~5-15s later. 60s comfortably covers
//   slow disk or contention on a shared CI box. The MUST-HAVE bug fix: don't
//   treat the brief `offline` window as fatal.
//
// Phase B — boot-completed: `getprop sys.boot_completed` returns "1".
//   Typically 10-30s after `device`; 120s budget tolerates slow images
//   (google_apis_playstore is notably slower than google_apis on cold-boot).
//
// Phase C — storage-mount: `/storage/emulated/0` is mounted.
//   Usually a couple of seconds after boot_completed; 30s is plenty.
const AVD_PHASE_ADB_REGISTER_MS = 60_000;
const AVD_PHASE_BOOT_COMPLETED_MS = 120_000;
const AVD_PHASE_STORAGE_MOUNT_MS = 30_000;
const AVD_PHASE_POLL_MS = 1_000;

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
  /**
   * Skip the env-aware adb-port injection wrapper. Tests pass their own
   * `shell` mock and don't want the wrapper second-guessing the calls.
   * Production code never sets this.
   */
  rawShell?: boolean;
  /**
   * Override the post-spawn three-phase boot-wait budgets and poll
   * interval. Tests pass tiny values (~100ms total) so timeout cases
   * land deterministically without sleeping seconds in CI. Production
   * leaves these undefined and uses the constants at the top of the
   * module.
   */
  bootWait?: {
    adbRegisterMs?: number;
    bootCompletedMs?: number;
    storageMountMs?: number;
    pollMs?: number;
  };
}

export interface AllocatedPorts {
  adbServerPort: number;
  emulatorConsolePort: number;
  emulatorAdbBridgePort: number;
  /** True if both ports were probe-allocated (no env override). */
  autoAllocated: boolean;
}

export class AvdBackend {
  /** The injected/wrapped shell used by all adb/emulator/aapt invocations. */
  private shell: ShellFn;
  /** The raw underlying shell, before adb-port env injection. */
  private rawShellFn: ShellFn;
  /** Lazily allocated; populated on first call to `getAllocatedPorts`. */
  private ports: AllocatedPorts | null = null;
  /** Promise dedupe so concurrent `getAllocatedPorts` calls share one allocation. */
  private allocPromise: Promise<AllocatedPorts> | null = null;
  /** Per-phase boot-wait budgets (test override via constructor opts). */
  private readonly bootWait: {
    adbRegisterMs: number;
    bootCompletedMs: number;
    storageMountMs: number;
    pollMs: number;
  };

  constructor(opts: AvdBackendOpts = {}) {
    this.rawShellFn = opts.shell ?? defaultShell;
    // When tests pass a `shell` mock they want exact-match behavior — they
    // script call signatures like `adb devices`, not `adb -P 5039 devices`.
    // Production wraps to inject ANDROID_ADB_SERVER_PORT into spawned env
    // so every adb call lands on the right server.
    this.shell = opts.shell || opts.rawShell ? this.rawShellFn : this.makeAdbShell(this.rawShellFn);
    this.bootWait = {
      adbRegisterMs: opts.bootWait?.adbRegisterMs ?? AVD_PHASE_ADB_REGISTER_MS,
      bootCompletedMs: opts.bootWait?.bootCompletedMs ?? AVD_PHASE_BOOT_COMPLETED_MS,
      storageMountMs: opts.bootWait?.storageMountMs ?? AVD_PHASE_STORAGE_MOUNT_MS,
      pollMs: opts.bootWait?.pollMs ?? AVD_PHASE_POLL_MS,
    };
  }

  /**
   * Wrap a ShellFn so `adb` invocations spawn with `ANDROID_ADB_SERVER_PORT`
   * pinned to whatever this backend has allocated. Only `adb` is wrapped —
   * `emulator -port <N>` already gets the explicit port arg, and other
   * commands (`aapt`, the maestro launcher inside `defaultShell`) don't
   * care.
   *
   * The wrapper deliberately calls `getAllocatedPorts()` (which lazily
   * probes on first use) so the very first `adb` call after construction
   * triggers allocation. Subsequent calls are O(1).
   */
  private makeAdbShell(inner: ShellFn): ShellFn {
    return async (cmd, args, opts) => {
      if (cmd !== 'adb') return inner(cmd, args, opts);
      const ports = await this.getAllocatedPorts();
      const oldEnv = process.env.ANDROID_ADB_SERVER_PORT;
      // Inject for the duration of this single shell call. `defaultShell`
      // builds its child env from `process.env` at spawn time, so we set
      // and restore around the call. Concurrent `adb` invocations from
      // the same backend instance all see the same allocated port, so
      // this race-free even under parallel awaits.
      process.env.ANDROID_ADB_SERVER_PORT = String(ports.adbServerPort);
      try {
        return await inner(cmd, args, opts);
      } finally {
        if (oldEnv === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
        else process.env.ANDROID_ADB_SERVER_PORT = oldEnv;
      }
    };
  }

  /**
   * Resolve the adb-server + emulator console/adb-bridge ports for this
   * backend instance (= this MCP server session). Env vars
   * `ANDROID_ADB_SERVER_PORT` and `ACE_MOBILE_EMULATOR_PORT` win when
   * set; otherwise we probe TCP ports starting at 5037 and 5554
   * respectively, walking upward to the first free pair. Cached for the
   * lifetime of the backend so every `adb -P <port>` and emulator spawn
   * in the same session uses the same allocator.
   */
  async getAllocatedPorts(): Promise<AllocatedPorts> {
    if (this.ports) return this.ports;
    if (this.allocPromise) return this.allocPromise;
    this.allocPromise = (async () => {
      const adbEnv = process.env.ANDROID_ADB_SERVER_PORT?.trim();
      const emuEnv = process.env.ACE_MOBILE_EMULATOR_PORT?.trim();
      const adbServerPort = await resolveAdbServerPort();
      const pair = await resolveEmulatorPair();
      this.ports = {
        adbServerPort,
        emulatorConsolePort: pair.console,
        emulatorAdbBridgePort: pair.adbBridge,
        autoAllocated: !adbEnv && !emuEnv,
      };
      return this.ports;
    })();
    return this.allocPromise;
  }

  /**
   * Locate the named AVD's running emulator and return its info, OR
   * throw `AvdBootError` if it isn't currently running.
   *
   * Used by helper methods (installApk, captureUiDump, saveSnapshot,
   * settings adjustments, etc.) that need the device serial of an
   * already-booted AVD without triggering the full cold-boot path that
   * `ensureAvdRunning` now always performs. The orchestrator (`MobileClient.
   * ensureAvdRunning`) is the single caller responsible for the cold-boot;
   * everything downstream just needs to look up the running device.
   */
  async requireRunningAvd(avdName: string): Promise<AvdInfo> {
    const found = await this.findRunningAvd(avdName);
    if (!found) {
      throw new AvdBootError(
        avdName,
        `AVD '${avdName}' is not currently running. Call mobile_ensure_avd_running first to cold-boot it.`,
      );
    }
    return found;
  }

  async listAvds(): Promise<string[]> {
    const r = await this.shell('emulator', ['-list-avds']);
    return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  /**
   * Always cold-boot the AVD. If an emulator process for this AVD is
   * already running, kill it, wait for it to exit, then boot fresh with
   * `-wipe-data -no-snapshot-load -no-snapshot-save`. This guarantees a
   * deterministic starting state for every Phase 6 dispatch — no implicit
   * trust in carry-over from prior dispatches (lockscreen state, GMS
   * toggles, instrumentation residue, Maestro driver state, etc.).
   *
   * Replaces the prior "fast path on warm AVD" optimization. That model
   * had the same failure shape as snapshot-load tier-1: it cached the
   * running emulator process as implicit state, and every class of
   * junk-state that accumulated across dispatches (driver wedged, user 0
   * direct-boot, residual lockscreen passwords from `maestro studio`)
   * had to be debugged one at a time. Cold-boot makes those classes
   * structurally impossible — every dispatch starts from a known-empty
   * userdata.
   *
   * Steady-state cost: ~60-90s. ~30s for `emu kill` + exit + emulator
   * cold-boot; ~10s for `-wipe-data` to scrub the userdata image; the
   * remainder for `runPostBootPrep` waiting on `sys.boot_completed` and
   * `/storage/emulated/0`. Compares against ~20-30s for the prior warm-
   * AVD path. The extra ~30-60s is the price of guaranteed clean state;
   * cheaper than debugging another junk-state class out-of-band.
   *
   * Cloud backend follows the same contract via a different mechanism —
   * `/api/mobile/ensure-running` cold-boots from AMI on every call.
   */
  async ensureAvdRunning(avdName: string): Promise<AvdInfo> {
    // Sweep stale qemu+adb daemon state BEFORE listing/killing/booting.
    //
    // Same precondition-restore class as the cold-boot itself (see
    // CLAUDE.md § "Phase preconditions are restored, not adapted"),
    // just one layer lower: qemu+adb daemon state, not AVD content
    // state. Three concrete observations of this class on
    // malaria-itn-fgd/20260515-1645 Phase 6:
    //   (8) post-PR-#345 boot-wait fix passed but a wedged adb daemon
    //       independent of the wait still 500'd; `adb kill-server` +
    //       `adb start-server` cleared it.
    //   (10) 2 orphan qemu-system-aarch64 processes + 3 stale adb
    //       daemons from prior crashed boots — `package service` never
    //       binds; 3 consecutive `mobile_ensure_avd_running` failures.
    //   (11) Even after the parent manually swept qemu+adb, the first
    //       in-dispatch `ensureAvdRunning` call STILL threw the same
    //       signature until a second `adb kill-server`/`start-server`
    //       fired inside the dispatch — proving the heal itself needs
    //       to own daemon restoration, not the operator.
    //
    // Best-effort: ignore failures. Logs structured info on orphan
    // qemu PIDs so future debug avoids the manual `pgrep -af qemu`
    // step. Cost: ~500ms-1s once per heal; cheaper than the next
    // junk-state debug cycle.
    await this.sweepStaleEmulatorState();

    const known = await this.listAvds();
    if (!known.includes(avdName)) {
      throw new AvdBootError(avdName, `AVD '${avdName}' not in emulator -list-avds output`);
    }

    // If a prior emulator for this AVD is running, kill it and wait for
    // it to fully exit. Best-effort: a stale `adb devices` entry can lag
    // a few seconds after `emu kill` lands; we poll until the serial
    // disappears OR ~15s elapse (real-world bound is well under that).
    const existing = await this.findRunningAvd(avdName);
    if (existing) {
      await this.shell('adb', ['-s', existing.serial, 'emu', 'kill']).catch(() => {});
      const killStart = Date.now();
      while (Date.now() - killStart < 15_000) {
        const stillThere = await this.findRunningAvd(avdName).catch(() => null);
        if (!stillThere) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    // Patch the AVD config to ensure a front camera is available before boot.
    // CommCare's photo capture step uses CameraX with LENS_FACING_FRONT; the
    // default Pixel 7 template ships hw.camera.front=none, which makes the
    // selfie step silently no-op (CameraX validation fails). Idempotent.
    this.ensureFrontCameraEmulated(avdName);

    // Boot in detached background process; do NOT await it.
    // Two concurrent local sessions on the same laptop both default to
    // adb 5037 + emulator console 5554 / adb-bridge 5555 and collide.
    // `getAllocatedPorts` resolves env-pinned values (when set) or
    // probe-walks for the next free pair. The same allocator backs every
    // adb call in this session via `makeAdbShell`, so the boot port and
    // the discovery port are always the same.
    //
    // `-wipe-data` scrubs userdata.img on launch (lockscreen, system
    // settings, app data, instrumentation state — everything that
    // accumulates across dispatches). `-no-snapshot-load` blocks the
    // emulator from auto-loading the default snapshot, which would
    // re-introduce the same warm-state class we're scrubbing.
    // `-no-snapshot-save` keeps the next cold-boot honest by not saving
    // a snapshot of the post-bootstrap state on shutdown.
    const ports = await this.getAllocatedPorts();
    const args = [
      '-avd',
      avdName,
      '-no-window',
      '-wipe-data',
      '-no-snapshot-load',
      '-no-snapshot-save',
      '-port',
      String(ports.emulatorConsolePort),
    ];
    const env = { ...shellEnv(), ANDROID_ADB_SERVER_PORT: String(ports.adbServerPort) };
    const child = spawn('emulator', args, {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();

    const start = Date.now();
    const expectedSerial = `emulator-${ports.emulatorConsolePort}`;

    // Orphan-kill scope: if any wait phase throws, kill the just-spawned
    // qemu before propagating. The cold-boot funnel's "deterministic
    // state" promise depends on the funnel completing or cleaning up —
    // an orphaned qemu booting in the background that survives into the
    // next session re-introduces the warm-AVD class we cold-boot to
    // structurally prevent. Best-effort: ignore kill errors (the qemu
    // might have already died on its own).
    try {
      await this.waitForAdbRegister(expectedSerial, start);
      await this.waitForBootCompleted(expectedSerial, start);
      await this.waitForStorageMount(expectedSerial, start);

      // assertSerialAuthorized is now a redundant final check rather
      // than the load-bearing one. waitForAdbRegister already required
      // state=device; the only way to land here in unauthorized is a
      // race between the wait loop and a stale-RSA-key adb-server. The
      // self-healing kill+restart logic in assertSerialAuthorized
      // handles that race.
      await this.assertSerialAuthorized(expectedSerial);

      // Lookup the AvdInfo (serial → avd name); cheap one-shot.
      const found = await this.findRunningAvd(avdName);
      if (!found) {
        // adb shows `device` for the expected serial but emu console
        // doesn't report this AVD's name back. Means we collided with
        // another emulator on the same console port. Surface as a real
        // error rather than returning a wrong AvdInfo.
        throw new AvdBootError(
          avdName,
          `serial ${expectedSerial} booted but does not report avd name '${avdName}' from emu console`,
        );
      }

      await this.runPostBootPrep(found.serial);
      return { ...found, bootTimeMs: Date.now() - start };
    } catch (err) {
      // Kill the orphan qemu. Best-effort — adb emu kill may fail if
      // the device is still in `offline` state (the very case that
      // triggered our throw). Fall back to SIGKILL on the spawn pid.
      await this.shell('adb', ['-s', expectedSerial, 'emu', 'kill']).catch(() => {});
      if (typeof child.pid === 'number') {
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      throw err;
    }
  }

  /**
   * Best-effort sweep of orphan `qemu-system-*` processes + a forced
   * adb-server restart, run as the first step of every `ensureAvdRunning`
   * call. Restores a known-clean qemu+adb daemon precondition before the
   * cold-boot funnel runs, the same way the cold-boot funnel itself
   * restores a known-clean AVD-content precondition.
   *
   * Two-step contract:
   *
   *   1. Find every running `qemu-system-*` PID. Cross-reference against
   *      the current `adb devices` listing. If a qemu PID has no live
   *      `emulator-NNNN device` line tracking it, it's an orphan (a
   *      crashed / interrupted prior dispatch left it behind) — kill -9.
   *      Logs structured info per kill: PID + console port it was
   *      listening on (best-effort via lsof; ports are derived from
   *      `adb devices` so we don't strictly need lsof to make the right
   *      kill decision).
   *
   *   2. Always run `adb kill-server` + `adb start-server`. Wedged adb
   *      daemons accumulate state across long sessions; a single
   *      restart costs ~500ms and resets the daemon to a known-good
   *      state. This is the cheaper path than probing for "is the
   *      daemon wedged?" — three observed instances in
   *      malaria-itn-fgd/20260515-1645 (attempts 8, 10, 11) all
   *      resolved with the same `kill-server`/`start-server` pair.
   *
   * Both steps are best-effort: every shell call swallows its error.
   * If sweeping fails, the cold-boot funnel still proceeds — the worst
   * case is the same "wedged daemon" symptom we're trying to prevent,
   * which then surfaces in a downstream phase with the same diagnostic
   * we already have.
   */
  private async sweepStaleEmulatorState(): Promise<void> {
    // Step 1: orphan qemu sweep.
    //
    // Get all qemu-system PIDs. `pgrep -af` would give us the command-
    // line too, but we don't need it for the kill decision — the
    // adb-devices cross-reference is the authoritative signal. On
    // Windows we no-op (pgrep doesn't exist, and ACE mobile dev is
    // Mac/Linux-only in practice).
    if (process.platform !== 'win32') {
      try {
        const pgrep = await this.shell('pgrep', ['-f', 'qemu-system']).catch(() => null);
        const qemuPids = pgrep && pgrep.exitCode === 0
          ? pgrep.stdout
              .split('\n')
              .map((s) => parseInt(s.trim(), 10))
              .filter((n) => Number.isFinite(n) && n > 0)
          : [];

        if (qemuPids.length > 0) {
          // Live-tracked qemu emulators have an entry in `adb devices`.
          // Anything else is orphan state. We don't try to map specific
          // PIDs to specific console ports here — if `adb devices` is
          // empty (which is the wedged state we're trying to recover
          // from), every qemu PID is by definition an orphan.
          const devices = await this.shell('adb', ['devices']).catch(() => null);
          const liveSerials = devices
            ? devices.stdout
                .split('\n')
                .slice(1)
                .map((line) => line.split('\t')[0].trim())
                .filter((s) => s.startsWith('emulator-'))
            : [];
          const liveCount = liveSerials.length;

          if (liveCount === 0) {
            // Wedged-daemon state: kill every qemu PID we found. This
            // is the explicit malaria-itn-fgd attempt-10 reproducer.
            for (const pid of qemuPids) {
              // eslint-disable-next-line no-console
              console.warn(`[ace-mobile] sweepStaleEmulatorState: killing orphan qemu pid=${pid} (no adb devices visible)`);
              try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
            }
          } else if (qemuPids.length > liveCount) {
            // Some qemu PIDs aren't matched by adb devices — best-
            // effort: kill the excess. We can't precisely identify
            // which PIDs are orphans without per-process port probing,
            // but if pgrep shows N PIDs and adb sees M < N devices,
            // (N - M) PIDs are orphans. We kill the lowest-PID
            // excess (most likely to be the older orphans).
            //
            // Conservative: only kill if pgrep > 2 * live (i.e. we're
            // confident there are MULTIPLE orphans, not a single
            // legitimate emulator with a stale pgrep echo). This
            // avoids killing a healthy concurrent emulator on a
            // shared box.
            if (qemuPids.length >= liveCount + 2) {
              const excess = qemuPids.slice(0, qemuPids.length - liveCount);
              for (const pid of excess) {
                // eslint-disable-next-line no-console
                console.warn(`[ace-mobile] sweepStaleEmulatorState: killing likely-orphan qemu pid=${pid} (${qemuPids.length} qemu PIDs, ${liveCount} adb devices)`);
                try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
              }
            }
          }
        }
      } catch {
        // Best-effort: any sweep failure is silently swallowed so the
        // cold-boot funnel still proceeds.
      }
    }

    // Step 2: always restart adb-server. Cheap (~500ms) and resets
    // the daemon to a known-clean state independent of whether we
    // detected wedge symptoms. Cited in three observed instances
    // (malaria-itn-fgd attempts 8, 10, 11) as the manual recovery
    // operators ran — owning it inside the heal removes the
    // operator-in-the-loop step.
    await this.shell('adb', ['kill-server']).catch(() => {});
    await this.shell('adb', ['start-server']).catch(() => {});
  }

  /**
   * Phase A of the post-spawn cold-boot wait: poll `adb devices` until
   * the expected serial appears with state `device` (authorized + online).
   *
   * Tolerates the brief `offline` window during qemu startup — that's
   * normal, not a fault. The bug in v0.13.270 was treating the first
   * `offline` reading as fatal, which short-circuited the wait inside
   * ~1s and left an orphan qemu booting in the background.
   *
   * Tolerates `unauthorized` for the same reason — it can flicker
   * during the boot-time RSA key handshake. The dedicated `assertSerial-
   * Authorized` self-heal runs after this phase to handle persistent
   * unauthorized states.
   *
   * Throws AvdBootTimeoutError(phase='adb-register') on budget exceeded.
   */
  private async waitForAdbRegister(expectedSerial: string, startedAt: number): Promise<void> {
    const deadline = startedAt + this.bootWait.adbRegisterMs;
    let lastState: string | null = null;
    while (Date.now() < deadline) {
      lastState = await this.adbDeviceStatus(expectedSerial).catch(() => null);
      if (lastState === 'device') return;
      await new Promise((r) => setTimeout(r, this.bootWait.pollMs));
    }
    throw new AvdBootTimeoutError(
      expectedSerial,
      expectedSerial,
      'adb-register',
      Date.now() - startedAt,
      this.bootWait.adbRegisterMs,
      lastState,
      '',
    );
  }

  /**
   * Phase B of the post-spawn cold-boot wait: poll `getprop
   * sys.boot_completed` until it returns "1". Empty output / errors are
   * "still booting", not fatal.
   *
   * Throws AvdBootTimeoutError(phase='boot-completed') on budget exceeded.
   */
  private async waitForBootCompleted(serial: string, startedAt: number): Promise<void> {
    const deadline = startedAt + this.bootWait.bootCompletedMs;
    let last = '';
    while (Date.now() < deadline) {
      const r = await this.shell('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).catch(
        () => null,
      );
      last = (r?.stdout ?? '').trim();
      if (last === '1') return;
      await new Promise((r) => setTimeout(r, this.bootWait.pollMs));
    }
    throw new AvdBootTimeoutError(
      serial,
      serial,
      'boot-completed',
      Date.now() - startedAt,
      this.bootWait.bootCompletedMs,
      'device',
      last,
    );
  }

  /**
   * Phase C of the post-spawn cold-boot wait: poll for /storage/emulated/0
   * mount. Some Android `settings put` writes and APK installs depend on
   * scoped storage being mounted even when `sys.boot_completed=1`.
   *
   * Throws AvdBootTimeoutError(phase='storage-mount') on budget exceeded.
   */
  private async waitForStorageMount(serial: string, startedAt: number): Promise<void> {
    const deadline = Date.now() + this.bootWait.storageMountMs;
    while (Date.now() < deadline) {
      const r = await this.shell('adb', ['-s', serial, 'shell', 'test', '-e', '/storage/emulated/0']).catch(
        () => null,
      );
      if (r && r.exitCode === 0) return;
      await new Promise((r) => setTimeout(r, this.bootWait.pollMs));
    }
    throw new AvdBootTimeoutError(
      serial,
      serial,
      'storage-mount',
      Date.now() - startedAt,
      this.bootWait.storageMountMs,
      'device',
      '1',
    );
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
   *   - disables Google Play Services (so MicroImageActivity falls back to
   *     manual shutter — see Face-capture gate gotcha)
   *   - pre-grants CAMERA permission to org.commcare.dalvik if installed
   *   - dismisses NotificationShade if it's the focused window (a
   *     known-quirk on cold boot of `google_apis*` images on macOS)
   *
   * Boot-completed and /storage/emulated/0 waits are NOT here — they ran
   * already in `ensureAvdRunning`'s three-phase wait. This function runs
   * AFTER both phases pass, so the device is ready for `pm`, `am`,
   * `settings`, and `dumpsys` calls.
   *
   * All steps best-effort. Any single failure logs and continues — the
   * AVD is still usable, just may need manual prep for registration.
   */
  private async runPostBootPrep(serial: string): Promise<void> {

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
    const avd = await this.requireRunningAvd(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'install', '-r', apkPath]);
    if (r.exitCode !== 0 || !r.stdout.includes('Success')) {
      throw new AdbError('install', r.exitCode, r.stderr || r.stdout);
    }
    return this.parseApkInfo(apkPath);
  }

  async uninstallApk(avdName: string, packageId: string): Promise<{ uninstalled: boolean }> {
    const avd = await this.requireRunningAvd(avdName);
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
    const avd = await this.requireRunningAvd(avdName);
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
    const avd = await this.requireRunningAvd(avdName);
    const args = ['-s', avd.serial, 'shell', 'pm', 'list', 'packages'];
    if (filter) args.push(filter);
    const r = await this.shell('adb', args);
    return r.stdout
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter(Boolean);
  }

  async captureUiDump(avdName: string): Promise<UiDumpResult> {
    const avd = await this.requireRunningAvd(avdName);
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
    const avd = await this.requireRunningAvd(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'emu', 'avd', 'snapshot', 'save', snapshotName]);
    return {
      avdName,
      snapshotName,
      saved: r.exitCode === 0 && !/error/i.test(r.stdout + r.stderr),
      output: (r.stdout + r.stderr).trim(),
    };
  }

  /**
   * Wipe `org.commcare.dalvik`'s local data — caches, databases, shared
   * prefs, ContextID-issued tokens — without uninstalling the APK. Used
   * as the first step of every heal dispatch so the subsequent
   * `registerTestUser` runs against a clean slate, never trusting cached
   * state from a prior run.
   *
   * Why this beats "trust the snapshot": snapshots silently age (the
   * wall-clock + cached Connect Token expiration drift; see
   * `docs/learnings/2026-05-14-demo-user-no-otp.md`). Wiping + freshly
   * registering a `+7426` demo user takes ~15-25s and produces guaranteed
   * clean state. The cost is dwarfed by the cost of debugging a stale-
   * snapshot failure once.
   *
   * Implementation: `adb shell pm clear <pkg>`. Returns `true` on success.
   * On failure (no root needed, but the package must exist) returns
   * `false` and lets the caller decide whether to halt.
   */
  async clearConnectAppData(avdName: string): Promise<boolean> {
    const avd = await this.requireRunningAvd(avdName);
    const r = await this.shell('adb', [
      '-s',
      avd.serial,
      'shell',
      'pm',
      'clear',
      'org.commcare.dalvik',
    ]);
    // `pm clear` prints "Success" on success, "Failed" on failure. Exit
    // code is unreliable across API levels — pin to the stdout text.
    return /Success/.test(r.stdout);
  }

  /**
   * Suppress Android heads-up notification banners on the AVD.
   *
   * Why this is class-level: AOSP AVDs (no Google Play Services — e.g.
   * `ACE_Pixel_API_34`) periodically fire a system heads-up banner from
   * the Messages app:
   *   "Enable Google Play services — Messages won't work unless you
   *    enable Google Play services"
   * The banner is touch-receptive and intercepts the next Maestro tap
   * mid-recipe. Live-reproduced in turmeric run 20260515-0536, attempt
   * #6 of `/ace:step app-screenshot-capture`: the banner ate a
   * `nav_btn_next` tap during `form-advance.yaml`, navigating the device
   * to Settings → App info → Google Play services; the recipe then
   * halted on a missing form text selector.
   *
   * Fix: turn off heads-up notifications globally and forbid GMS from
   * triggering Do-Not-Disturb override (belt-and-suspenders — DND-disallow
   * stops the GMS-owned channels from raising heads-up even if the global
   * toggle ever gets re-enabled by a system update).
   *
   * Idempotent: both writes are system-state toggles — repeated calls are
   * no-ops. Safe to call on every dispatch. Best-effort: failures are
   * swallowed so a transient adb hiccup doesn't gate the whole bootstrap.
   *
   * Persists in AVD snapshots (system globals live in
   * `/data/system/users/0/settings_global.xml`), so saving a post-boot
   * snapshot after this call carries the setting forward.
   */
  async disableHeadsUpNotifications(avdName: string): Promise<void> {
    const avd = await this.requireRunningAvd(avdName);
    await this.shell('adb', [
      '-s',
      avd.serial,
      'shell',
      'settings',
      'put',
      'global',
      'heads_up_notifications_enabled',
      '0',
    ]).catch(() => {});
    await this.shell('adb', [
      '-s',
      avd.serial,
      'shell',
      'cmd',
      'notification',
      'disallow_dnd',
      'com.google.android.gms',
    ]).catch(() => {});
  }

  /**
   * Apply the full AVD environment baseline used by every Phase 6 mobile
   * dispatch. Bundles the heads-up-notification suppress (added 0.13.252,
   * PR #328) with the broader environment hygiene the bundle in 0.13.256+
   * surfaces: lock-screen timeout extended to 30 min so the device doesn't
   * lock mid-recipe (Maestro's `tapOn` against a locked screen produces a
   * misleading "no element found" failure rather than a "screen is locked"
   * one).
   *
   * Returns the sha1 fingerprint of the sorted list of applied setting
   * keys. Stored on `AvdInfo.heal.environment_baseline_applied` (boolean
   * for compatibility) and surfaced via a separate
   * `environment_baseline_fingerprint` field on the heal log so telemetry
   * can detect drift when a new setting is added or removed in a future
   * version.
   *
   * Idempotent and best-effort — every individual `adb shell settings`
   * call is wrapped in `.catch(() => {})` so a transient adb hiccup
   * doesn't gate the whole bootstrap. The fingerprint is returned
   * regardless of whether each individual write succeeded; the return
   * value attests to the version of the baseline that was *attempted*,
   * not necessarily applied.
   */
  async applyEnvironmentBaseline(avdName: string): Promise<string> {
    const avd = await this.requireRunningAvd(avdName);
    // Settings applied. Add to this list whenever a new environment-class
    // failure surfaces; the fingerprint will change automatically so
    // telemetry can detect when AVDs are running an older baseline.
    const settingsApplied = [
      'heads_up_notifications_enabled',
      'notification_disallow_dnd_gms',
      'screen_off_timeout',
    ];

    // 1. Heads-up notifications off (PR #328 / 0.13.252).
    await this.shell('adb', [
      '-s', avd.serial, 'shell', 'settings', 'put', 'global',
      'heads_up_notifications_enabled', '0',
    ]).catch(() => {});

    // 2. Forbid GMS from triggering DND-override (PR #328 / 0.13.252).
    await this.shell('adb', [
      '-s', avd.serial, 'shell', 'cmd', 'notification',
      'disallow_dnd', 'com.google.android.gms',
    ]).catch(() => {});

    // 3. Lock-screen timeout to 30 min so the AVD doesn't sleep
    // mid-recipe. Maestro's failure when the screen is locked surfaces as
    // a generic selector miss, not an obvious "screen is locked" — costs
    // ~10 min of recipe-debug time per occurrence.
    await this.shell('adb', [
      '-s', avd.serial, 'shell', 'settings', 'put', 'system',
      'screen_off_timeout', '1800000',
    ]).catch(() => {});

    // Fingerprint = sha1(sorted-list-of-keys). Stable across runs;
    // changes only when the baseline itself changes.
    const sorted = [...settingsApplied].sort();
    const hash = crypto.createHash('sha1').update(sorted.join('|')).digest('hex');
    return hash.slice(0, 12); // short hash; full sha1 is overkill for drift detection
  }

  async loadSnapshot(avdName: string, snapshotName: string): Promise<SnapshotResult> {
    const avd = await this.requireRunningAvd(avdName);
    const r = await this.shell('adb', ['-s', avd.serial, 'emu', 'avd', 'snapshot', 'load', snapshotName]);
    return {
      avdName,
      snapshotName,
      saved: r.exitCode === 0 && !/error/i.test(r.stdout + r.stderr),
      output: (r.stdout + r.stderr).trim(),
    };
  }

  /**
   * Align the AVD's wall-clock to the host's wall-clock. Required after
   * `loadSnapshot` because Android emulator snapshots preserve the device's
   * wall-clock at capture time. If the snapshot was captured N hours ago,
   * the device wakes up thinking it's N hours in the past; the locally-cached
   * Connect Token's expiration check passes (`device_now < expiration`) so
   * the client attaches the token to API requests — but Connect's backend
   * runs on real time and rejects the request as authentication-missing.
   * Symptom: jobs list comes up empty with toast "You are not authorized to
   * make this request." Logcat shows
   *   `Unauthorized: Response Code: 401 | error:
   *   {"detail":"Authentication credentials were not provided."}
   *   for url /api/opportunity/`
   *
   * Fix is unconditional: ALWAYS sync the clock after a snapshot load. Don't
   * try to detect "is the skew big enough to matter" — every interactive
   * Connect path needs the wall-clock to be approximately right.
   *
   * Requires root (`adb root` first). Most Android Studio emulator images
   * are debuggable so this succeeds; on production-keys images it fails
   * silently — the caller swallows the error and the operator sees the
   * 401 instead.
   *
   * Returns `true` if the clock was set, `false` on any failure (caller
   * logs but does not throw — clock skew is a degraded-mode condition,
   * not a hard failure, and the underlying restore should still proceed).
   *
   * Verified live: 2026-05-14 — snapshot loaded ~10h45m after capture;
   * pre-fix `connect_fragment_jobs_list` was empty + 401; post-fix the
   * 4 expected opp tiles appeared on the very next `action_sync` tap.
   * See `docs/mobile-atlas/connect-2.62.0.md § Prerequisites`.
   */
  async syncDeviceClockToHost(avdName: string): Promise<boolean> {
    const avd = await this.requireRunningAvd(avdName);
    // `adb root` is needed to set the device wall-clock; the `shell` user
    // can't `settimeofday(2)`. Idempotent — emits a "restarting adbd as
    // root" line if not already root, no-ops otherwise.
    const rootR = await this.shell('adb', ['-s', avd.serial, 'root']);
    if (rootR.exitCode !== 0) {
      return false;
    }
    // adb root restarts adbd; wait for it to be ready again before
    // issuing the next command. wait-for-device blocks until the daemon
    // is back up; bounded by a short timeout via wait-for-online subset.
    await this.shell('adb', ['-s', avd.serial, 'wait-for-device']);
    // Format the host's local time as `MMDDhhmmYYYY.ss` — the `date` shell
    // built-in's accepted form on bionic. Use `date -u` would set UTC; we
    // use local time so the on-device timezone display matches the host.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      now.getFullYear() +
      '.' +
      pad(now.getSeconds());
    const setR = await this.shell('adb', ['-s', avd.serial, 'shell', `date ${stamp}`]);
    return setR.exitCode === 0;
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
