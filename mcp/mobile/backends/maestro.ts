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
  ): Promise<RecipeRunResult> {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const args = ['test', '--no-ansi'];
    for (const [k, v] of Object.entries(envVars)) {
      args.push('-e', `${k}=${v}`);
    }
    args.push('--output', screenshotDir, recipePath);
    const r = await this.shell('maestro', args, { timeoutMs: 10 * 60 * 1000 });
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
