import * as fs from 'node:fs';
import * as path from 'node:path';
import { RecipeValidationError } from '../errors.js';
import type { ShellFn } from './avd.js';
import { defaultShell } from './avd.js';
import type { RecipeRunResult, ScreenshotEntry } from '../types.js';

const ALLOWED_STEP_KEYS = new Set([
  'launchApp',
  'tapOn',
  'inputText',
  'takeScreenshot',
  'assertVisible',
  'assertNotVisible',
  'extendedWaitUntil',
  'waitForAnimationToEnd',
  'eraseText',
  'swipe',
  'pressKey',
  'back',
  'scroll',
  'hideKeyboard',
  'copyTextFrom',
  'pasteText',
  'runFlow',
  'evalScript',
  'stopApp',
]);

export interface MaestroBackendOpts {
  shell?: ShellFn;
}

export class MaestroBackend {
  private shell: ShellFn;
  constructor(opts: MaestroBackendOpts = {}) {
    this.shell = opts.shell ?? defaultShell;
  }

  async runRecipe(
    recipePath: string,
    envVars: Record<string, string>,
    screenshotDir: string,
    opts: { adbPort?: number } = {},
  ): Promise<RecipeRunResult> {
    fs.mkdirSync(screenshotDir, { recursive: true });
    // Maestro's `takeScreenshot: "name"` writes to `./name.png` in the
    // process CWD, NOT to `--output` (which is for junit / debug-bundle
    // reports, not PNGs). Setting cwd to screenshotDir is what makes
    // `takeScreenshot: "connect-login-home"` land at
    // `<screenshotDir>/connect-login-home.png`. Surfaced live in
    // turmeric-20260429-2330 Phase 6 Step 2 round 4 (2026-04-30): every
    // recipe reported `takeScreenshot ... COMPLETED` but screenshotDir
    // ended up empty. The recipes were correct; the cwd was wrong.
    const args: string[] = [];
    // When the caller knows the target emulator's adb port, prefer
    // Maestro's hidden top-level `--host` / `--port` flags over relying on
    // device auto-discovery. With these set, `DeviceService.listAndroidDevices`
    // takes the `Dadb.create(host, port)` direct-TCP path and never touches
    // `Dadb.list` / the local `adb` server. That bypasses a dadb-1.2.10
    // bug where `AdbServer.listDadbs` aborts the entire device enumeration
    // on the first `unauthorized` device — fatal on shared workstations
    // where another user's emulators are visible to your adb server but
    // not authorized for your adbkey. Verified live 2026-05-01: dropping
    // these flags makes maestro report 0 connected devices any time a
    // sibling user's emulator is up; restoring them lets it talk to our
    // emulator directly. The flags are picocli-defined on `App.class` but
    // omitted from `--help`, so they are effectively undocumented; pinning
    // them to a known-stable form here.
    if (typeof opts.adbPort === 'number') {
      args.push('--host=localhost', `--port=${opts.adbPort}`);
    }
    args.push('test', '--no-ansi');
    for (const [k, v] of Object.entries(envVars)) {
      args.push('-e', `${k}=${v}`);
    }
    // Resolve recipePath to absolute BEFORE the cwd-change; Maestro
    // resolves it relative to the new cwd otherwise.
    const absoluteRecipePath = path.isAbsolute(recipePath) ? recipePath : path.resolve(recipePath);
    args.push('--output', screenshotDir, absoluteRecipePath);
    const r = await this.shell('maestro', args, { timeoutMs: 10 * 60 * 1000, cwd: screenshotDir });
    const screenshots = this.collectScreenshots(screenshotDir);
    return {
      status: r.exitCode === 0 ? 'pass' : 'fail',
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      screenshotsDir: screenshotDir,
      screenshots,
    };
  }

  /**
   * Probe the Maestro driver app's gRPC liveness on a booted AVD.
   *
   * Failure mode this exists to catch: the AVD is booted and `adb` shows it
   * as `device`, but `dev.mobile.maestro` (the on-device driver app) isn't
   * answering on its gRPC channel — every `maestro test` returns
   * `deviceInfo ... UNAVAILABLE` after a ~30s timeout and Phase 6
   * `app-screenshot-capture` degrades to `verdict: incomplete`. The
   * canonical symptom we hit live in leep run 20260511-0507.
   *
   * Cheapest non-mutating Maestro command that requires the driver is
   * `maestro hierarchy`. On a healthy AVD it returns ~2 s; on a hung
   * driver it hangs until `timeoutMs`.
   *
   * Returns `{ healthy: true }` on success and `{ healthy: false, reason }`
   * on any failure path — callers decide whether to recover.
   */
  async probeDriver(adbPort: number, timeoutMs: number = 8_000): Promise<{ healthy: boolean; reason?: string }> {
    try {
      const r = await this.shell(
        'maestro',
        ['--host=localhost', `--port=${adbPort}`, 'hierarchy'],
        { timeoutMs },
      );
      if (r.exitCode === 0) return { healthy: true };
      return { healthy: false, reason: `maestro hierarchy exit ${r.exitCode}: ${r.stderr.slice(0, 160) || r.stdout.slice(0, 160)}` };
    } catch (e: any) {
      return { healthy: false, reason: e?.message ? String(e.message).slice(0, 200) : 'unknown' };
    }
  }

  /**
   * Force-recover the Maestro driver app on an AVD. Idempotent.
   *
   * Three-step strategy:
   *
   * 1. **Force-stop** the driver process. Often enough when the gRPC
   *    server is wedged but the APK is fine.
   * 2. **`adb uninstall`** both halves of the driver. Standard
   *    uninstall path — works for most wedged-driver states.
   * 3. **`pm uninstall -k --user 0`** both halves as a belt+braces
   *    follow-up. Some wedged-instrumentation states leave records
   *    that `adb uninstall` doesn't fully clear; the explicit user-0
   *    scope removes them. Verified live on turmeric/20260513-2243
   *    retry #2 — manual intervention with this command unstuck a
   *    driver state that the prior two steps couldn't reach.
   *
   * The next `maestro hierarchy` call reinstalls the driver
   * automatically (Maestro CLI bundles the APK and pushes it on
   * first contact).
   *
   * Caller is expected to re-probe after this returns; this method does
   * not itself confirm health. Returns the list of recovery actions taken
   * so the caller can surface them in error messages.
   */
  async repairDriver(serial: string): Promise<string[]> {
    const actions: string[] = [];
    await this.shell('adb', ['-s', serial, 'shell', 'am', 'force-stop', 'dev.mobile.maestro']).catch(() => {});
    await this.shell('adb', ['-s', serial, 'shell', 'am', 'force-stop', 'dev.mobile.maestro.test']).catch(() => {});
    actions.push('force-stop');

    await this.shell('adb', ['-s', serial, 'uninstall', 'dev.mobile.maestro']).catch(() => {});
    await this.shell('adb', ['-s', serial, 'uninstall', 'dev.mobile.maestro.test']).catch(() => {});
    actions.push('uninstall');

    // Belt+braces: pm uninstall -k --user 0 catches wedged
    // instrumentation state that the standard `adb uninstall` above
    // doesn't fully clear. Idempotent — succeeds when packages still
    // present, succeeds when already removed.
    await this.shell('adb', ['-s', serial, 'shell', 'pm', 'uninstall', '-k', '--user', '0', 'dev.mobile.maestro']).catch(() => {});
    await this.shell('adb', ['-s', serial, 'shell', 'pm', 'uninstall', '-k', '--user', '0', 'dev.mobile.maestro.test']).catch(() => {});
    actions.push('pm-uninstall-user-0');

    return actions;
  }

  /**
   * Lightweight YAML structural validation. Maestro doesn't ship a public
   * --validate flag we can rely on across versions, so we parse the YAML
   * ourselves and reject unknown step keys early.
   */
  async validateRecipe(recipePath: string): Promise<void> {
    const content = fs.readFileSync(recipePath, 'utf8');
    const docs = content.split(/^---\s*$/m);
    if (docs.length < 2) throw new RecipeValidationError(recipePath, 'missing --- separator');

    const flow = docs[1];
    const stepLines = flow.split('\n').filter((l) => l.trim().startsWith('- '));
    for (const line of stepLines) {
      const keyMatch = line.match(/^\s*-\s+([a-zA-Z]+)/);
      if (!keyMatch) continue;
      const key = keyMatch[1];
      if (!ALLOWED_STEP_KEYS.has(key)) {
        throw new RecipeValidationError(recipePath, `unknown step key: ${key}`);
      }
    }
  }

  private collectScreenshots(dir: string): ScreenshotEntry[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        return {
          stepName: f.replace(/\.png$/, ''),
          path: full,
          takenAt: stat.mtime.toISOString(),
          bytes: stat.size,
        };
      });
  }
}
