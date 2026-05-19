import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { MobileError, RecipeValidationError } from '../errors.js';
import type { ShellFn } from './avd.js';
import { defaultShell } from './avd.js';
import { splitRecipeAtScreenshots } from '../recipe-splitter.js';
import { logInfo } from '../logging.js';
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
    opts: { adbPort?: number; serial?: string } = {},
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

    // When `serial` is provided, we run the recipe as a SERIES of
    // sub-recipes split at every top-level `takeScreenshot:` boundary,
    // and between sub-recipes we capture the AVD's UI hierarchy XML
    // alongside each PNG. This is the only structurally-correct way to
    // capture per-surface dumps: Maestro's gRPC driver locks the
    // on-device `uiautomator` service exclusively while a `maestro test`
    // run is active, so a concurrent `adb shell uiautomator dump` from
    // a different host process fails (verified 2026-05-14 — see
    // `docs/learnings/2026-05-14-atlas-side-channel-capture.md`).
    // Between sub-recipes the driver is idle and the dump succeeds.
    //
    // When `serial` is NOT provided we keep the single-invocation path
    // — same behaviour as pre-0.13.229 for callers that don't need
    // dumps. This also preserves the exact shape that the
    // `MaestroBackend.runRecipe` unit tests assert against (one
    // `maestro test` shell call per `runRecipe`).
    if (opts.serial) {
      return this.runRecipeWithDumps(recipePath, envVars, screenshotDir, opts as { adbPort?: number; serial: string });
    }

    const args = this.buildMaestroArgs(opts.adbPort, envVars, screenshotDir, recipePath);
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
   * Build the `maestro` CLI args for a single recipe invocation.
   *
   * The `--host`/`--port` flags routing rationale and the cwd contract
   * are documented in `runRecipe` above.
   */
  private buildMaestroArgs(
    adbPort: number | undefined,
    envVars: Record<string, string>,
    screenshotDir: string,
    recipePath: string,
  ): string[] {
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
    if (typeof adbPort === 'number') {
      args.push('--host=localhost', `--port=${adbPort}`);
    }
    args.push('test', '--no-ansi');
    for (const [k, v] of Object.entries(envVars)) {
      args.push('-e', `${k}=${v}`);
    }
    // Resolve recipePath to absolute BEFORE the cwd-change; Maestro
    // resolves it relative to the new cwd otherwise.
    const absoluteRecipePath = path.isAbsolute(recipePath) ? recipePath : path.resolve(recipePath);
    args.push('--output', screenshotDir, absoluteRecipePath);
    return args;
  }

  /**
   * Split-and-run variant of `runRecipe`: splits the recipe at every
   * top-level `takeScreenshot:` boundary (see
   * `mcp/mobile/recipe-splitter.ts`) and runs each sub-recipe
   * sequentially, capturing a UI hierarchy XML dump in between.
   *
   * Each captured dump lands at
   * `<screenshotDir>/<screenshotName>.xml` — same basename as the PNG
   * Maestro just produced. Phase 6's `app-screenshot-capture` skill
   * picks them up alongside the PNGs in `collectScreenshots`.
   *
   * Failure model: if any sub-recipe exits non-zero, the loop stops
   * immediately — subsequent sub-recipes would run against a broken
   * mid-flow state and produce noise. The returned `exitCode` is the
   * first failing sub-recipe's exit code; `stdout` / `stderr` are
   * concatenated across all sub-recipes that DID run, separated by
   * marker lines so a reader can tell where each one started.
   */
  private async runRecipeWithDumps(
    recipePath: string,
    envVars: Record<string, string>,
    screenshotDir: string,
    opts: { adbPort?: number; serial: string },
  ): Promise<RecipeRunResult> {
    const absoluteRecipePath = path.isAbsolute(recipePath) ? recipePath : path.resolve(recipePath);
    const body = fs.readFileSync(absoluteRecipePath, 'utf8');
    const chunks = splitRecipeAtScreenshots(body);

    // Zero-screenshot recipes (e.g. probe recipes, or a recipe where
    // every `takeScreenshot:` is nested inside a `runFlow.commands`
    // block) collapse to a single chunk — no dump windows, fall back
    // to the simple single-invocation path so we don't pay the
    // chunk-write overhead for no benefit.
    if (chunks.length === 1 && !chunks[0].screenshotName) {
      const args = this.buildMaestroArgs(opts.adbPort, envVars, screenshotDir, absoluteRecipePath);
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

    // Per-chunk recipes go in a sibling tempdir so the screenshot dir
    // stays "screenshots + dumps", not "screenshots + dumps + chunk
    // YAMLs". Cleaned up on success; left behind on failure for
    // debugging.
    const chunkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-recipe-chunks-'));
    // Copy any sibling palette YAMLs from the resolved-recipe's directory
    // into the chunk dir so Maestro's relative-path `runFlow: file:` refs
    // resolve correctly when chunks invoke sub-flows like connect-login.yaml.
    // Without this, the splitter's per-chunk tempdir lacks the palette and
    // the first `runFlow` chunk fails with "Flow file does not exist".
    try {
      const recipeDir = path.dirname(absoluteRecipePath);
      const siblings = fs.readdirSync(recipeDir).filter((f) => f.endsWith('.yaml'));
      for (const f of siblings) {
        const src = path.join(recipeDir, f);
        const dest = path.join(chunkDir, f);
        try {
          fs.copyFileSync(src, dest);
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* best-effort — recipe dir might not be readable */
    }
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let lastExitCode = 0;

    try {
      for (const chunk of chunks) {
        const chunkPath = path.join(chunkDir, `chunk-${chunk.index}.yaml`);
        fs.writeFileSync(chunkPath, chunk.yaml, 'utf8');

        const args = this.buildMaestroArgs(opts.adbPort, envVars, screenshotDir, chunkPath);
        const r = await this.shell('maestro', args, { timeoutMs: 10 * 60 * 1000, cwd: screenshotDir });
        stdoutParts.push(`# --- chunk ${chunk.index} (screenshot=${chunk.screenshotName ?? 'none'}) ---\n${r.stdout}`);
        stderrParts.push(`# --- chunk ${chunk.index} (screenshot=${chunk.screenshotName ?? 'none'}) ---\n${r.stderr}`);
        lastExitCode = r.exitCode;
        if (r.exitCode !== 0) break;

        // Chunk passed and ended on a screenshot — quick window to
        // grab the UI hierarchy XML before the next chunk relaunches
        // the Maestro driver.
        if (chunk.screenshotName) {
          await this.captureUiDump(opts.serial, screenshotDir, chunk.screenshotName);
        }
      }
    } finally {
      if (lastExitCode === 0) {
        // Best-effort cleanup; ignore errors.
        try {
          fs.rmSync(chunkDir, { recursive: true, force: true });
        } catch {
          /* noop */
        }
      }
    }

    const screenshots = this.collectScreenshots(screenshotDir);
    return {
      status: lastExitCode === 0 ? 'pass' : 'fail',
      exitCode: lastExitCode,
      stdout: stdoutParts.join('\n'),
      stderr: stderrParts.join('\n'),
      screenshotsDir: screenshotDir,
      screenshots,
    };
  }

  /**
   * Capture the AVD's current UI hierarchy XML to
   * `<screenshotDir>/<screenshotName>.xml`. Two-step adb dance because
   * `uiautomator dump` writes to the device's filesystem; `adb pull`
   * brings it back. Failures are swallowed — a missing dump
   * degrades to "PNG without sibling XML", which is the pre-0.13.229
   * baseline.
   */
  private async captureUiDump(serial: string, screenshotDir: string, screenshotName: string): Promise<void> {
    const devicePath = `/sdcard/__ace-dump-${screenshotName}.xml`;
    const hostPath = path.join(screenshotDir, `${screenshotName}.xml`);
    try {
      const dumpRes = await this.shell('adb', ['-s', serial, 'shell', 'uiautomator', 'dump', devicePath], {
        timeoutMs: 10_000,
      });
      if (dumpRes.exitCode !== 0) return;
      await this.shell('adb', ['-s', serial, 'pull', devicePath, hostPath], { timeoutMs: 10_000 }).catch(() => {});
    } catch {
      /* noop — best-effort */
    }
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
   * Strategy:
   *
   * 1. **Force-stop** both halves. Often enough when the gRPC
   *    server is wedged but the APK is fine — but we still go through
   *    the destructive path because force-stop alone has been observed
   *    not to clear wedged instrumentation state (leep run
   *    20260511-0507, turmeric/20260513-2243 retry #2).
   * 2. **`adb uninstall`** both halves of the driver. Standard
   *    uninstall path — works for most wedged-driver states.
   * 3. **`pm uninstall -k --user 0`** both halves as a belt+braces
   *    follow-up. Some wedged-instrumentation states leave records
   *    that `adb uninstall` doesn't fully clear; the explicit user-0
   *    scope removes them.
   * 4. **Reinstall via `installDriverApks`** — explicitly push the
   *    bundled APKs back onto the device, wait for `pm` readiness,
   *    verify, and best-effort kick the instrumentation. Without this
   *    step the recovery ends with the device in a known-empty state
   *    and we rely on the Maestro CLI's implicit auto-push during the
   *    next `maestro hierarchy` call. That auto-push races early-boot
   *    `pm` availability and leaves the driver unreachable —
   *    live-reproduced on malaria-itn-fgd/20260515-1645 Phase 6
   *    attempt 4 against v0.13.263: probe1 wedged → ensureDriverInstalled
   *    saw both halves present → repair uninstalled them → probe2 hit
   *    UNAVAILABLE because nothing reinstalled.
   *
   * Self-contained: `repairDriver` now always ends with the packages
   * present in a freshly-installed state. Callers re-probe; the
   * post-repair probe has a real chance to succeed.
   *
   * Returns the list of recovery actions taken so the caller can surface
   * them in error messages.
   *
   * Throws `MobileError(MAESTRO_DRIVER_APK_MISSING)` /
   * `MobileError(MAESTRO_DRIVER_APK_INSTALL_FAILED)` /
   * `MobileError(AVD_PM_SERVICE_TIMEOUT)` if the post-destruction
   * reinstall cannot complete — surfaces a typed error rather than
   * leaving the AVD in a broken state.
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

    // Reinstall the freshly-cleared driver halves so the next probe
    // has packages to talk to. Without this the next `maestro
    // hierarchy` call has to push the APKs itself and races
    // early-boot `pm` availability — see method docstring for
    // live-repro reference.
    const installActions = await this.installDriverApks(serial);
    actions.push(...installActions);

    return actions;
  }

  /**
   * Idempotently install the Maestro driver APK halves
   * (`dev.mobile.maestro` + `dev.mobile.maestro.test`) onto a booted
   * AVD. Returns the list of actions taken so callers can surface them
   * in logs / error attempts.
   *
   * **Why this exists.** `repairDriver` relies on a documented Maestro CLI
   * behavior: "the next `maestro hierarchy` call reinstalls the driver
   * automatically (Maestro CLI bundles the APK and pushes it on first
   * contact)." That auto-push works on a warm AVD where Maestro has
   * already touched the device. On a **fresh AVD where the driver was
   * never installed** it races the AVD's early-boot `pm` service
   * availability — Maestro's first push hits "Install failed: cmd:
   * Can't find service: package", then subsequent `maestro hierarchy`
   * probes see an empty port 7001 (the driver's gRPC server never
   * started) and exit with `UNAVAILABLE: io exception` after
   * `timeoutMs`. There's no retry inside the CLI for this case.
   *
   * Reproduced live 2× on `malaria-itn-fgd/20260515-1645` Phase 6 across
   * a machine reboot — structural, not transient.
   *
   * **The fix.** Mirror the CommCare APK pattern (`runLocalBootstrap`
   * Step 1, `ensureCommCareApkCached` in `client.ts`): explicitly
   * `adb install -r` the driver halves from the operator's local
   * Maestro install, with a poll for `pm` readiness up front. Both
   * APKs ship bundled inside `~/.maestro/lib/maestro-client.jar` (we
   * verified the file naming + package IDs live on 0.13.x — see
   * commit message). Extract to a tempdir if not already cached.
   *
   * **Idempotency contract.** Cheap probe + early-return when both
   * packages are already installed. Safe to call before every
   * `assertMaestroDriverHealthy` re-probe; the success path on a warm
   * AVD adds one `pm list packages` call (~150ms).
   *
   * Throws `MobileError(MAESTRO_DRIVER_APK_MISSING)` when the bundled
   * APKs cannot be located on the host (operator hasn't run the
   * Maestro CLI installer yet — direct them at `/ace:mobile-bootstrap`).
   */
  async ensureDriverInstalled(serial: string): Promise<string[]> {
    const actions: string[] = [];
    // Step 1: cheap probe — BOTH packages already present? Return.
    // Each half is queried with its EXACT package name as the filter,
    // then we verify the exact name appears in the parsed line set.
    // The previous combined-prefix query (`pm list packages
    // dev.mobile.maestro` returning both halves in one call) was fragile
    // — a transient adb hiccup or unexpected stdout shape produced a
    // false "already-installed" verdict, and Stage 2's repairDriver
    // then uninstalled what was never installed. Live-reproduced on
    // malaria-itn-fgd/20260515-1645 Phase 6.
    const beforeApp = await this.isPackageInstalled(serial, 'dev.mobile.maestro');
    const beforeTest = await this.isPackageInstalled(serial, 'dev.mobile.maestro.test');
    actions.push(`package-list-before:app=${beforeApp},test=${beforeTest}`);
    if (beforeApp && beforeTest) {
      actions.push('already-installed');
      return actions;
    }

    // Fall through to the shared install tail. We install regardless of
    // beforeApp/beforeTest here so a half-installed state (one APK
    // missing, the other stale) heals.
    const installActions = await this.installDriverApks(serial);
    actions.push(...installActions);
    return actions;
  }

  /**
   * Push the bundled Maestro driver APKs onto a booted AVD. Shared tail
   * between `ensureDriverInstalled` (probe-then-install path) and
   * `repairDriver` (force-uninstall-then-install path).
   *
   * Steps:
   * 1. Wait for the AVD's `pm` package service to bind.
   * 2. Extract `maestro-app.apk` + `maestro-server.apk` from
   *    `~/.maestro/lib/maestro-client.jar` (cached by mtime).
   * 3. `adb install -r -t` both halves.
   * 4. Verify via `pm list packages`.
   * 5. Best-effort `am instrument` kick to nudge the gRPC server.
   *
   * Throws `MobileError(MAESTRO_DRIVER_APK_MISSING)` when the bundled
   * APKs aren't on the host, `MobileError(MAESTRO_DRIVER_APK_INSTALL_FAILED)`
   * if the install round-trip doesn't produce both packages on-device,
   * or `MobileError(AVD_PM_SERVICE_TIMEOUT)` if `pm` never binds.
   */
  private async installDriverApks(serial: string): Promise<string[]> {
    const actions: string[] = [];
    // Step 1: wait for the AVD's `pm` package service. Fresh boot races
    // here — `pm list packages` returns "Can't find service: package"
    // until the package manager binds. Cheap probe; ~150ms when ready.
    await this.waitForPackageManager(serial, 30_000);
    actions.push('pm-ready');

    // Step 2: locate the driver APKs on disk. Cache in a tempdir so we
    // don't re-extract the jar on every call.
    const apks = await this.resolveDriverApks();
    actions.push('apks-resolved');

    // Step 3: install both halves. `adb install -r` is idempotent across
    // re-installs.
    let appResult: 'ok' | 'fail' = 'fail';
    let testResult: 'ok' | 'fail' = 'fail';
    try {
      await this.adbInstall(serial, apks.app);
      appResult = 'ok';
      actions.push('installed:app');
    } catch (e) {
      actions.push('install-failed:app');
      throw e;
    }
    try {
      await this.adbInstall(serial, apks.test);
      testResult = 'ok';
      actions.push('installed:test');
    } catch (e) {
      actions.push('install-failed:test');
      throw e;
    }
    actions.push(`apk-install-results:app=${appResult},test=${testResult}`);

    // Step 4: verify. If a verify-after-install miss happens we throw
    // a typed error rather than silently letting the next probe fail
    // with the same UNAVAILABLE that triggered us here.
    const afterApp = await this.isPackageInstalled(serial, 'dev.mobile.maestro');
    const afterTest = await this.isPackageInstalled(serial, 'dev.mobile.maestro.test');
    actions.push(`package-list-after:app=${afterApp},test=${afterTest}`);
    if (!afterApp || !afterTest) {
      throw new MobileError(
        'MAESTRO_DRIVER_APK_INSTALL_FAILED',
        `adb install reported success but ${[
          !afterApp ? 'dev.mobile.maestro' : null,
          !afterTest ? 'dev.mobile.maestro.test' : null,
        ].filter(Boolean).join(' + ')} is still absent from \`pm list packages\` on ${serial}.`,
        'Capture `adb -s <serial> logcat | grep -i "PackageManager\\|maestro"` and rerun /ace:mobile-bootstrap. The AVD may be out of disk space or have a corrupt user image.',
      );
    }
    actions.push('verified');

    // Step 5: kick the test runner to nudge the gRPC server toward
    // binding. Maestro's CLI normally starts the driver via
    // `am instrument` on first contact, but the post-install hand-off
    // can stall ~10-30s. Pre-warming with the same instrumentation
    // invocation Maestro itself uses (`-w` waits for completion which
    // we explicitly do NOT want here — we want it backgrounded). We
    // detach via `nohup ... &` so the shell call returns immediately;
    // any failure is best-effort and surfaces as a probe miss
    // downstream rather than a hard error here.
    await this.shell(
      'adb',
      [
        '-s', serial,
        'shell',
        'am', 'instrument', '-e', 'debug', 'false',
        'dev.mobile.maestro.test/androidx.test.runner.AndroidJUnitRunner', '&',
      ],
      { timeoutMs: 3_000 },
    ).catch(() => {});
    actions.push('instrumentation-kicked');
    return actions;
  }

  /**
   * Exact-name "is this package installed on the device?" check. Queries
   * `pm list packages <pkg>` (substring filter on the device) and then
   * asserts that the EXACT package name appears in the parsed line set —
   * so `dev.mobile.maestro.foo` wouldn't be misread as
   * `dev.mobile.maestro` being present. Returns `false` on any adb error
   * (hiccup, timeout, "Can't find service: package" on fresh boot) so
   * the caller falls through to the install path rather than
   * short-circuiting on stale state.
   */
  private async isPackageInstalled(serial: string, pkg: string): Promise<boolean> {
    const r = await this.shell(
      'adb',
      ['-s', serial, 'shell', 'pm', 'list', 'packages', pkg],
      { timeoutMs: 8_000 },
    ).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    if (r.exitCode !== 0) return false;
    const lines = (r.stdout || '')
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((l) => l.length > 0);
    return lines.includes(pkg);
  }

  /**
   * Poll `cmd package list packages` until it returns successfully (the
   * package manager service is bound) or `timeoutMs` elapses. On fresh
   * AVDs `pm` can race ~5-15s past `sys.boot_completed=1`. Without this
   * wait, the first `adb install` hits "Install failed: cmd: Can't find
   * service: package" and aborts.
   */
  private async waitForPackageManager(serial: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      const r = await this.shell(
        'adb',
        ['-s', serial, 'shell', 'cmd', 'package', 'list', 'packages'],
        { timeoutMs: 5_000 },
      ).catch((e: any) => ({ stdout: '', stderr: String(e?.message ?? e), exitCode: 1 }));
      if (r.exitCode === 0 && /package:/.test(r.stdout)) return;
      lastErr = (r.stderr || r.stdout || '').slice(0, 160);
      await new Promise((res) => setTimeout(res, 1_000));
    }
    throw new MobileError(
      'AVD_PM_SERVICE_TIMEOUT',
      `AVD ${serial} did not finish binding the \`package\` service within ${Math.round(timeoutMs / 1000)}s (last: ${lastErr || 'unknown'}).`,
      'The emulator may be stuck mid-boot. Try `mobile_stop_avd` then `mobile_ensure_avd_running` to cold-restart; if it persists, wipe the AVD user data via Android Studio.',
    );
  }

  /**
   * `adb install -r <apkPath>` with success-line validation. `-r`
   * (reinstall) makes this idempotent across calls: installing the
   * same APK over itself is a no-op when the signature matches.
   */
  private async adbInstall(serial: string, apkPath: string): Promise<void> {
    logInfo(`maestro_driver: installing ${path.basename(apkPath)} on ${serial}`);
    const r = await this.shell('adb', ['-s', serial, 'install', '-r', apkPath], { timeoutMs: 60_000 });
    if (r.exitCode !== 0 || !/Success/.test(r.stdout)) {
      throw new MobileError(
        'MAESTRO_DRIVER_APK_INSTALL_FAILED',
        `adb install ${path.basename(apkPath)} on ${serial} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 240)}`,
        'Check `adb -s <serial> shell df /data` for disk pressure; rerun /ace:mobile-bootstrap to refresh the AVD baseline.',
      );
    }
  }

  /**
   * Locate the two driver APKs on the host. They ship bundled inside
   * `~/.maestro/lib/maestro-client.jar` (verified on Maestro CLI 1.39.x
   * and 2.3.0 — file naming preserved across the v1 → v2 break:
   * `maestro-app.apk` and `maestro-server.apk` at the jar root, same
   * package IDs `dev.mobile.maestro` + `dev.mobile.maestro.test`).
   * Extract once to a per-version tempdir; reuse on subsequent calls.
   */
  private async resolveDriverApks(): Promise<{ app: string; test: string }> {
    const home = process.env.HOME || os.homedir();
    const jarPath = path.join(home, '.maestro', 'lib', 'maestro-client.jar');
    if (!fs.existsSync(jarPath)) {
      throw new MobileError(
        'MAESTRO_DRIVER_APK_MISSING',
        `Cannot find Maestro driver APKs — ${jarPath} does not exist (Maestro CLI not installed under this user).`,
        'Run /ace:mobile-bootstrap (Step 1) to install Maestro: `curl -Ls "https://get.maestro.mobile.dev" | bash`.',
      );
    }
    // Cache extraction under tmpdir keyed by jar mtime, so re-runs are
    // fast and a `maestro update` invalidates the cache automatically.
    const stat = fs.statSync(jarPath);
    const tag = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
    const cacheDir = path.join(os.tmpdir(), 'ace-maestro-driver-cache', tag);
    const appPath = path.join(cacheDir, 'maestro-app.apk');
    const testPath = path.join(cacheDir, 'maestro-server.apk');
    if (fs.existsSync(appPath) && fs.existsSync(testPath)) {
      return { app: appPath, test: testPath };
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    // `unzip` ships in macOS + most Linux distros; we don't depend on
    // a Node zip library to keep the surface small (CommCare APK
    // handling already uses raw fs + magic-byte validation, not a zip
    // parser). Failures fall through to a typed error.
    try {
      execSync(`unzip -o -q ${JSON.stringify(jarPath)} maestro-app.apk maestro-server.apk -d ${JSON.stringify(cacheDir)}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch (e: any) {
      throw new MobileError(
        'MAESTRO_DRIVER_APK_MISSING',
        `Failed to extract driver APKs from ${jarPath}: ${(e?.stderr?.toString?.() || e?.message || String(e)).slice(0, 240)}.`,
        'Verify `unzip` is on PATH (`brew install unzip` / `apt install unzip`). The APKs are bundled inside maestro-client.jar; if the jar is truncated, rerun the Maestro installer.',
      );
    }
    if (!fs.existsSync(appPath) || !fs.existsSync(testPath)) {
      throw new MobileError(
        'MAESTRO_DRIVER_APK_MISSING',
        `Extracted maestro-client.jar but driver APKs are absent at ${appPath} / ${testPath} — jar layout may have changed in this Maestro version.`,
        'File an issue with the Maestro CLI version (`maestro --version`); meanwhile manually `unzip ~/.maestro/lib/maestro-client.jar` and copy maestro-app.apk + maestro-server.apk to ${cacheDir}.',
      );
    }
    return { app: appPath, test: testPath };
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
        const stepName = f.replace(/\.png$/, '');
        // Pair the PNG with its sibling UI dump if `runRecipeWithDumps`
        // captured one (same basename, .xml suffix). Absence is the
        // normal pre-0.13.229 case (caller didn't pass `serial`); we
        // silently omit `uiDumpPath` so legacy consumers see no
        // change.
        const dumpPath = path.join(dir, `${stepName}.xml`);
        let uiDumpPath: string | undefined;
        let uiDumpBytes: number | undefined;
        if (fs.existsSync(dumpPath)) {
          const dumpStat = fs.statSync(dumpPath);
          uiDumpPath = dumpPath;
          uiDumpBytes = dumpStat.size;
        }
        const entry: ScreenshotEntry = {
          stepName,
          path: full,
          takenAt: stat.mtime.toISOString(),
          bytes: stat.size,
        };
        if (uiDumpPath !== undefined) {
          entry.uiDumpPath = uiDumpPath;
          entry.uiDumpBytes = uiDumpBytes;
        }
        return entry;
      });
  }
}
