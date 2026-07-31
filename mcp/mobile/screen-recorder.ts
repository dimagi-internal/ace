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
}): RecordingHandle | undefined {
  if (!args.config.enabled) return undefined;
  const devicePath = `/sdcard/ace-rec-${args.dispatchId}-${args.attempt}.mp4`;
  const outPath = path.join(args.outDir, outFileName(args.recipeId, args.attempt));
  const spawnFn: SpawnFn =
    args.spawnFn ??
    ((cmd, argv, env) => nodeSpawn(cmd, argv, { stdio: 'ignore', detached: false, env }));
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
      const r = await shell('adb', ['-s', handle.serial, 'shell', 'stat', '-c', '%s', handle.devicePath]);
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
    const r = await shell('ffmpeg', [
      '-v', 'error', '-y', '-i', mp4Path, '-c', 'copy', '-movflags', '+faststart', tmpOut,
    ]);
    if (r.exitCode !== 0 || !fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) {
      try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
      logInfo(`normalizeContainer: ffmpeg exit ${r.exitCode} for ${mp4Path} — keeping raw pull`);
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
    await shell('adb', ['-s', handle.serial, 'shell', 'pkill', '-INT', 'screenrecord']);
    await waitForStableSize(handle, shell, pollMs, stableTimeoutMs);
    const pullResult = await shell('adb', ['-s', handle.serial, 'pull', handle.devicePath, handle.outPath]);
    if (pullResult.exitCode !== 0) {
      logInfo(`stopRecording: adb pull failed with exit code ${pullResult.exitCode}: ${pullResult.stderr}`);
      return undefined;
    }
    try {
      await shell('adb', ['-s', handle.serial, 'shell', 'rm', '-f', handle.devicePath]);
    } catch (e) {
      logInfo(`stopRecording: cleanup rm -f failed: ${String(e)}`);
    }
    try {
      handle.child.kill();
    } catch (e) {
      logInfo(`stopRecording: cleanup child.kill() failed: ${String(e)}`);
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
  }
}
