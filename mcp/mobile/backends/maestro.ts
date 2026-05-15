import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RecipeValidationError } from '../errors.js';
import type { ShellFn } from './avd.js';
import { defaultShell } from './avd.js';
import { splitRecipeAtScreenshots } from '../recipe-splitter.js';
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
