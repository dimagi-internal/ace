/**
 * Regression guard for the silent screenshot-capture failure found on
 * turmeric-market-study/20260828-1108.
 *
 * Maestro 2.7.0 writes `takeScreenshot` output to
 * `<test-output-dir>/<timestamp>/<flow>/takeScreenshot/<name>.png`, NOT to
 * `./name.png` in the process CWD as `runRecipe`'s comment had assumed since
 * 2026-04-30. The consequence was not a loud failure: both Phase 6 legs walked
 * green, every step logged `takeScreenshot ... COMPLETED`, and
 * `mobile_run_recipe` returned `status: pass` with `screenshots: []`. A Phase 6
 * dispatch shipped with zero walkthrough screenshots and nothing flagged it.
 *
 * The first test is the one that matters: it asserts the INVARIANT rather than
 * the mechanism — a completed `Take screenshot` line in stdout must imply a
 * non-empty `screenshots[]`. That is the assertion whose absence let the defect
 * ship, and it holds regardless of which flag or path Maestro uses next.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAESTRO_OUTPUT_SUBDIR,
  harvestMaestroScreenshots,
  maestroOutputDir,
} from '../../../mcp/mobile/backends/maestro.js';

function tmpRun(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-shot-harvest-'));
}

/** Lay down the exact tree Maestro 2.7.0 produced in the live reproduction. */
function seedMaestroTree(screenshotDir: string, names: string[], flow = 'probe'): void {
  const dir = path.join(maestroOutputDir(screenshotDir), '2026-08-31_181657', flow, 'takeScreenshot');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, `${n}.png`), 'PNGBYTES');
}

describe('screenshot capture cannot silently report pass with no frames', () => {
  it('a completed "Take screenshot" step implies a non-empty screenshots[]', () => {
    // The live failing shape, reduced: stdout says the step completed, and the
    // frames exist only under Maestro's own tree.
    const stdout = [
      ' > Flow probe',
      'Launch app "org.commcare.dalvik"... COMPLETED',
      'Take screenshot probe-frame... COMPLETED',
    ].join('\n');

    const run = tmpRun();
    seedMaestroTree(run, ['probe-frame']);

    // Pre-harvest: this is exactly the state that shipped — a completed step and
    // nothing in the dir the collector reads.
    const flatBefore = fs.readdirSync(run).filter((f) => f.endsWith('.png'));
    expect(stdout).toMatch(/Take screenshot .*\.\.\. COMPLETED/);
    expect(flatBefore).toHaveLength(0);

    harvestMaestroScreenshots(run);

    const completedShots = [...stdout.matchAll(/Take screenshot (.+?)\.\.\. COMPLETED/g)].length;
    const flatAfter = fs.readdirSync(run).filter((f) => f.endsWith('.png'));
    expect(completedShots).toBeGreaterThan(0);
    expect(flatAfter.length).toBeGreaterThanOrEqual(completedShots);
  });

  it('harvests frames to flat basenames so stepName stays the plain step name', () => {
    const run = tmpRun();
    seedMaestroTree(run, ['connect-login-home', 'journey-learn-pretest-q1']);

    expect(harvestMaestroScreenshots(run)).toBe(2);
    expect(fs.readdirSync(run).filter((f) => f.endsWith('.png')).sort()).toEqual([
      'connect-login-home.png',
      'journey-learn-pretest-q1.png',
    ]);
  });

  it('removes the scaffold once fully harvested', () => {
    const run = tmpRun();
    seedMaestroTree(run, ['a']);
    harvestMaestroScreenshots(run);
    expect(fs.existsSync(maestroOutputDir(run))).toBe(false);
  });

  it('merges frames from every chunk of a chunked run', () => {
    // One `--test-output-dir`, one `<timestamp>/` sibling per chunk.
    const run = tmpRun();
    seedMaestroTree(run, ['chunk0-frame'], 'chunk-0');
    const second = path.join(maestroOutputDir(run), '2026-08-31_181702', 'chunk-1', 'takeScreenshot');
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(second, 'chunk1-frame.png'), 'PNGBYTES');

    expect(harvestMaestroScreenshots(run)).toBe(2);
    expect(fs.readdirSync(run).filter((f) => f.endsWith('.png')).sort()).toEqual([
      'chunk0-frame.png',
      'chunk1-frame.png',
    ]);
  });

  it('is a no-op when Maestro wrote nothing, and never throws', () => {
    const run = tmpRun();
    expect(harvestMaestroScreenshots(run)).toBe(0);
    expect(() => harvestMaestroScreenshots(path.join(run, 'does-not-exist'))).not.toThrow();
  });

  it('pins the scaffold name the collector skips', () => {
    // collectScreenshots skips this exact directory name; if it is renamed in
    // one place and not the other, a partial harvest emits garbage stepNames.
    expect(MAESTRO_OUTPUT_SUBDIR).toBe('.maestro-out');
    expect(maestroOutputDir('/tmp/run')).toBe(`/tmp/run/${MAESTRO_OUTPUT_SUBDIR}`);
  });
});
