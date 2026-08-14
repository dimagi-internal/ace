// mcp/mobile/screen-recorder.ts
//
// On-device screen recording for local AVD recipe runs.
//
// Mechanism chosen by live probe (2026-07-30, API 34, screenrecord v1.3):
// `adb shell screenrecord --time-limit 0`. The emulator-console recorder
// (`adb emu screenrecord`) was rejected — it authenticates against
// ~/.emulator_console_auth_token, which is PER-MACOS-USER, and ACE
// workstations run emulators under more than one account. It would work
// for emulators we spawned and fail on any we merely attach to.
//
// Recording wraps the WHOLE run from outside Maestro: `runRecipeWithDumps`
// splits a recipe into N separate `maestro test` invocations, so anything
// Maestro-driven would fragment into N clips.
//
// EVERY function here is best-effort. A recording failure must never change
// a recipe's verdict — same contract as `MobileClient.captureFailureForensics`.
import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ShellFn } from './backends/avd.js';
import { defaultShell } from './backends/avd.js';
import { logInfo } from './logging.js';
import type { VideoArtifact } from './types.js';

export interface RecorderConfig {
  enabled: boolean;
  bitRate: string;
  size: string;
}

/**
 * Resolve recorder config from env. `ACE_MOBILE_RECORD=off` is the
 * operator kill switch — this code sits in the run loop, so there has to
 * be a one-line way to disable it without a code change.
 */
export function recorderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RecorderConfig {
  return {
    enabled: (env.ACE_MOBILE_RECORD ?? 'on').trim().toLowerCase() !== 'off',
    bitRate: env.ACE_MOBILE_RECORD_BITRATE?.trim() || '1M',
    size: env.ACE_MOBILE_RECORD_SIZE?.trim() || '540x1140',
  };
}

/** Minimal surface of a spawned child the recorder needs (injectable for tests). */
export interface SpawnedRecorder {
  kill(signal?: string | number | NodeJS.Signals): boolean | void;
  unref?(): void;
}
export type SpawnFn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => SpawnedRecorder;

/**
 * A spawned child that can report an ASYNCHRONOUS spawn failure. Narrower
 * than `ChildProcess` so `createDefaultSpawnFn` is unit-testable with a
 * plain `EventEmitter`.
 */
export interface ErrorEmittingChild extends SpawnedRecorder {
  on(event: 'error', listener: (err: Error) => void): unknown;
}
/**
 * The slice of `child_process.spawn` this module uses.
 *
 * Kept STRUCTURALLY ASSIGNABLE from the real `spawn` so the default argument
 * below needs no cast at all. It previously read
 * `nodeSpawn as unknown as NodeSpawnLike` — a double cast, which erases the
 * compile-time check that Node's signature still matches, on a branch whose
 * whole subject (#1083) was not erasing its own type checks
 * (dimagi-internal/ace#1084).
 *
 * The return type is widened to what `spawn` actually gives back; the
 * `'error'` listener this module installs is the only member it needs, and
 * `ChildProcess` satisfies it.
 */
export type NodeSpawnLike = (
  cmd: string,
  args: readonly string[],
  opts: { stdio: 'ignore'; detached: boolean; env: NodeJS.ProcessEnv },
) => ErrorEmittingChild;

/**
 * Build the production spawn function, with the `'error'` listener that
 * keeps a spawn failure from killing the whole MCP subprocess.
 *
 * **The listener is load-bearing, not defensive politeness.** Node reports
 * spawn failures ASYNCHRONOUSLY as an `'error'` event on the returned
 * `ChildProcess` — `ENOENT` when `adb` isn't on PATH, `EAGAIN`/`EMFILE`
 * under fork pressure. An `'error'` event with NO listener is re-thrown by
 * EventEmitter as an uncaught exception, and nothing in `mcp/` or `lib/`
 * installs a `process.on('uncaughtException')` handler. So without this,
 * a best-effort recording failure would take down the entire ace-mobile
 * MCP server mid-recipe — the exact opposite of the "recording never
 * changes a recipe's verdict" contract this file is built around.
 *
 * `startRecording`'s try/catch cannot cover this: it only catches a
 * SYNCHRONOUS throw from `spawnFn`, which is why an injected fake that
 * throws (as `screen-recorder.test.ts` uses) proves nothing about this
 * path. See the `createDefaultSpawnFn` tests for the real proof.
 */
export function createDefaultSpawnFn(
  label: string,
  spawnImpl: NodeSpawnLike = nodeSpawn as NodeSpawnLike,
): SpawnFn {
  return (cmd, argv, env) => {
    const child = spawnImpl(cmd, argv, { stdio: 'ignore', detached: false, env });
    child.on('error', (err) => {
      logInfo(`startRecording: adb screenrecord spawn failed for ${label}: ${String(err)}`);
    });
    return child;
  };
}

export interface RecordingHandle {
  serial: string;
  recipeId: string;
  dispatchId: string;
  attempt: number;
  /** Path on the device that screenrecord is writing. */
  devicePath: string;
  /** Path on the host the mp4 will be pulled to. */
  outPath: string;
  child: SpawnedRecorder;
}

/**
 * `--time-limit 0` is load-bearing: screenrecord's DEFAULT limit is 180s,
 * and Maestro runs are allowed up to 10 minutes. Without it a long journey
 * silently records only its first three minutes.
 */
export function buildScreenrecordArgs(
  serial: string,
  devicePath: string,
  cfg: RecorderConfig,
): string[] {
  return [
    '-s', serial,
    'shell', 'screenrecord',
    '--time-limit', '0',
    '--bit-rate', cfg.bitRate,
    '--size', cfg.size,
    devicePath,
  ];
}

function outFileName(recipeId: string, attempt: number): string {
  return attempt <= 1 ? `${recipeId}.mp4` : `${recipeId}-attempt${attempt}.mp4`;
}

export function startRecording(args: {
  serial: string;
  recipeId: string;
  dispatchId: string;
  attempt: number;
  outDir: string;
  config: RecorderConfig;
  adbServerPort?: number;
  spawnFn?: SpawnFn;
  /**
   * Test-only seam. Replaces `node:child_process.spawn` INSIDE the default
   * `spawnFn`, so a test can exercise the real `createDefaultSpawnFn`
   * wrapper (and its `'error'` listener) end-to-end through this function
   * rather than bypassing it via `spawnFn`. Ignored when `spawnFn` is given.
   */
  spawnImpl?: NodeSpawnLike;
}): RecordingHandle | undefined {
  if (!args.config.enabled) return undefined;
  const devicePath = `/sdcard/ace-rec-${args.dispatchId}-${args.attempt}.mp4`;
  const outPath = path.join(args.outDir, outFileName(args.recipeId, args.attempt));
  const spawnFn: SpawnFn =
    args.spawnFn ??
    createDefaultSpawnFn(`${args.recipeId} attempt ${args.attempt}`, args.spawnImpl);
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (typeof args.adbServerPort === 'number') {
      env.ANDROID_ADB_SERVER_PORT = String(args.adbServerPort);
    }
    const child = spawnFn('adb', buildScreenrecordArgs(args.serial, devicePath, args.config), env);
    child.unref?.();
    return {
      serial: args.serial,
      recipeId: args.recipeId,
      dispatchId: args.dispatchId,
      attempt: args.attempt,
      devicePath,
      outPath,
      child,
    };
  } catch (e) {
    logInfo(`startRecording: failed for ${args.recipeId} attempt ${args.attempt}: ${String(e)}`);
    return undefined;
  }
}

/**
 * Timeouts for the stop path. `defaultShell` only arms a timer when
 * `timeoutMs` is passed, so an un-timed call waits FOREVER — and every
 * call below runs inside `runRecipe`'s `runOnce` `finally`, on the
 * critical path of every recipe. That includes the driver-death path,
 * where the device is already known-sick and an `adb` that never returns
 * is the likely case, not the exotic one. Best-effort has to be honoured
 * in the time dimension too, not just the error dimension.
 */
/** Single-round-trip device commands (`pkill`, `stat`, `rm`). */
const ADB_SHORT_TIMEOUT_MS = 5_000;
/**
 * `adb pull` of the recording. A 10-minute journey at the default
 * 1M/540x1140 is roughly 40-80 MB, and the emulator loopback moves tens
 * of MB/s — 120s is far past the worst realistic transfer while still
 * finite.
 */
const ADB_PULL_TIMEOUT_MS = 120_000;
/** ffmpeg `-c copy` remux — no re-encode, so it is I/O-bound, not CPU-bound. */
const FFMPEG_TIMEOUT_MS = 60_000;

/** Poll the on-device file size until two consecutive reads agree (or we time out). */
async function waitForStableSize(
  handle: RecordingHandle,
  shell: ShellFn,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  while (Date.now() < deadline) {
    let current = -1;
    try {
      const r = await shell(
        'adb',
        ['-s', handle.serial, 'shell', 'stat', '-c', '%s', handle.devicePath],
        { timeoutMs: ADB_SHORT_TIMEOUT_MS },
      );
      current = Number.parseInt(r.stdout.trim(), 10);
    } catch {
      return; // Device unreachable — let the pull surface the real problem.
    }
    if (Number.isFinite(current) && current > 0 && current === previous) return;
    previous = current;
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/**
 * Rewrite the mp4 container in place with `-c copy` (no re-encode) so it
 * carries proper duration metadata and a front-loaded moov atom. A pulled
 * screenrecord file can otherwise report `duration=N/A`, which makes it
 * seek badly in Drive preview.
 *
 * Best-effort and optional: ffmpeg missing or failing leaves the original
 * file untouched and returns false.
 */
export async function normalizeContainer(mp4Path: string, shell: ShellFn = defaultShell): Promise<boolean> {
  const tmpOut = `${mp4Path}.remux.mp4`;
  try {
    const r = await shell(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', mp4Path, '-c', 'copy', '-movflags', '+faststart', tmpOut],
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );
    // Three independent reasons to discard the remux. Name WHICH one
    // tripped: the guard is an OR, so a missing or empty output used to log
    // `ffmpeg exit 0`, which reads as "ffmpeg succeeded and we threw the
    // result away anyway" and sends the reader at the wrong question.
    const missing = !fs.existsSync(tmpOut);
    const empty = !missing && fs.statSync(tmpOut).size === 0;
    if (r.exitCode !== 0 || missing || empty) {
      try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
      const why = r.exitCode !== 0
        ? `ffmpeg exit ${r.exitCode}`
        : missing
          ? 'ffmpeg exit 0 but produced no output file'
          : 'ffmpeg exit 0 but produced a 0-byte output file';
      logInfo(
        `normalizeContainer: ${why} for ${mp4Path} — keeping raw pull` +
          (r.stderr?.trim() ? ` (stderr: ${r.stderr.trim().slice(0, 300)})` : ''),
      );
      return false;
    }
    fs.renameSync(tmpOut, mp4Path);
    return true;
  } catch (e) {
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
    logInfo(`normalizeContainer: unavailable for ${mp4Path} (${String(e)}) — keeping raw pull`);
    return false;
  }
}

export async function stopRecording(
  handle: RecordingHandle,
  opts: { shell?: ShellFn; pollMs?: number; stableTimeoutMs?: number } = {},
): Promise<VideoArtifact | undefined> {
  const shell = opts.shell ?? defaultShell;
  const pollMs = opts.pollMs ?? 500;
  const stableTimeoutMs = opts.stableTimeoutMs ?? 5000;
  try {
    // SIGINT, NOT SIGKILL. screenrecord writes the mp4 moov atom on a clean
    // interrupt; SIGKILL leaves an unplayable file.
    await shell(
      'adb',
      ['-s', handle.serial, 'shell', 'pkill', '-INT', 'screenrecord'],
      { timeoutMs: ADB_SHORT_TIMEOUT_MS },
    );
    await waitForStableSize(handle, shell, pollMs, stableTimeoutMs);
    const pullResult = await shell(
      'adb',
      ['-s', handle.serial, 'pull', handle.devicePath, handle.outPath],
      { timeoutMs: ADB_PULL_TIMEOUT_MS },
    );
    if (pullResult.exitCode !== 0) {
      logInfo(`stopRecording: adb pull failed with exit code ${pullResult.exitCode}: ${pullResult.stderr}`);
      return undefined;
    }
    // Normalize the container BEFORE stat — the remux changes the byte size.
    await normalizeContainer(handle.outPath, shell);
    const bytes = fs.statSync(handle.outPath).size;
    return {
      path: handle.outPath,
      bytes,
      recipeId: handle.recipeId,
      dispatchId: handle.dispatchId,
      attempt: handle.attempt,
    };
  } catch (e) {
    logInfo(`stopRecording: failed for ${handle.recipeId} attempt ${handle.attempt}: ${String(e)}`);
    return undefined;
  } finally {
    // Cleanup on EVERY exit path — success, early `return undefined` on a
    // failed pull, and the outer catch alike. These used to sit on the
    // success path only, and the leak that caused is not cosmetic:
    //
    //   - If `pkill` never landed, the DEVICE-SIDE screenrecord is still
    //     running, with `--time-limit 0`, writing into
    //     `/sdcard/ace-rec-<dispatch>-<attempt>.mp4` at ~5-8 MB/min on an
    //     emulator whose default sdcard is 512 MB. Nothing else in ACE
    //     sweeps that prefix, so every failed stop left one abandoned mp4
    //     on the device forever.
    //   - The host-side `adb` child we spawned is orphaned the same way.
    //
    // Both are independently guarded: a failure of one must not skip the
    // other, and neither may turn a best-effort recorder into a throw.
    try {
      await shell(
        'adb',
        ['-s', handle.serial, 'shell', 'rm', '-f', handle.devicePath],
        { timeoutMs: ADB_SHORT_TIMEOUT_MS },
      );
    } catch (e) {
      logInfo(`stopRecording: cleanup rm -f failed: ${String(e)}`);
    }
    try {
      handle.child.kill();
    } catch (e) {
      logInfo(`stopRecording: cleanup child.kill() failed: ${String(e)}`);
    }
  }
}
