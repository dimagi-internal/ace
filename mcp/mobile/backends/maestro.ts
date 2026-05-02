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
    // turmeric-20260429-2330 Phase 5 Step 2 round 4 (2026-04-30): every
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
