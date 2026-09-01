import { describe, it, expect, vi } from 'vitest';
import { runRecipeWithDriverHeal } from '../../../mcp/mobile/maestro-driver-retry.js';
import { finalizeRecipeResult } from '../../../mcp/mobile/backends/maestro.js';
import type { RecipeRunResult } from '../../../mcp/mobile/types.js';

/**
 * dimagi-internal/ace#1822 — bednet-check-2-visit/20260828-0629.
 *
 * A Learn walk completed (Connect flipped `learn_complete: true`; 35 non-zero
 * PNGs; zero `*-FAILURE.*` forensics, which `mobile_run_recipe` writes on
 * EVERY genuine step failure) and was reported as a failure. Two mechanisms
 * stacked:
 *
 *   1. A session-TEARDOWN exception (`MaestroSession.close` ->
 *      `AndroidDriver.close` -> `AdbWriter.writeClose`) carried `Broken
 *      pipe`, which classifies as `driver` — the one class the heal-and-retry
 *      envelope acts on.
 *   2. `await opts.heal()` was UNGUARDED, so when the cold boot's own
 *      registration failed, its error propagated and the attempt's result —
 *      screenshots, videos, screenshotsDir, step log — was discarded.
 *
 * Learn completion is one-way per (test user, opportunity) (#568/#570), and
 * #573 rules out a mid-run opportunity re-mint, so a false failure here costs
 * a whole fresh `/ace:run`. Nothing in these tests may make a GENUINE
 * mid-walk failure pass.
 */

const TEARDOWN_STACK = [
  'Exception in thread "Thread-5" java.net.SocketException: Broken pipe',
  '\tat dadb.AdbWriter.writeClose(AdbWriter.kt:60)',
  '\tat maestro.drivers.AndroidDriver.close(AndroidDriver.kt:184)',
  '\tat maestro.cli.session.MaestroSessionManager$MaestroSession.close(MaestroSessionManager.kt:467)',
].join('\n');

function result(
  status: 'pass' | 'fail',
  failureClass?: 'driver' | 'selector-not-found',
  screenshots: RecipeRunResult['screenshots'] = [],
): RecipeRunResult {
  return {
    status,
    exitCode: status === 'pass' ? 0 : 1,
    stdout: '',
    stderr: '',
    screenshotsDir: '/tmp/run/journey-learn',
    screenshots,
    videos: [{ path: '/tmp/run/journey-learn/walk.mp4' } as never],
    failure: failureClass ? { failureClass, stderrExcerpt: failureClass } : undefined,
  } as RecipeRunResult;
}

const THIRTY_FIVE_FRAMES = Array.from({ length: 35 }, (_, i) => ({
  stepName: `frame-${i}`,
  path: `/tmp/run/journey-learn/frame-${i}.png`,
  takenAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  bytes: 40_000,
})) as RecipeRunResult['screenshots'];

describe('runRecipeWithDriverHeal — a heal failure must never discard the attempt (ace#1822)', () => {
  it('returns the attempt’s own result, with its 35 frames, when the cold-boot heal throws', async () => {
    const attempt = result('fail', 'driver', THIRTY_FIVE_FRAMES);
    const runOnce = vi.fn().mockResolvedValue(attempt);
    // The exact heal failure from the run: the cold boot's registration died.
    const heal = vi
      .fn()
      .mockRejectedValue(new Error('register_test_user part A failed: Broken pipe'));

    const r = await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 });

    // The dispatch did real, UNREPEATABLE work. It must come back.
    expect(r.screenshots).toHaveLength(35);
    expect(r.screenshots[0].takenAt).toBeTruthy();
    expect(r.videos).toHaveLength(1);
    expect(r.screenshotsDir).toBe('/tmp/run/journey-learn');
    // Still honestly a failure — the walk is not being laundered into a pass.
    expect(r.status).toBe('fail');
    // And the heal failure is reported, not swallowed.
    expect(r.warnings?.join(' ')).toMatch(/cold-boot heal failed/);
    expect(r.warnings?.join(' ')).toMatch(/register_test_user part A failed/);
    expect(runOnce).toHaveBeenCalledTimes(1); // no retry happened — the heal died
  });

  it('reports the ORIGINAL fault, not the heal’s, when a transport throw’s heal also fails', async () => {
    const original = new Error('socket hang up');
    const runOnce = vi.fn().mockRejectedValue(original);
    const heal = vi.fn().mockRejectedValue(new Error('register_test_user part A failed: Broken pipe'));

    await expect(runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 })).rejects.toThrow(
      /socket hang up/,
    );
    // The heal failure is attached alongside rather than replacing it —
    // pre-fix, the cold-boot error was ALL the caller saw.
    await expect(
      runRecipeWithDriverHeal({ runOnce: vi.fn().mockRejectedValue(new Error('socket hang up')), heal, maxRetries: 1 }),
    ).rejects.toThrow(/cold-boot heal also failed/);
  });

  it('still heals and retries normally when the heal succeeds', async () => {
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(result('fail', 'driver'))
      .mockResolvedValueOnce(result('pass'));
    const heal = vi.fn().mockResolvedValue(undefined);

    const r = await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 });

    expect(r.status).toBe('pass');
    expect(r.warnings).toBeUndefined();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});

/**
 * CONTROL for the half of this PR whose fix lives in a NEW function.
 *
 * `finalizeRecipeResult` and `classifyTeardownFailure` did not exist before
 * ace#1822, so reverting the source cannot produce an honest red run for them
 * (a missing export is an import failure, not a detection). What CAN be
 * asserted against untouched code is the behaviour that used to decide the
 * verdict: `classifyMaestroFailure` — which this PR does not modify — reads
 * the incident's teardown stack as a `driver` death, and `driver` is the one
 * class the heal-and-retry envelope acts on. That is the input; the delta is
 * what `finalizeRecipeResult` now does with it.
 */
describe('CONTROL: the untouched classifier still reads a teardown stack as a driver death', () => {
  it('classifyMaestroFailure(teardown stack) === driver — the signal the fix reinterprets', async () => {
    const { classifyMaestroFailure } = await import('../../../lib/maestro-failure-class.js');
    const c = classifyMaestroFailure({
      stdout: ' ==> takeScreenshot: journey-learn-final  COMPLETED',
      stderr: TEARDOWN_STACK,
      exitCode: 1,
    });
    expect(c.failureClass).toBe('driver');
  });
});

describe('finalizeRecipeResult — teardown is a warning, not a verdict (ace#1822)', () => {
  const base = {
    stdout: ' ==> takeScreenshot: journey-learn-final  COMPLETED',
    screenshotsDir: '/tmp/run/journey-learn',
    screenshots: THIRTY_FIVE_FRAMES,
  };

  it('passes a completed walk whose only fault was session teardown', () => {
    const r = finalizeRecipeResult({
      ...base,
      exitCode: 1,
      stderr: TEARDOWN_STACK,
      walkCompleted: true,
    });
    expect(r.status).toBe('pass');
    expect(r.failure?.failureClass).toBe('pass');
    expect(r.warnings?.join(' ')).toMatch(/teardown threw AFTER the last step completed/);
    // The non-zero exit is NOT laundered away — that asymmetry is the audit trail.
    expect(r.exitCode).toBe(1);
    expect(r.screenshots).toHaveLength(35);
  });

  it('FAILS a teardown fault when the walk did not reach the end', () => {
    // The 20260828-0629 shape exactly: the FINISH press landed, but the two
    // frames after it never ran, so the recipe is genuinely incomplete.
    const r = finalizeRecipeResult({
      ...base,
      exitCode: 1,
      stderr: TEARDOWN_STACK,
      walkCompleted: false,
    });
    expect(r.status).toBe('fail');
    expect(r.failure?.failureClass).toBe('driver');
    expect(r.warnings).toBeUndefined();
    // ...and the frames it DID capture still come back on the result.
    expect(r.screenshots).toHaveLength(35);
  });

  it('FAILS a completed walk whose output also shows a real step failure', () => {
    const r = finalizeRecipeResult({
      ...base,
      exitCode: 1,
      stdout: `${base.stdout}\nElement not found: id=rvJobList`,
      stderr: TEARDOWN_STACK,
      walkCompleted: true,
    });
    expect(r.status).toBe('fail');
    expect(r.warnings).toBeUndefined();
    // The class stays `driver`, per the existing precedence ladder in
    // `maestro-failure-class.ts` — `Broken pipe` outranks the selector miss.
    // That is unchanged and correct; what this pins is that the presence of a
    // real step failure blocks the teardown reading entirely.
    expect(r.failure?.failureClass).toBe('driver');
  });

  it('leaves an ordinary pass and an ordinary failure exactly as they were', () => {
    const pass = finalizeRecipeResult({ ...base, exitCode: 0, stderr: '', walkCompleted: true });
    expect(pass.status).toBe('pass');
    expect(pass.warnings).toBeUndefined();

    const fail = finalizeRecipeResult({
      ...base,
      exitCode: 1,
      stderr: 'Element not found: id=nav_btn_next',
      walkCompleted: true,
    });
    expect(fail.status).toBe('fail');
    expect(fail.failure?.failureClass).toBe('selector-not-found');
    expect(fail.warnings).toBeUndefined();
  });

  it('classifies from the failing chunk block when one is supplied', () => {
    const r = finalizeRecipeResult({
      ...base,
      exitCode: 1,
      stderr: 'chunk 1 noise\nchunk 2 noise',
      classifyStderr: 'Element not found: id=rvJobList',
      walkCompleted: false,
    });
    expect(r.failure?.failureClass).toBe('selector-not-found');
  });
});

// ---------------------------------------------------------------------------
// The client-side half: a THROWN dispatch must still hand back what it wrote.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MobileClient } from '../../../mcp/mobile/client.js';
import type { ThrownRecipePartial } from '../../../mcp/mobile/types.js';

function tmpRecipe(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ace1822-rp-')), 'journey-learn.yaml');
  fs.writeFileSync(p, 'appId: org.commcare.dalvik\n---\n- launchApp\n');
  return p;
}

describe('client.runRecipe — a thrown dispatch still reports what it captured (ace#1822)', () => {
  it('attaches screenshots (with takenAt), videos and screenshotsDir to the thrown error', async () => {
    // Screenshot roots are contained under `<tmp>/ace-screenshots` (ace#1111);
    // `dispatchOutputDir` refuses anything else.
    const shotRoot = path.join(os.tmpdir(), 'ace-screenshots');
    fs.mkdirSync(shotRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(shotRoot, 'ace1822-out-'));
    const recipePath = tmpRecipe();

    // Maestro writes real frames, then the transport dies — the shape of a
    // walk that did unrepeatable work and then threw.
    const maestro = {
      runRecipe: vi.fn(async (_r: string, _e: unknown, runDir: string) => {
        fs.mkdirSync(runDir, { recursive: true });
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(path.join(runDir, `journey-learn-${i}.png`), Buffer.alloc(1024, 1));
        }
        throw new Error('socket hang up');
      }),
    };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: {
        findRunningAvd: vi.fn().mockResolvedValue(null),
        getAdbShell: () => vi.fn(),
      } as never,
      cloud: null as never,
      bootstrapConfig: null,
    });

    let thrown: unknown;
    await client.runRecipe(recipePath, {}, root).catch((e) => {
      thrown = e;
    });

    // The throw is STILL a throw — callers that catch it keep catching it.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/socket hang up/);

    const partial = (thrown as { partialResult?: ThrownRecipePartial }).partialResult;
    expect(partial).toBeDefined();
    expect(partial!.status).toBe('error');
    expect(partial!.screenshots).toHaveLength(3);
    // `takenAt` is the specific field the Deliver duration-floor gate in
    // skills/app-screenshot-capture Step 5 reads; a thrown dispatch had no
    // route to it at all before this.
    expect(partial!.screenshots[0].takenAt).toBeTruthy();
    expect(partial!.screenshotsDir).toBe(path.join(root, 'journey-learn'));
    expect(partial!.recipeId).toBe('journey-learn');
    expect(partial!.dispatchId).toBeTruthy();
  });
});
