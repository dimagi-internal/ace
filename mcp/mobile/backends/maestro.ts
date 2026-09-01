import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { MobileError, RecipeValidationError } from '../errors.js';
import type { ShellFn } from './avd.js';
import { defaultShell } from './avd.js';
import { splitRecipeAtScreenshots } from '../recipe-splitter.js';
import { resolveChunkTimeout, countRecipeSteps } from '../../../lib/maestro-chunk-timeout.js';
import { classifyTeardownFailure, teardownWarning } from '../../../lib/maestro-teardown.js';

/**
 * Step count for a recipe on disk, or `undefined` when it cannot be read.
 * Sizing a timeout must never be able to fail a run, so every error here
 * degrades to the floor (ace#1570).
 */
function safeCountSteps(recipePath: string): number | undefined {
  try {
    return countRecipeSteps(fs.readFileSync(recipePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Kill switch for subflow-aware chunking (ace#1570). Set
 * `ACE_MOBILE_SPLIT_AT_SUBFLOW_SCREENSHOTS=off` to fall back to the
 * top-level-only splitting that shipped before it — an operator on a live
 * Phase 6 leg can revert without waiting for a plugin update.
 */
export const SUBFLOW_SPLIT_ENV = 'ACE_MOBILE_SPLIT_AT_SUBFLOW_SCREENSHOTS';

/**
 * Reader for the palette files a recipe's `runFlow: file:` steps name.
 *
 * Rooted at the RESOLVED recipe's own directory, which is exactly how Maestro
 * resolves those refs — `prepareRecipeForMaestro` copies every palette file in
 * next to the top-level recipe — so the splitter reads the same bytes the
 * device will run, not whatever is newest in the install. Returns `null` for
 * anything it can't read or that escapes that directory; the splitter then
 * behaves as it did before ace#1570.
 */
export function subflowResolverFor(
  absoluteRecipePath: string,
  env: NodeJS.ProcessEnv = process.env,
): ((filename: string) => string | null) | undefined {
  if ((env[SUBFLOW_SPLIT_ENV] ?? '').trim().toLowerCase() === 'off') return undefined;
  const dir = path.dirname(absoluteRecipePath);
  return (filename: string): string | null => {
    try {
      const resolved = path.resolve(dir, filename);
      if (path.dirname(resolved) !== dir) return null;
      if (resolved === absoluteRecipePath) return null;
      return fs.readFileSync(resolved, 'utf8');
    } catch {
      return null;
    }
  };
}
import { logInfo } from '../logging.js';
import type { RecipeRunResult, ScreenshotEntry } from '../types.js';
import { readProvenanceSidecar } from '../../../lib/screenshot-provenance.js';
import { classifyMaestroFailure } from '../../../lib/maestro-failure-class.js';

/**
 * Subdirectory of a run's `screenshotDir` that Maestro's own `--test-output-dir`
 * tree is pinned to. Dot-prefixed so it reads as scaffolding, and skipped
 * explicitly by `collectScreenshots` so a failed harvest degrades to "no
 * screenshots" rather than to garbage `stepName`s.
 */
export const MAESTRO_OUTPUT_SUBDIR = '.maestro-out';

export function maestroOutputDir(screenshotDir: string): string {
  return path.join(screenshotDir, MAESTRO_OUTPUT_SUBDIR);
}

/**
 * Flatten Maestro's `<test-output-dir>/<timestamp>/<flow>/takeScreenshot/<name>.png`
 * tree into `<screenshotDir>/<name>.png`, then remove the scaffolding.
 *
 * Why flatten rather than let `collectScreenshots` walk the nesting: that walker
 * derives `stepName` from the path RELATIVE to `screenshotDir`, joining segments
 * with `-`. Left nested, every frame would be named
 * `.maestro-out-2026-08-31_181657-probe-takeScreenshot-probe-frame` instead of
 * `probe-frame` — and the manifest, the training skills and the atlas-drift
 * probe all key on the plain step name. So the nesting has to be undone before
 * collection, not tolerated by it.
 *
 * Returns the number of frames harvested. Best-effort by contract: a caller
 * must never fail a recipe because harvesting did, since the recipe itself may
 * legitimately have produced no frames.
 */
export function harvestMaestroScreenshots(screenshotDir: string): number {
  const root = maestroOutputDir(screenshotDir);
  if (!fs.existsSync(root)) return 0;

  const found: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.png')) found.push(full);
    }
  };
  walk(root, 0);

  let harvested = 0;
  for (const src of found) {
    const dest = path.join(screenshotDir, path.basename(src));
    try {
      // A chunked run invokes maestro once per chunk into the SAME
      // `--test-output-dir`, so each chunk adds a new `<timestamp>/` sibling.
      // Harvesting after every chunk keeps basenames unique in practice; if a
      // name does repeat, last-writer-wins matches the pre-existing
      // same-name-overwrites behaviour of writing straight into the dir.
      fs.renameSync(src, dest);
      harvested += 1;
    } catch {
      try {
        fs.copyFileSync(src, dest);
        harvested += 1;
      } catch {
        /* leave it; the scaffold cleanup below will not remove an unharvested file */
      }
    }
  }

  // Drop the scaffolding so `collectScreenshots` sees a flat dir. Guarded: if
  // anything was left behind, keep the tree for forensics rather than deleting
  // evidence.
  if (harvested === found.length) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  }
  return harvested;
}

/**
 * Maestro step keys `mobile_validate_recipe` accepts in an agent-authored
 * recipe.
 *
 * INVARIANT (dimagi-internal/ace#1008): this set must be a SUPERSET of every
 * step key used by the shipped static palette under
 * `mcp/mobile/recipes/static/*.yaml`. Palette files never pass through
 * `validateRecipe`, so any key they use but this set omits silently holds
 * agent-authored recipes to a narrower Maestro dialect than the palette they
 * compose — which is exactly how `scrollUntilVisible` (used by
 * `connect-resume-opp.yaml` + `connect-claim-opp.yaml`) came to be rejected.
 * `test/mcp/mobile/palette-step-allowlist.test.ts` pins the invariant.
 */
export const ALLOWED_STEP_KEYS = new Set([
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
  'scrollUntilVisible',
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
    opts: { adbPort?: number; serial?: string; captureAllBoundaries?: boolean } = {},
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
      return this.runRecipeWithDumps(recipePath, envVars, screenshotDir, opts as {
        adbPort?: number;
        serial: string;
        captureAllBoundaries?: boolean;
      });
    }

    const args = this.buildMaestroArgs(opts.adbPort, envVars, screenshotDir, recipePath, opts.serial);
    const r = await this.runMaestroChunk(args, screenshotDir, {
      recipePath, chunksCompleted: 0, chunksTotal: 1, lastCompletedScreenshot: null,
      stepCount: safeCountSteps(recipePath),
    });
    const screenshots = this.collectScreenshots(screenshotDir);
    return finalizeRecipeResult({
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      screenshotsDir: screenshotDir,
      screenshots,
      // Single invocation: there is no chunk after this one, so a
      // teardown-only fault means the whole recipe ran.
      walkCompleted: true,
    });
  }

  /**
   * One `maestro test` invocation with the wall-clock ceiling, converting a
   * SHELL_TIMEOUT into a MAESTRO_STALL that names the dispatch's progress
   * (dimagi-internal/ace#1164). The stall is a REAL result of a recipe that
   * ran — `runRecipeWithDriverHeal` keys on the code to keep it out of the
   * transport-crash retry, so a wedge can never trigger a silent
   * full-journey replay again.
   */
  private async runMaestroChunk(
    args: string[],
    screenshotDir: string,
    ctx: {
      recipePath: string;
      chunksCompleted: number;
      chunksTotal: number;
      lastCompletedScreenshot: string | null;
      /**
       * Top-level step count of the chunk being invoked, when known. Sizes the
       * wall-clock ceiling (ace#1570) — omitted means "use the floor", which is
       * exactly the pre-fix behaviour.
       */
      stepCount?: number;
    },
  ) {
    const budget = resolveChunkTimeout({ stepCount: ctx.stepCount });
    const timeoutMs = budget.timeoutMs;
    try {
      const r = await this.shell('maestro', args, { timeoutMs, cwd: screenshotDir });
      // Flatten Maestro's own output tree into `screenshotDir` before the
      // caller collects. Done HERE because this is the single choke point every
      // invocation shares (`runRecipe`, and both branches of
      // `runRecipeWithDumps`), so one call covers all three.
      harvestMaestroScreenshots(screenshotDir);
      return r;
    } catch (e) {
      // Harvest on the failure path too: a chunk that failed part-way still
      // wrote every frame up to the failing step, and those are exactly the
      // forensics a reader needs. Must not mask the original error.
      try {
        harvestMaestroScreenshots(screenshotDir);
      } catch {
        /* non-fatal */
      }
      if ((e as { code?: string })?.code === 'SHELL_TIMEOUT') {
        throw new MobileError(
          'MAESTRO_STALL',
          `maestro wedged (no exit within ${Math.round(timeoutMs / 1000)}s, budget basis ` +
            `${budget.basis}${budget.stepCount === null ? '' : ` over ${budget.stepCount} step(s)`}) on chunk ` +
            `${ctx.chunksCompleted + 1}/${ctx.chunksTotal} of ${path.basename(ctx.recipePath)}` +
            (ctx.lastCompletedScreenshot
              ? ` — last completed step ended at screenshot "${ctx.lastCompletedScreenshot}"`
              : ' — no chunk had completed yet'),
          'Inspect ~/.maestro/tests/<latest>/maestro.log and the forensics in the screenshot dir. ' +
            'Do NOT assume the walk failed: on-device progress up to the stall is real ' +
            '(verify server-side, e.g. connect_get_learn_progress) — a stalled dispatch after ' +
            'the productive work has completed is the ace#1164 signature.',
          {
            recipe: ctx.recipePath,
            chunks_completed: ctx.chunksCompleted,
            chunks_total: ctx.chunksTotal,
            last_completed_screenshot: ctx.lastCompletedScreenshot,
            timeout_ms: timeoutMs,
            timeout_basis: budget.basis,
            step_count: budget.stepCount,
            screenshot_dir: screenshotDir,
          },
        );
      }
      throw e;
    }
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
    serial?: string,
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
    // PIN THE DEVICE (dimagi-internal/ace#1396), by exactly ONE mechanism
    // (dimagi-internal/ace#1454). The two flag groups below are mutually
    // exclusive — emitting both makes Maestro refuse to run at all:
    //
    //   * `--host`/`--port` puts Maestro on the `Dadb.create(host, port)`
    //     DIRECT-TCP path. `adbPort` is `adbPortFromSerial(serial)`
    //     (`emulator-5554` -> 5555), i.e. the port is derived from the very
    //     serial we want, so this is already a single-emulator channel: it
    //     pins the device by construction. A device reached this way is NOT
    //     named `emulator-5554`, so adding `--device emulator-5554` on top
    //     matches nothing and Maestro aborts with "Device emulator-5554 was
    //     requested, but it is not connected" — before step 0, on a device
    //     that is demonstrably healthy. That combination shipped in #1396 and
    //     killed every local-backend Phase 6 walk (0.13.885-0.13.903).
    //
    //   * `--device <serial>` is meaningful only on the FALLBACK path, where
    //     no adbPort is known and Maestro enumerates an adb SERVER that can
    //     multiplex several devices. That is the case #1396 was really about:
    //     two emulators both running ACE_Pixel_API_34, both registered to the
    //     SAME ${ACE_E2E_PHONE} test user, where landing on the wrong one can
    //     SUBMIT A REAL DELIVER VISIT and consume a one-way precondition on
    //     another session's device, silently.
    //
    // So: direct-TCP when we can (it pins harder), `--device` when we cannot.
    // #1396's safety property is preserved on both paths, not weakened.
    // Top-level flags, so they go before `test`.
    if (typeof adbPort === 'number') {
      args.push('--host=localhost', `--port=${adbPort}`);
    } else if (serial) {
      args.push('--device', serial);
    }
    args.push('test', '--no-ansi');
    for (const [k, v] of Object.entries(envVars)) {
      args.push('-e', `${k}=${v}`);
    }
    // Resolve recipePath to absolute BEFORE the cwd-change; Maestro
    // resolves it relative to the new cwd otherwise.
    const absoluteRecipePath = path.isAbsolute(recipePath) ? recipePath : path.resolve(recipePath);
    // PIN MAESTRO'S OWN TEST-OUTPUT TREE INSIDE OUR SCREENSHOT DIR.
    //
    // `takeScreenshot: "name"` does NOT write to `./name.png` in the process
    // CWD on Maestro 2.7.0 — it writes to
    // `<test-output-dir>/<timestamp>/<flow>/takeScreenshot/<name>.png`,
    // defaulting to `~/.maestro/tests/`. So the `cwd: screenshotDir` contract
    // documented in `runRecipe` silently stopped working: every
    // `takeScreenshot` logs COMPLETED, `collectScreenshots(screenshotDir)`
    // finds nothing, and the run STILL reports `status: pass` with
    // `screenshots: []`. That shipped a Phase 6 dispatch with zero walkthrough
    // screenshots and a green recipe status on both legs
    // (turmeric-market-study/20260828-1108, both Learn and Deliver).
    //
    // Reproduced minimally on 2.7.0 with a two-step recipe (`launchApp` +
    // `takeScreenshot`) and cwd set to the output dir: 0 PNGs in cwd, 1 PNG at
    // `~/.maestro/tests/<ts>/probe/takeScreenshot/probe-frame.png`.
    //
    // Pinning `--test-output-dir` under `screenshotDir` puts that tree in a dir
    // we own, so `harvestMaestroScreenshots` can flatten it into the shape
    // `collectScreenshots` expects. `cwd: screenshotDir` is kept as well: it is
    // harmless, and remains correct for any build honouring the old behaviour.
    //
    // NOT `--flatten-debug-output`: measured on 2.7.0, combining it with
    // `--test-output-dir` yields ZERO PNGs anywhere under the given dir (it
    // re-routes into the debug-output tree). Dead end — do not re-try it.
    args.push('--test-output-dir', maestroOutputDir(screenshotDir));
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
    opts: { adbPort?: number; serial: string; captureAllBoundaries?: boolean },
  ): Promise<RecipeRunResult> {
    const absoluteRecipePath = path.isAbsolute(recipePath) ? recipePath : path.resolve(recipePath);
    const body = fs.readFileSync(absoluteRecipePath, 'utf8');
    // `=== true` is deliberate: undefined or a truthy-but-not-true value
    // must never turn the expensive tier-2 capture mode on. See
    // `SplitOptions.captureAllBoundaries` in `../recipe-splitter.ts`.
    const chunks = splitRecipeAtScreenshots(body, {
      captureAllBoundaries: opts.captureAllBoundaries === true,
      resolveSubflow: subflowResolverFor(absoluteRecipePath),
    });
    // State the chunking up front. Every wall-clock question about
    // subflow-aware splitting (ace#1570) — how much per-invocation overhead
    // it costs, whether a journey chunked at all — is answerable from this
    // line plus the per-chunk markers below, without a device sitting in
    // front of anyone.
    logInfo(
      `maestro: ${path.basename(absoluteRecipePath)} → ${chunks.length} chunk(s), ` +
        `${chunks.filter((c) => c.screenshotName).length} dump window(s), ` +
        `${countRecipeSteps(body)} top-level step(s)`,
    );

    // Zero-screenshot recipes (e.g. probe recipes, or a recipe where
    // every `takeScreenshot:` is nested inside a `runFlow.commands`
    // block) collapse to a single chunk — no dump windows, fall back
    // to the simple single-invocation path so we don't pay the
    // chunk-write overhead for no benefit.
    if (chunks.length === 1 && !chunks[0].screenshotName) {
      const args = this.buildMaestroArgs(opts.adbPort, envVars, screenshotDir, absoluteRecipePath, opts.serial);
      const r = await this.runMaestroChunk(args, screenshotDir, {
        recipePath: absoluteRecipePath, chunksCompleted: 0, chunksTotal: 1, lastCompletedScreenshot: null,
        stepCount: countRecipeSteps(body),
      });
      const screenshots = this.collectScreenshots(screenshotDir);
      return finalizeRecipeResult({
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        screenshotsDir: screenshotDir,
        screenshots,
        // Collapsed to one chunk, so this invocation IS the whole recipe.
        walkCompleted: true,
      });
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
    // The failing chunk's OWN marker-prefixed block — captured separately
    // from stdoutParts/stderrParts (the full run history) because
    // classifyMaestroFailure excerpts only the first EXCERPT_LIMIT chars
    // of whatever it's given. Phase 6 recipes routinely split into 9-10
    // chunks; by the time the failing one runs, `stderrParts.join('\n')`
    // has already spent the 240-char budget on preceding chunks' marker
    // lines and stderr, so the actual "Element not found: ..." text the
    // atlas-drift classifier needs (lib/atlas-drift.ts's
    // extractWantedMatchers) never survives into the slice. Threading
    // just this chunk's block through keeps the marker (for readability)
    // but drops the noise from every OTHER chunk, so the real failure
    // text lands well inside the excerpt window.
    let failingChunkStdout = '';
    let failingChunkStderr = '';
    // Progress context for MAESTRO_STALL (ace#1164): how far the dispatch
    // actually got, so a stall names the last completed step instead of
    // surfacing as a context-free timeout string.
    let chunksCompleted = 0;
    let lastCompletedScreenshot: string | null = null;

    try {
      for (const chunk of chunks) {
        const chunkPath = path.join(chunkDir, `chunk-${chunk.index}.yaml`);
        fs.writeFileSync(chunkPath, chunk.yaml, 'utf8');

        const args = this.buildMaestroArgs(opts.adbPort, envVars, screenshotDir, chunkPath, opts.serial);
        const r = await this.runMaestroChunk(args, screenshotDir, {
          recipePath: absoluteRecipePath,
          chunksCompleted,
          chunksTotal: chunks.length,
          lastCompletedScreenshot,
          stepCount: countRecipeSteps(chunk.yaml),
        });
        const chunkLabel = `# --- chunk ${chunk.index} (screenshot=${chunk.screenshotName ?? 'none'}) ---`;
        stdoutParts.push(`${chunkLabel}\n${r.stdout}`);
        stderrParts.push(`${chunkLabel}\n${r.stderr}`);
        lastExitCode = r.exitCode;
        if (r.exitCode !== 0) {
          failingChunkStdout = `${chunkLabel}\n${r.stdout}`;
          failingChunkStderr = `${chunkLabel}\n${r.stderr}`;
          break;
        }

        chunksCompleted++;
        if (chunk.screenshotName) lastCompletedScreenshot = chunk.screenshotName;

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
    const aggregatedStderr = stderrParts.join('\n');
    const aggregatedStdout = stdoutParts.join('\n');
    // Classify from the FAILING CHUNK's own block, not the head of the
    // full joined aggregate (see the comment on failingChunkStderr
    // above). On success there is no failing chunk, so fall back to the
    // aggregate — classifyMaestroFailure returns 'pass' for exitCode 0
    // regardless of excerpt content, so this only affects the (unused,
    // on success) stderrExcerpt field.
    return finalizeRecipeResult({
      exitCode: lastExitCode,
      stdout: aggregatedStdout,
      stderr: aggregatedStderr,
      screenshotsDir: screenshotDir,
      screenshots,
      // Classify from the FAILING CHUNK's own block, not the head of the
      // full joined aggregate (see the comment on failingChunkStderr above).
      classifyStdout: lastExitCode === 0 ? aggregatedStdout : failingChunkStdout,
      classifyStderr: lastExitCode === 0 ? aggregatedStderr : failingChunkStderr,
      // THE WALK ONLY COMPLETED IF EVERY CHUNK RAN (ace#1822).
      //
      // A session-teardown fault can only be raised after the chunk that
      // raised it finished executing — but if that chunk was not the LAST
      // one, every chunk after it never ran, so the recipe is genuinely
      // incomplete and must stay a failure no matter how clean the teardown
      // stack looks. This is exactly the 20260828-0629 shape: the FINISH
      // press landed (Connect flipped `learn_complete`), and the two frames
      // after it never happened. The artifacts on that dispatch are real and
      // must survive — see `maestro-driver-retry.ts` and `client.runRecipe`
      // — but the VERDICT is still `fail`.
      walkCompleted: chunksCompleted >= chunks.length,
    });
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
    // Step 0: wait for the device to actually EXIST and finish booting
    // before asking anything of it (#1072). This step used to be absent,
    // and `waitForPackageManager`'s 30s budget — scoped in its own
    // docstring to the "~5-15s past sys.boot_completed=1" pm race — was
    // left absorbing an entire cold boot. `ensureAvdRunning` spawns the
    // emulator with `-wipe-data -no-snapshot-load`, which CLAUDE.md puts
    // at 60-90s steady-state and longer on a host running more than one
    // emulator, so the gate lost the race routinely. It then failed with
    // `adb: device '<serial>' not found` reported as a PACKAGE-SERVICE
    // timeout — a device-not-present condition wearing the wrong label,
    // whose remediation string sent operators to cold-restart a device
    // that was booting perfectly well. Observed live 2026-07-30: two
    // consecutive failures, each leaving a fully-booted AVD with the
    // package service bound and ZERO CommCare packages, because the
    // funnel threw before reaching install.
    await this.waitForDeviceBooted(serial, 180_000);
    actions.push('device-booted');

    // Step 1: wait for the AVD's `pm` package service. Fresh boot races
    // here — `pm list packages` returns "Can't find service: package"
    // until the package manager binds. Cheap probe; ~150ms when ready.
    // Now genuinely scoped to that race, because Step 0 guarantees the
    // device is present and `sys.boot_completed=1` before we get here.
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
    return (await this.queryPackageInstalled(serial, pkg)) === true;
  }

  /**
   * Tri-state package presence query: `true` (present), `false`
   * (successfully queried and absent), `null` (the query itself failed).
   *
   * The third state is load-bearing and is the ace#1155 invariant applied
   * here: *a failed query is not a negative answer.* `isPackageInstalled`
   * collapses `null` to `false`, which is the right call for the
   * install path (install-when-unsure is idempotent) and the WRONG call
   * for any caller that would turn absence into a health verdict or a
   * destructive repair.
   */
  private async queryPackageInstalled(serial: string, pkg: string): Promise<boolean | null> {
    const r = await this.shell(
      'adb',
      ['-s', serial, 'shell', 'pm', 'list', 'packages', pkg],
      { timeoutMs: 8_000 },
    ).catch(() => null);
    if (r === null || r.exitCode !== 0) return null;
    const lines = (r.stdout || '')
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((l) => l.length > 0);
    return lines.includes(pkg);
  }

  /**
   * Are BOTH halves of the Maestro on-device driver installed on `serial`?
   *
   * ~50ms of `pm list packages`, and it is what turns "the driver is
   * healthy" from a guess into an observation (dimagi-internal/ace#1818).
   * `probeDriver` alone cannot answer this: it asks `maestro hierarchy`
   * over a DIRECT-TCP channel keyed on a host port, so a zero exit proves
   * "some device answered on that port", not "THIS serial has the driver".
   *
   * `queryOk: false` means the package query could not be answered — the
   * caller must NOT read that as absence (ace#1155).
   */
  async driverPackagesInstalled(
    serial: string,
  ): Promise<{ app: boolean; test: boolean; queryOk: boolean }> {
    const app = await this.queryPackageInstalled(serial, 'dev.mobile.maestro');
    const test = await this.queryPackageInstalled(serial, 'dev.mobile.maestro.test');
    if (app === null || test === null) {
      return { app: app === true, test: test === true, queryOk: false };
    }
    return { app, test, queryOk: true };
  }

  /**
   * Wait until `serial` is (a) present on the adb server at all and
   * (b) reports `sys.boot_completed=1` (#1072).
   *
   * These are TWO distinct failure classes and they are deliberately
   * reported as such — "the device never appeared" and "the device
   * appeared but never finished booting" have different causes and
   * different fixes, and collapsing them into the `pm`-service message
   * is what made this bug read as a stuck emulator for two sessions.
   *
   * Budget is sized for a real cold boot (`-wipe-data
   * -no-snapshot-load`, 60-90s steady-state per CLAUDE.md, longer under
   * contention), NOT for the short post-boot service race that
   * `waitForPackageManager` covers.
   */
  private async waitForDeviceBooted(serial: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let sawDevice = false;
    let lastErr = '';

    while (Date.now() < deadline) {
      // `get-state` prints "device" once adbd on the guest is up. While
      // qemu is still coming up it exits non-zero with
      // "device '<serial>' not found" — the exact string that used to
      // surface as a package-service timeout.
      const st = await this.shell('adb', ['-s', serial, 'get-state'], { timeoutMs: 5_000 }).catch(
        (e: any) => ({ stdout: '', stderr: String(e?.message ?? e), exitCode: 1 }),
      );
      if (st.exitCode === 0 && /device/.test(st.stdout)) {
        sawDevice = true;
        const bc = await this.shell(
          'adb',
          ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
          { timeoutMs: 5_000 },
        ).catch((e: any) => ({ stdout: '', stderr: String(e?.message ?? e), exitCode: 1 }));
        if (bc.exitCode === 0 && bc.stdout.trim() === '1') return;
        lastErr = `boot_completed='${(bc.stdout || '').trim()}'`;
      } else {
        lastErr = (st.stderr || st.stdout || '').slice(0, 160);
      }
      await new Promise((res) => setTimeout(res, 2_000));
    }

    const secs = Math.round(timeoutMs / 1000);
    throw new MobileError(
      'AVD_BOOT_TIMEOUT',
      sawDevice
        ? `AVD ${serial} appeared on the adb server but never reported sys.boot_completed=1 within ${secs}s (last: ${lastErr || 'unknown'}).`
        : `AVD ${serial} never appeared on the adb server within ${secs}s (last: ${lastErr || 'unknown'}).`,
      sawDevice
        ? 'The emulator is running but wedged mid-boot. `mobile_stop_avd` then `mobile_ensure_avd_running` to cold-restart.'
        : 'The emulator process may have died on launch, or it registered with a DIFFERENT adb server than this session allocated. Check `~/.ace/sessions/<mcp_pid>.lock.json` for this session\'s adb_port, then `ANDROID_ADB_SERVER_PORT=<that> adb devices`.',
    );
  }

  /**
   * Poll `cmd package list packages` until it returns successfully (the
   * package manager service is bound) or `timeoutMs` elapses. On fresh
   * AVDs `pm` can race ~5-15s past `sys.boot_completed=1`. Without this
   * wait, the first `adb install` hits "Install failed: cmd: Can't find
   * service: package" and aborts.
   *
   * PRECONDITION (#1072): the caller must already have waited for the
   * device to be present and booted (`waitForDeviceBooted`). This budget
   * covers the post-boot service race ONLY — do not let it absorb a cold
   * boot, which is the bug this note exists to prevent recurring.
   *
   * RETRIED, bounded (#1067 ask 4). A single lost race used to surface as a
   * hard typed throw on the first expired budget, and an immediate unchanged
   * retry then succeeded — observed 3× across 2026-07-29/30, always with
   * `adb: device '<serial>' not found` as the last error, i.e. the device
   * momentarily dropped off the adb server rather than the package service
   * being genuinely wedged. A bare throw there reads to callers as a hard
   * capability gap ("the emulator is broken, cold-restart it") for what is a
   * blip, so we spend a second budget before believing it. Between attempts
   * we re-confirm the device is present and booted, which is the condition
   * that actually went missing; its own failure is swallowed so the
   * caller-facing error stays the pm-service class it started as.
   */
  private async waitForPackageManager(
    serial: string,
    timeoutMs: number,
    attempts = 2,
  ): Promise<void> {
    let lastErr = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      lastErr = await this.pollPackageManager(serial, timeoutMs);
      if (lastErr === '') return;
      if (attempt < attempts) {
        logInfo(
          `maestro_driver: \`package\` service not bound on ${serial} after ` +
            `${Math.round(timeoutMs / 1000)}s (attempt ${attempt}/${attempts}, last: ${lastErr}); ` +
            `re-confirming the device is present, then retrying the bind`,
        );
        await this.waitForDeviceBooted(serial, 30_000).catch(() => {});
      }
    }
    throw new MobileError(
      'AVD_PM_SERVICE_TIMEOUT',
      `AVD ${serial} did not finish binding the \`package\` service within ${Math.round(timeoutMs / 1000)}s × ${attempts} attempts (last: ${lastErr || 'unknown'}).`,
      'The emulator may be stuck mid-boot. Try `mobile_stop_avd` then `mobile_ensure_avd_running` to cold-restart; if it persists, wipe the AVD user data via Android Studio.',
    );
  }

  /**
   * One `waitForPackageManager` budget. Returns `''` when the package
   * service answered, otherwise the last error seen (truncated) so the
   * caller can decide whether to spend another budget or throw.
   */
  private async pollPackageManager(serial: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      const r = await this.shell(
        'adb',
        ['-s', serial, 'shell', 'cmd', 'package', 'list', 'packages'],
        { timeoutMs: 5_000 },
      ).catch((e: any) => ({ stdout: '', stderr: String(e?.message ?? e), exitCode: 1 }));
      if (r.exitCode === 0 && /package:/.test(r.stdout)) return '';
      lastErr = (r.stderr || r.stdout || '').slice(0, 160);
      await new Promise((res) => setTimeout(res, 1_000));
    }
    return lastErr || 'unknown';
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

  /** Every `.png` under `dir`, RECURSIVELY.
   *
   * Recursive because a screenshot name is not guaranteed to be a flat
   * filename. Maestro resolves `takeScreenshot: "name"` to `File("name.png")`
   * relative to the process CWD and calls `getParentFile`/`mkdirs`, so any
   * `/` inside the name silently becomes a DIRECTORY rather than an error.
   * Recipes interpolate display labels into those names
   * (`learn-tap-module-before-${MODULE_NAME}`), and ACE's sanctioned inline
   * localization authors labels in the compact `English / Chichewa / Tumbuka`
   * slash form — so on every trilingual app the frames landed in nested
   * subdirectories and a flat `readdirSync` never saw them. They were written
   * and then lost, while the recipe reported every `takeScreenshot ...
   * COMPLETED` (ace#1236; 36 frames on a 9-module app).
   *
   * Fixed HERE rather than by sanitizing each recipe's names: the collector is
   * the one place that closes the class for every recipe, present and future,
   * and it needs no change to the env contract recipe authors write against.
   * The nested path is flattened into `stepName`, which preserves the
   * per-module disambiguation the label was interpolated for in the first
   * place. */
  private collectScreenshots(dir: string): ScreenshotEntry[] {
    return collectScreenshotsFromDir(dir);
  }
}

/**
 * Module-level twin of `MaestroBackend.collectScreenshots`, so a caller that
 * holds no backend instance can still enumerate what a dispatch wrote.
 *
 * `client.runRecipe` needs exactly that on its THROW path (ace#1822): the
 * backend never returned a result there, so the frames it left on disk had no
 * other route back to the caller.
 */
export function collectScreenshotsFromDir(dir: string): ScreenshotEntry[] {
    if (!fs.existsSync(dir)) return [];

    const pngs: string[] = [];
    const walk = (current: string, depth: number): void => {
      // Depth bound: a label can nest a few levels (one per `/`), never deep.
      if (depth > 8) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        // Never descend into Maestro's own output scaffold. `harvestMaestroScreenshots`
        // normally empties and removes it before we get here; if it could not
        // (permissions, a partial harvest), skipping is the safe degradation —
        // reporting zero screenshots is honest, whereas walking the nesting
        // would emit frames named `.maestro-out-<ts>-<flow>-takeScreenshot-<name>`
        // and every downstream consumer keys on the plain step name.
        if (entry.isDirectory() && entry.name === MAESTRO_OUTPUT_SUBDIR) continue;
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.png')) pngs.push(full);
      }
    };
    walk(dir, 0);

    return pngs
      .sort()
      .map((full) => {
        const stat = fs.statSync(full);
        // Flatten the path RELATIVE to the screenshot dir, so a frame written
        // into `before-Start here: quick check / Yambani apa/…png` still gets
        // one stable, unique stepName instead of colliding with its siblings.
        const stepName = path
          .relative(dir, full)
          .replace(/\.png$/, '')
          .split(path.sep)
          .join('-')
          .replace(/\s+/g, ' ')
          .trim();
        // Pair the PNG with its sibling UI dump if `runRecipeWithDumps`
        // captured one (same basename, .xml suffix). Absence is the
        // normal pre-0.13.229 case (caller didn't pass `serial`); we
        // silently omit `uiDumpPath` so legacy consumers see no
        // change.
        // Sibling of the PNG at its ACTUAL location — derive it from `full`,
        // never by re-joining the flattened stepName onto `dir`, or a nested
        // frame's dump silently stops pairing.
        const dumpPath = full.replace(/\.png$/, '.xml');
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
        // Attach provenance sidecar if MobileClient already wrote one.
        // collectScreenshots can be called from either tier (MaestroBackend
        // direct in tests, or after MobileClient.runRecipe has written
        // sidecars). Either way, an existing sidecar gets surfaced.
        const prov = readProvenanceSidecar(full);
        if (prov) entry.provenance = prov;
        return entry;
      });
  }


/**
 * Build a `RecipeRunResult` from one Maestro outcome, letting a
 * session-teardown fault be a WARNING rather than the verdict (ace#1822).
 *
 * `exitCode` is passed through untouched — a `pass` carrying a non-zero exit
 * code is the audit trail, not a bug. Only `status` and `failure` describe
 * the WALK, which is the question every caller is actually asking.
 *
 * `walkCompleted` is the caller's assertion that every step of the recipe
 * was reached. It is false when a chunked run stopped part-way, and in that
 * case a teardown stack cannot rescue the verdict — the frames after the
 * failing chunk genuinely never ran.
 */
export function finalizeRecipeResult(args: {
  exitCode: number;
  stdout: string;
  stderr: string;
  screenshotsDir: string;
  screenshots: ScreenshotEntry[];
  walkCompleted: boolean;
  classifyStdout?: string;
  classifyStderr?: string;
}): RecipeRunResult {
  const classifyStdout = args.classifyStdout ?? args.stdout;
  const classifyStderr = args.classifyStderr ?? args.stderr;
  const teardown =
    args.walkCompleted && args.exitCode !== 0
      ? classifyTeardownFailure({
          stdout: classifyStdout,
          stderr: classifyStderr,
          exitCode: args.exitCode,
        })
      : { teardownOnly: false as const };

  if (teardown.teardownOnly) {
    return {
      // The walk ran to the end. `exitCode` stays non-zero on purpose.
      status: 'pass',
      exitCode: args.exitCode,
      stdout: args.stdout,
      stderr: args.stderr,
      screenshotsDir: args.screenshotsDir,
      screenshots: args.screenshots,
      failure: classifyMaestroFailure({
        stdout: classifyStdout,
        stderr: classifyStderr,
        exitCode: 0,
      }),
      warnings: [teardownWarning(teardown.excerpt)],
    };
  }

  return {
    status: args.exitCode === 0 ? 'pass' : 'fail',
    exitCode: args.exitCode,
    stdout: args.stdout,
    stderr: args.stderr,
    screenshotsDir: args.screenshotsDir,
    screenshots: args.screenshots,
    failure: classifyMaestroFailure({
      stdout: classifyStdout,
      stderr: classifyStderr,
      exitCode: args.exitCode,
    }),
  };
}
