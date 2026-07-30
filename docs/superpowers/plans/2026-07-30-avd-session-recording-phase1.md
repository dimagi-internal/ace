# AVD Session Recording — Phase 1 (local backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record an mp4 of every local mobile recipe run alongside the existing per-step screenshots, and publish those videos to Drive as run artifacts.

**Architecture:** A new `mcp/mobile/screen-recorder.ts` starts an on-device `adb shell screenrecord --time-limit 0` before a Maestro run and stops it with SIGINT afterwards, pulling the mp4 to the host. `MobileClient.runRecipe` drives it from inside the `runOnce` callback of the existing driver-heal envelope, so each attempt yields its own segment and the throw path is covered by a `finally`. Videos land in the run's `screenshotDir` and are copied to a per-session spool; the `app-screenshot-capture` skill uploads its journey videos to Drive and sweeps the spool for everything else.

**Tech Stack:** TypeScript (ESM, run direct via `npx tsx` — no build step), vitest, `adb`, `ffmpeg` (optional, container normalization only).

**Spec:** `docs/superpowers/specs/2026-07-30-avd-session-recording-design.md`

## Global Constraints

- **Recording is best-effort and must never change a recipe's verdict.** Every recorder call site swallows and logs its own errors, exactly as `MobileClient.captureFailureForensics` already does. This is the single most important invariant in the plan.
- **Local backend only.** The cloud path must never start a recorder. Phase 2 (ace-web) is a separate plan.
- **SIGINT, never SIGKILL**, to stop `screenrecord` — SIGKILL leaves the mp4 without a moov atom.
- Config env vars and defaults, verbatim: `ACE_MOBILE_RECORD` (default `on`, `off` disables), `ACE_MOBILE_RECORD_BITRATE` (default `1M`), `ACE_MOBILE_RECORD_SIZE` (default `540x1140`).
- Video naming: attempt 1 → `<recipeId>.mp4`; attempt N>1 → `<recipeId>-attempt<N>.mp4`.
- Raw `adb` must reach the mobile MCP's own adb server. Never call bare `adb` — route through `AvdBackend`'s port-injecting shell, or set `ANDROID_ADB_SERVER_PORT` explicitly on a spawn env.
- No `Date.now()` restrictions apply here (that constraint is workflow-script-only) — but do not add new wall-clock sleeps without an injectable poll interval, or the tests get slow.
- **Version bump before PR:** `bash scripts/version-bump.sh` (worktree-safe). Never edit `.claude-plugin/plugin.json` version by hand.
- This is MCP code: after merge, a **full Claude restart** is required, not `/reload-plugins`.

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp/mobile/screen-recorder.ts` (create) | Start/stop a `screenrecord` session; pull + normalize the mp4. Knows nothing about recipes, Drive, or the client |
| `mcp/mobile/video-spool.ts` (create) | Per-session spool directory: copy in, list, clear. Pure filesystem, no adb |
| `mcp/mobile/types.ts` (modify) | `VideoArtifact` type; `RecipeRunResult.videos` |
| `mcp/mobile/backends/avd.ts` (modify) | Expose the port-injecting adb shell + a `getAllocatedPorts` read for the recorder |
| `mcp/mobile/client.ts` (modify) | Wire start/stop into `runRecipe`'s `runOnce`; provenance sidecars; spool |
| `skills/app-screenshot-capture/SKILL.md` (modify) | Upload journey videos; sweep the spool; manifest `videos:` block |
| `skills/common-screenshot-capture/SKILL.md` (modify) | Same sweep — the other run-scoped skill that drives recipes |
| `playbook/integrations/mobile-integration.md` (modify) | Recording section: mechanism, console-auth rejection, off switch |
| `test/mcp/mobile/screen-recorder.test.ts` (create) | Recorder unit tests, injected spawn + shell |
| `test/mcp/mobile/video-spool.test.ts` (create) | Spool unit tests |
| `test/mcp/mobile/client-recording.test.ts` (create) | Client wiring tests with a fake recorder |

---

### Task 1: Recorder core — start, stop, pull

**Files:**
- Create: `mcp/mobile/screen-recorder.ts`
- Modify: `mcp/mobile/types.ts` (append `VideoArtifact`, add `RecipeRunResult.videos`)
- Modify: `mcp/mobile/backends/avd.ts` (add `getAdbShell()` accessor)
- Test: `test/mcp/mobile/screen-recorder.test.ts`

**Interfaces:**
- Consumes: `ShellFn` and `defaultShell` from `./backends/avd.js`; `logInfo` from `./logging.js`.
- Produces:
  - `recorderConfigFromEnv(env?): RecorderConfig` where `RecorderConfig = { enabled: boolean; bitRate: string; size: string }`
  - `buildScreenrecordArgs(serial: string, devicePath: string, cfg: RecorderConfig): string[]`
  - `startRecording(args): RecordingHandle | undefined`
  - `stopRecording(handle: RecordingHandle, opts?): Promise<VideoArtifact | undefined>`
  - `VideoArtifact = { path: string; bytes: number; recipeId: string; dispatchId: string; attempt: number; provenance?: {...} }`
  - `AvdBackend.getAdbShell(): ShellFn`

- [ ] **Step 1: Write the failing tests**

Create `test/mcp/mobile/screen-recorder.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recorderConfigFromEnv,
  buildScreenrecordArgs,
  startRecording,
  stopRecording,
} from '../../../mcp/mobile/screen-recorder.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
}

/** Records every shell call in order so tests can assert sequencing. */
function recordingShell(overrides: Record<string, { stdout?: string; code?: number }> = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const o = overrides[key] ?? {};
    return { stdout: o.stdout ?? '', stderr: '', exitCode: o.code ?? 0 };
  });
  return { fn, calls };
}

function fakeSpawn() {
  const killed: string[] = [];
  const spawned: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const fn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
    spawned.push({ cmd, args, env });
    return { kill: (sig?: string) => killed.push(sig ?? 'SIGTERM'), unref: () => {} };
  };
  return { fn, spawned, killed };
}

describe('recorderConfigFromEnv', () => {
  it('defaults to enabled at 1M / 540x1140', () => {
    expect(recorderConfigFromEnv({})).toEqual({ enabled: true, bitRate: '1M', size: '540x1140' });
  });

  it('ACE_MOBILE_RECORD=off disables (case/whitespace insensitive)', () => {
    expect(recorderConfigFromEnv({ ACE_MOBILE_RECORD: ' OFF ' }).enabled).toBe(false);
  });

  it('honours bitrate and size overrides', () => {
    const cfg = recorderConfigFromEnv({
      ACE_MOBILE_RECORD_BITRATE: '4M',
      ACE_MOBILE_RECORD_SIZE: '1080x2280',
    });
    expect(cfg.bitRate).toBe('4M');
    expect(cfg.size).toBe('1080x2280');
  });
});

describe('buildScreenrecordArgs', () => {
  it('always passes --time-limit 0 so long recipes are not truncated at 180s', () => {
    const args = buildScreenrecordArgs('emulator-5554', '/sdcard/ace-rec-abc-1.mp4', {
      enabled: true,
      bitRate: '1M',
      size: '540x1140',
    });
    expect(args).toEqual([
      '-s', 'emulator-5554', 'shell', 'screenrecord',
      '--time-limit', '0',
      '--bit-rate', '1M',
      '--size', '540x1140',
      '/sdcard/ace-rec-abc-1.mp4',
    ]);
  });
});

describe('startRecording', () => {
  it('returns undefined and spawns nothing when disabled', () => {
    const sp = fakeSpawn();
    const h = startRecording({
      serial: 'emulator-5554', recipeId: 'journey-learn', dispatchId: 'abc', attempt: 1,
      outDir: tmpdir(), config: { enabled: false, bitRate: '1M', size: '540x1140' },
      spawnFn: sp.fn,
    });
    expect(h).toBeUndefined();
    expect(sp.spawned).toHaveLength(0);
  });

  it('spawns adb with the allocated adb-server port in env', () => {
    const sp = fakeSpawn();
    const h = startRecording({
      serial: 'emulator-5554', recipeId: 'journey-learn', dispatchId: 'abc', attempt: 1,
      outDir: tmpdir(), config: { enabled: true, bitRate: '1M', size: '540x1140' },
      adbServerPort: 5039, spawnFn: sp.fn,
    });
    expect(h).toBeDefined();
    expect(sp.spawned[0].cmd).toBe('adb');
    expect(sp.spawned[0].env.ANDROID_ADB_SERVER_PORT).toBe('5039');
    expect(h!.devicePath).toBe('/sdcard/ace-rec-abc-1.mp4');
  });

  it('names attempt 1 <recipeId>.mp4 and later attempts <recipeId>-attemptN.mp4', () => {
    const sp = fakeSpawn();
    const dir = tmpdir();
    const first = startRecording({
      serial: 'e', recipeId: 'journey-learn', dispatchId: 'abc', attempt: 1, outDir: dir,
      config: { enabled: true, bitRate: '1M', size: '540x1140' }, spawnFn: sp.fn,
    });
    const second = startRecording({
      serial: 'e', recipeId: 'journey-learn', dispatchId: 'abc', attempt: 2, outDir: dir,
      config: { enabled: true, bitRate: '1M', size: '540x1140' }, spawnFn: sp.fn,
    });
    expect(path.basename(first!.outPath)).toBe('journey-learn.mp4');
    expect(path.basename(second!.outPath)).toBe('journey-learn-attempt2.mp4');
  });

  it('returns undefined instead of throwing when spawn blows up', () => {
    const h = startRecording({
      serial: 'e', recipeId: 'r', dispatchId: 'abc', attempt: 1, outDir: tmpdir(),
      config: { enabled: true, bitRate: '1M', size: '540x1140' },
      spawnFn: () => { throw new Error('adb missing'); },
    });
    expect(h).toBeUndefined();
  });
});

describe('stopRecording', () => {
  function handleFor(dir: string, killed: string[]) {
    return {
      serial: 'emulator-5554',
      recipeId: 'journey-learn',
      dispatchId: 'abc',
      attempt: 1,
      devicePath: '/sdcard/ace-rec-abc-1.mp4',
      outPath: path.join(dir, 'journey-learn.mp4'),
      child: { kill: (s?: string) => killed.push(s ?? 'SIGTERM') },
    };
  }

  it('stops with SIGINT, waits for a stable size, pulls, then removes the device copy', async () => {
    const dir = tmpdir();
    const killed: string[] = [];
    const h = handleFor(dir, killed);
    const sh = recordingShell({
      'adb -s emulator-5554 shell stat -c %s /sdcard/ace-rec-abc-1.mp4': { stdout: '4096\n' },
    });
    // The pull is what puts bytes on disk in production; emulate it.
    const shellFn = vi.fn(async (cmd: string, args: string[]) => {
      const r = await sh.fn(cmd, args);
      if (args.includes('pull')) fs.writeFileSync(h.outPath, Buffer.alloc(4096));
      return r;
    });

    const art = await stopRecording(h, { shell: shellFn, pollMs: 1, stableTimeoutMs: 50 });

    expect(sh.calls[0]).toBe('adb -s emulator-5554 shell pkill -INT screenrecord');
    const pullIdx = sh.calls.findIndex((c) => c.includes(' pull '));
    const rmIdx = sh.calls.findIndex((c) => c.includes(' rm -f '));
    const statIdx = sh.calls.findIndex((c) => c.includes(' stat '));
    expect(statIdx).toBeGreaterThan(0);
    expect(pullIdx).toBeGreaterThan(statIdx);
    expect(rmIdx).toBeGreaterThan(pullIdx);
    expect(art).toMatchObject({ recipeId: 'journey-learn', attempt: 1, bytes: 4096 });
  });

  it('never sends SIGKILL to screenrecord', async () => {
    const dir = tmpdir();
    const killed: string[] = [];
    const h = handleFor(dir, killed);
    const sh = recordingShell();
    await stopRecording(h, { shell: sh.fn, pollMs: 1, stableTimeoutMs: 20 });
    expect(sh.calls.join('\n')).not.toMatch(/-KILL|-9\b/);
  });

  it('returns undefined (never throws) when the pull fails', async () => {
    const dir = tmpdir();
    const h = handleFor(dir, []);
    const shellFn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('pull')) throw new Error('device offline');
      return { stdout: '10\n', stderr: '', exitCode: 0 };
    });
    await expect(
      stopRecording(h, { shell: shellFn, pollMs: 1, stableTimeoutMs: 20 }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp/mobile/screen-recorder.test.ts`
Expected: FAIL — `Failed to resolve import ".../screen-recorder.js"`.

- [ ] **Step 3: Add the `VideoArtifact` type**

In `mcp/mobile/types.ts`, append after the `ScreenshotEntry` interface:

```ts
/**
 * A screen recording of one recipe-run attempt, captured by
 * `mcp/mobile/screen-recorder.ts` via on-device `adb shell screenrecord`.
 *
 * One per ATTEMPT, not per recipe: `runRecipeWithDriverHeal` can cold-boot
 * the AVD mid-run, which kills the recorder and rotates the serial. The
 * pre-crash segment is the forensically interesting one, so both are kept.
 * Naming: attempt 1 is `<recipeId>.mp4`, later attempts are
 * `<recipeId>-attempt<N>.mp4`.
 */
export interface VideoArtifact {
  /** Absolute host path to the mp4 (inside the run's screenshotDir). */
  path: string;
  bytes: number;
  recipeId: string;
  dispatchId: string;
  /** 1-based attempt index within a single `runRecipe` call. */
  attempt: number;
  /** Same shape/semantics as `ScreenshotEntry.provenance`. */
  provenance?: {
    recipe_id: string;
    dispatch_id: string;
    ace_version: string;
    git_sha?: string;
    written_at_epoch_ms: number;
  };
}
```

Then add to `RecipeRunResult`, immediately after the `screenshots` field:

```ts
  /**
   * Screen recordings of this run, one per attempt. Local backend only —
   * the cloud backend leaves this undefined until Phase 2 (see
   * `docs/superpowers/specs/2026-07-30-avd-session-recording-design.md`).
   * Always best-effort: a recording failure never changes `status`.
   */
  videos?: VideoArtifact[];
```

- [ ] **Step 4: Expose the port-injecting adb shell on `AvdBackend`**

In `mcp/mobile/backends/avd.ts`, add a public accessor immediately after the constructor:

```ts
  /**
   * The port-injecting adb shell used by this backend. Exposed so
   * sibling modules (e.g. `screen-recorder.ts`) issue adb calls against
   * the SAME allocated adb server rather than the default 5037 — a bare
   * `adb` reports an empty device list while the emulator is running fine.
   */
  getAdbShell(): ShellFn {
    return this.shell;
  }
```

- [ ] **Step 5: Write the recorder**

Create `mcp/mobile/screen-recorder.ts`:

```ts
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
  kill(signal?: string): void;
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
    await shell('adb', ['-s', handle.serial, 'pull', handle.devicePath, handle.outPath]);
    try {
      await shell('adb', ['-s', handle.serial, 'shell', 'rm', '-f', handle.devicePath]);
    } catch {
      /* leaving a file on /sdcard is not worth failing over */
    }
    try {
      handle.child.kill();
    } catch {
      /* the local adb client usually exits on its own */
    }
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/mcp/mobile/screen-recorder.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Run the full suite for regressions**

Run: `npm test`
Expected: PASS. `mcp/mobile/types.ts` and `backends/avd.ts` both changed, so `test/mcp/mobile/avd.test.ts` and `registration-coverage.test.ts` are the ones to watch.

- [ ] **Step 8: Commit**

```bash
git add mcp/mobile/screen-recorder.ts mcp/mobile/types.ts mcp/mobile/backends/avd.ts test/mcp/mobile/screen-recorder.test.ts
git commit -m "feat(mobile): on-device screen recorder (start/stop/pull)"
```

---

### Task 2: ffmpeg container normalization

**Files:**
- Modify: `mcp/mobile/screen-recorder.ts`
- Test: `test/mcp/mobile/screen-recorder.test.ts`

**Interfaces:**
- Consumes: `ShellFn` (Task 1).
- Produces: `normalizeContainer(mp4Path: string, shell?: ShellFn): Promise<boolean>` — `true` when the file was rewritten, `false` when left as-is. Called by `stopRecording` before it stats the file.

Why: the pulled mp4 can carry no duration metadata, which makes it seek badly in Drive preview. `ffmpeg -c copy` re-writes the container without re-encoding (fast, lossless). ffmpeg is already installed on ACE workstations, but must be treated as optional.

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp/mobile/screen-recorder.test.ts`:

```ts
import { normalizeContainer } from '../../../mcp/mobile/screen-recorder.js';

describe('normalizeContainer', () => {
  it('remuxes with -c copy and +faststart, replacing the original', async () => {
    const dir = tmpdir();
    const mp4 = path.join(dir, 'journey-learn.mp4');
    fs.writeFileSync(mp4, 'ORIGINAL');
    const sh = recordingShell();
    const shellFn = vi.fn(async (cmd: string, args: string[]) => {
      const r = await sh.fn(cmd, args);
      // Emulate ffmpeg writing its output file.
      const out = args[args.length - 1];
      fs.writeFileSync(out, 'REMUXED');
      return r;
    });

    const changed = await normalizeContainer(mp4, shellFn);

    expect(changed).toBe(true);
    expect(sh.calls[0]).toContain('ffmpeg');
    expect(sh.calls[0]).toContain('-c copy');
    expect(sh.calls[0]).toContain('-movflags +faststart');
    expect(fs.readFileSync(mp4, 'utf8')).toBe('REMUXED');
  });

  it('keeps the original and returns false when ffmpeg is missing', async () => {
    const dir = tmpdir();
    const mp4 = path.join(dir, 'journey-learn.mp4');
    fs.writeFileSync(mp4, 'ORIGINAL');
    const shellFn = vi.fn(async () => { throw new Error('ffmpeg: not found'); });

    await expect(normalizeContainer(mp4, shellFn)).resolves.toBe(false);
    expect(fs.readFileSync(mp4, 'utf8')).toBe('ORIGINAL');
  });

  it('keeps the original when ffmpeg exits non-zero', async () => {
    const dir = tmpdir();
    const mp4 = path.join(dir, 'journey-learn.mp4');
    fs.writeFileSync(mp4, 'ORIGINAL');
    const shellFn = vi.fn(async () => ({ stdout: '', stderr: 'invalid data', exitCode: 1 }));

    await expect(normalizeContainer(mp4, shellFn)).resolves.toBe(false);
    expect(fs.readFileSync(mp4, 'utf8')).toBe('ORIGINAL');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp/mobile/screen-recorder.test.ts -t normalizeContainer`
Expected: FAIL — `normalizeContainer is not a function`.

- [ ] **Step 3: Implement `normalizeContainer`**

Add to `mcp/mobile/screen-recorder.ts`:

```ts
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
```

Note: the test asserts on a joined `cmd args` string, so `-c copy` and `-movflags +faststart` appear as adjacent argv pairs — that matches the array above.

- [ ] **Step 4: Call it from `stopRecording`**

In `stopRecording`, between the `handle.child.kill()` block and the `fs.statSync` line, insert:

```ts
    // Normalize the container BEFORE stat — the remux changes the byte size.
    await normalizeContainer(handle.outPath, shell);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/mcp/mobile/screen-recorder.test.ts`
Expected: PASS. The Task 1 `stopRecording` tests still pass because their fake shells return exit 0 for unscripted calls and the ffmpeg output file never appears, so `normalizeContainer` returns false and leaves the pulled bytes alone.

- [ ] **Step 6: Commit**

```bash
git add mcp/mobile/screen-recorder.ts test/mcp/mobile/screen-recorder.test.ts
git commit -m "feat(mobile): normalize recorded mp4 container via ffmpeg -c copy"
```

---

### Task 3: Per-session video spool

**Files:**
- Create: `mcp/mobile/video-spool.ts`
- Test: `test/mcp/mobile/video-spool.test.ts`

**Interfaces:**
- Consumes: `VideoArtifact` (Task 1).
- Produces:
  - `spoolDir(opts?: { ppid?: number; homeDir?: string }): string`
  - `spoolVideo(artifact: VideoArtifact, opts?: { ppid?: number; homeDir?: string; nowMs?: number }): string | undefined`
  - `listSpooled(opts?: { ppid?: number; homeDir?: string }): string[]`
  - `clearSpool(opts?: { ppid?: number; homeDir?: string }): void`

Why this exists: the mobile MCP has no Drive credentials and no run context — skills upload. But heal, registration, and baseline recipes run from atoms whose callers are not uploading skills. The spool is the handoff: the MCP drops every video in a known place, and a skill sweeps it.

- [ ] **Step 1: Write the failing tests**

Create `test/mcp/mobile/video-spool.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  spoolDir, spoolVideo, listSpooled, clearSpool,
} from '../../../mcp/mobile/video-spool.js';
import type { VideoArtifact } from '../../../mcp/mobile/types.js';

let home: string;
let srcDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-home-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-src-'));
});

function artifact(name: string): VideoArtifact {
  const p = path.join(srcDir, `${name}.mp4`);
  fs.writeFileSync(p, 'VIDEO');
  return { path: p, bytes: 5, recipeId: name, dispatchId: 'abc', attempt: 1 };
}

describe('video-spool', () => {
  it('keys the spool dir by ppid under <home>/.ace/mobile-videos', () => {
    expect(spoolDir({ ppid: 4242, homeDir: home })).toBe(
      path.join(home, '.ace', 'mobile-videos', '4242'),
    );
  });

  it('copies the video in (source is left in place for the run dir)', () => {
    const a = artifact('journey-learn');
    const dest = spoolVideo(a, { ppid: 1, homeDir: home, nowMs: 1700000000000 });
    expect(dest).toBeDefined();
    expect(fs.existsSync(a.path)).toBe(true);
    expect(fs.readFileSync(dest!, 'utf8')).toBe('VIDEO');
    expect(path.basename(dest!)).toBe('1700000000000-journey-learn.mp4');
  });

  it('encodes attempt > 1 in the spooled name', () => {
    const a = { ...artifact('journey-learn'), attempt: 2 };
    const dest = spoolVideo(a, { ppid: 1, homeDir: home, nowMs: 1700000000000 });
    expect(path.basename(dest!)).toBe('1700000000000-journey-learn-attempt2.mp4');
  });

  it('lists spooled files sorted, then clears', () => {
    spoolVideo(artifact('a-recipe'), { ppid: 7, homeDir: home, nowMs: 1000 });
    spoolVideo(artifact('b-recipe'), { ppid: 7, homeDir: home, nowMs: 2000 });
    expect(listSpooled({ ppid: 7, homeDir: home }).map((p) => path.basename(p))).toEqual([
      '1000-a-recipe.mp4', '2000-b-recipe.mp4',
    ]);
    clearSpool({ ppid: 7, homeDir: home });
    expect(listSpooled({ ppid: 7, homeDir: home })).toEqual([]);
  });

  it('listSpooled on a never-used spool returns empty (not a throw)', () => {
    expect(listSpooled({ ppid: 999, homeDir: home })).toEqual([]);
  });

  it('spoolVideo returns undefined instead of throwing when the source is gone', () => {
    const a = artifact('gone');
    fs.rmSync(a.path);
    expect(spoolVideo(a, { ppid: 1, homeDir: home })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp/mobile/video-spool.test.ts`
Expected: FAIL — cannot resolve `video-spool.js`.

- [ ] **Step 3: Implement the spool**

Create `mcp/mobile/video-spool.ts`:

```ts
// mcp/mobile/video-spool.ts
//
// Per-session spool for recorded recipe videos.
//
// The mobile MCP has no Drive credentials and no run context — SKILLS do
// the uploading. But heal, registration, and baseline recipes run from
// atoms whose callers aren't uploading skills, so their videos would be
// orphaned. The spool is the handoff: `MobileClient.runRecipe` drops every
// video here, and `app-screenshot-capture` (plus qa-deep and
// connect-baseline-screenshots) sweeps it at the end of the phase.
//
// Keyed by ppid, the same per-session key `backend-toggle.ts` uses: each
// Claude Code session is its own process, and its MCP server inherits a
// unique parent pid, so two sessions on one workstation never collide.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logInfo } from './logging.js';
import type { VideoArtifact } from './types.js';

interface SpoolOpts {
  ppid?: number;
  /** Override for tests; production always resolves the real home dir. */
  homeDir?: string;
}

export function spoolDir(opts: SpoolOpts = {}): string {
  const home = opts.homeDir ?? os.homedir();
  const ppid = opts.ppid ?? process.ppid;
  return path.join(home, '.ace', 'mobile-videos', String(ppid));
}

/**
 * Copy (not move) a recorded video into the spool. The original stays in
 * the run's screenshotDir so the per-run artifact set remains complete
 * even after the spool is swept and cleared.
 */
export function spoolVideo(
  artifact: VideoArtifact,
  opts: SpoolOpts & { nowMs?: number } = {},
): string | undefined {
  try {
    const dir = spoolDir(opts);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = opts.nowMs ?? Date.now();
    const suffix = artifact.attempt > 1 ? `-attempt${artifact.attempt}` : '';
    const dest = path.join(dir, `${stamp}-${artifact.recipeId}${suffix}.mp4`);
    fs.copyFileSync(artifact.path, dest);
    return dest;
  } catch (e) {
    logInfo(`spoolVideo: failed for ${artifact.path}: ${String(e)}`);
    return undefined;
  }
}

export function listSpooled(opts: SpoolOpts = {}): string[] {
  const dir = spoolDir(opts);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mp4'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function clearSpool(opts: SpoolOpts = {}): void {
  try {
    fs.rmSync(spoolDir(opts), { recursive: true, force: true });
  } catch (e) {
    logInfo(`clearSpool: failed: ${String(e)}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp/mobile/video-spool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/mobile/video-spool.ts test/mcp/mobile/video-spool.test.ts
git commit -m "feat(mobile): per-session video spool for skill-side upload"
```

---

### Task 4: Wire recording into `MobileClient.runRecipe`

**Files:**
- Modify: `mcp/mobile/client.ts` (the `runRecipe` method — the `runRecipeWithDriverHeal` block and the surrounding try/catch)
- Test: `test/mcp/mobile/client-recording.test.ts`

**Interfaces:**
- Consumes: `recorderConfigFromEnv`, `startRecording`, `stopRecording` (Task 1/2); `spoolVideo` (Task 3); `buildProvenance`, `writeProvenanceSidecar` (existing, `lib/screenshot-provenance.ts`); `AvdBackend.getAdbShell()` and `AvdBackend.getAllocatedPorts()` (existing/Task 1).
- Produces: `MobileClientOpts.recorder?: RecorderHooks` — an injection seam so tests substitute a fake recorder:

```ts
export interface RecorderHooks {
  start: typeof startRecording;
  stop: typeof stopRecording;
}
```

Placement rationale: start/stop go **inside** the `runOnce` callback of `runRecipeWithDriverHeal`, not around the whole try. That gets three things at once — one segment per attempt (a driver heal cold-boots the AVD and rotates the serial), coverage of the throw path via `finally`, and automatic exclusion of the cloud branch.

- [ ] **Step 1: Write the failing tests**

Create `test/mcp/mobile/client-recording.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MobileClient } from '../../../mcp/mobile/client.js';
import type { VideoArtifact } from '../../../mcp/mobile/types.js';

/** A fake recorder that records call order and returns a synthetic artifact. */
function fakeRecorder() {
  const events: string[] = [];
  let attempts = 0;
  const start = vi.fn((args: { recipeId: string; attempt: number; outDir: string }) => {
    attempts += 1;
    events.push(`start:${args.attempt}`);
    return {
      serial: 'emulator-5554',
      recipeId: args.recipeId,
      dispatchId: 'abc',
      attempt: args.attempt,
      devicePath: `/sdcard/ace-rec-abc-${args.attempt}.mp4`,
      outPath: path.join(args.outDir, `${args.recipeId}.mp4`),
      child: { kill: () => {} },
    };
  });
  const stop = vi.fn(async (h: { recipeId: string; attempt: number; outPath: string }) => {
    events.push(`stop:${h.attempt}`);
    fs.writeFileSync(h.outPath, 'VIDEO');
    return {
      path: h.outPath, bytes: 5, recipeId: h.recipeId, dispatchId: 'abc', attempt: h.attempt,
    } as VideoArtifact;
  });
  return { hooks: { start, stop }, events, get attempts() { return attempts; } };
}

function tmpShots(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-rec-')), 'journey-learn');
}

describe('MobileClient.runRecipe recording', () => {
  it('starts before the maestro run and stops after it, attaching videos[]', async () => {
    const rec = fakeRecorder();
    const dir = tmpShots();
    const recipePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')), 'journey-learn.yaml');
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- launchApp\n');

    const maestro = {
      runRecipe: vi.fn(async () => {
        rec.events.push('maestro');
        return {
          status: 'pass' as const, exitCode: 0, stdout: '', stderr: '',
          screenshotsDir: dir, screenshots: [],
        };
      }),
    };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: { getAdbShell: () => vi.fn(), getAllocatedPorts: async () => ({ adbServerPort: 5039 }) } as never,
      cloud: null,
      bootstrapConfig: null,
      recorder: rec.hooks as never,
    });

    const result = await client.runRecipe(recipePath, {}, dir, 'ace-avd');

    expect(rec.events).toEqual(['start:1', 'maestro', 'stop:1']);
    expect(result.videos).toHaveLength(1);
    expect(result.videos![0].attempt).toBe(1);
  });

  it('stops the recorder when the maestro run THROWS, and rethrows the original error', async () => {
    const rec = fakeRecorder();
    const dir = tmpShots();
    const recipePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')), 'journey-learn.yaml');
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- launchApp\n');

    const maestro = {
      runRecipe: vi.fn(async () => { throw new Error('driver died'); }),
    };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: { getAdbShell: () => vi.fn(), getAllocatedPorts: async () => ({ adbServerPort: 5039 }) } as never,
      cloud: null, bootstrapConfig: null, recorder: rec.hooks as never,
    });

    await expect(client.runRecipe(recipePath, {}, dir, undefined)).rejects.toThrow('driver died');
    expect(rec.events.filter((e) => e.startsWith('stop:')).length).toBeGreaterThanOrEqual(1);
  });

  it('a recorder failure never changes the recipe verdict', async () => {
    const dir = tmpShots();
    const recipePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')), 'journey-learn.yaml');
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- launchApp\n');

    const maestro = {
      runRecipe: vi.fn(async () => ({
        status: 'pass' as const, exitCode: 0, stdout: '', stderr: '',
        screenshotsDir: dir, screenshots: [],
      })),
    };
    const exploding = {
      start: () => { throw new Error('spawn failed'); },
      stop: async () => { throw new Error('pull failed'); },
    };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: { getAdbShell: () => vi.fn(), getAllocatedPorts: async () => ({ adbServerPort: 5039 }) } as never,
      cloud: null, bootstrapConfig: null, recorder: exploding as never,
    });

    const result = await client.runRecipe(recipePath, {}, dir, 'ace-avd');
    expect(result.status).toBe('pass');
    expect(result.videos ?? []).toEqual([]);
  });

  it('does not record on the cloud backend', async () => {
    const rec = fakeRecorder();
    const dir = tmpShots();
    const recipePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')), 'journey-learn.yaml');
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- launchApp\n');

    const cloud = {
      runRecipe: vi.fn(async () => ({
        status: 'pass' as const, exitCode: 0, stdout: '', stderr: '',
        screenshotsDir: dir, screenshots: [],
      })),
    };
    const client = new MobileClient({
      cloud: cloud as never, bootstrapConfig: null, recorder: rec.hooks as never,
      avd: { getAdbShell: () => vi.fn(), getAllocatedPorts: async () => ({ adbServerPort: 5039 }) } as never,
    });
    // Force the cloud branch the same way the existing cloud tests do.
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    try {
      const result = await client.runRecipe(recipePath, {}, dir, 'cc-baseline');
      expect(rec.hooks.start).not.toHaveBeenCalled();
      expect(result.videos).toBeUndefined();
    } finally {
      delete process.env.ACE_MOBILE_BACKEND;
    }
  });
});
```

Before implementing, run `npx vitest run test/mcp/mobile/client.test.ts` once and read how the existing tests construct `MobileClient` (mock `avd`, `maestro`, `cloud`). If those tests use a different mock shape than the sketch above, **match theirs** — the mock shape is the codebase's convention, not this plan's.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp/mobile/client-recording.test.ts`
Expected: FAIL — `recorder` is not a recognized `MobileClientOpts` key and `result.videos` is undefined.

- [ ] **Step 3: Add the injection seam**

In `mcp/mobile/client.ts`, add to the imports:

```ts
import {
  recorderConfigFromEnv,
  startRecording,
  stopRecording,
} from './screen-recorder.js';
import { spoolVideo } from './video-spool.js';
```

`client.ts` already imports from `./types.js`; add `VideoArtifact` to that existing import rather than writing a second import line.

Define the hook type once, above `MobileClientOpts`, and use that name everywhere:

```ts
/**
 * Screen-recorder seam. Injected only by tests; production binds the real
 * `screen-recorder.ts` functions.
 */
export interface RecorderHooks {
  start: typeof startRecording;
  stop: typeof stopRecording;
}
```

Add to the `MobileClientOpts` interface:

```ts
  recorder?: RecorderHooks;
```

Add the field and constructor line alongside the existing ones:

```ts
  private readonly recorder: RecorderHooks;
```
```ts
    this.recorder = opts.recorder ?? { start: startRecording, stop: stopRecording };
```

- [ ] **Step 4: Wire start/stop into `runOnce`**

In `runRecipe`, immediately after the `resetScreenshotDir(screenshotDir);` line, add:

```ts
    // Screen recording (local backend only — cloud is Phase 2). Best-effort
    // throughout: a recording failure must never change the recipe verdict.
    const recorderConfig = recorderConfigFromEnv();
    const videos: VideoArtifact[] = [];
    let recordAttempt = 0;
```

Then, inside the `runRecipeWithDriverHeal({...})` call, replace the body of `runOnce` with:

```ts
          runOnce: async () => {
            const avdInfo = avdName ? await this.resolveAvdInfo(avdName) : undefined;
            // Start/stop INSIDE runOnce, not around the whole try: a driver
            // heal cold-boots the AVD and rotates the serial, so each attempt
            // needs its own recorder. The `finally` also covers the throw
            // path for free — a driver death is the case the video is worth
            // most.
            recordAttempt += 1;
            let handle: ReturnType<typeof startRecording>;
            if (recorderConfig.enabled && avdInfo?.serial) {
              try {
                const ports = await this.avd.getAllocatedPorts();
                handle = this.recorder.start({
                  serial: avdInfo.serial,
                  recipeId,
                  dispatchId,
                  attempt: recordAttempt,
                  outDir: screenshotDir,
                  config: recorderConfig,
                  adbServerPort: ports.adbServerPort,
                });
              } catch (e) {
                logInfo(`runRecipe: could not start recording for ${recipeId}: ${String(e)}`);
              }
            }
            try {
              return await this.maestro.runRecipe(prep.resolvedPath, enrichedEnv, screenshotDir, {
                adbPort: avdInfo?.adbPort,
                serial: avdInfo?.serial,
              });
            } finally {
              if (handle) {
                try {
                  const video = await this.recorder.stop(handle, { shell: this.avd.getAdbShell() });
                  if (video) videos.push(video);
                } catch (e) {
                  logInfo(`runRecipe: could not stop recording for ${recipeId}: ${String(e)}`);
                }
              }
            }
          },
```

- [ ] **Step 5: Attach videos on both the throw path and the return path**

In the `catch (e)` block, immediately after the existing `captureFailureForensics` try/catch, add:

```ts
      // Attach whatever we recorded before the throw — same pattern as
      // `failureForensics`. The pre-crash footage is the point.
      if (videos.length) {
        (e as { videos?: VideoArtifact[] }).videos = videos;
        for (const v of videos) spoolVideo(v);
      }
```

Then, in the provenance-stamping block near the end of `runRecipe`, after the existing `for (const s of result.screenshots) { ... }` loop, add:

```ts
    // Stamp + spool the recordings. Sidecars land at `<video>.meta.json`,
    // same convention as PNGs. The spool is how videos from recipes whose
    // callers aren't uploading skills (heal, registration, baseline) still
    // reach Drive — see `mcp/mobile/video-spool.ts`.
    for (const v of videos) {
      try {
        writeProvenanceSidecar(v.path, provenance);
        v.provenance = provenance;
      } catch (e) {
        logInfo(`runRecipe: failed to write provenance sidecar for ${v.path}: ${String(e)}`);
      }
      spoolVideo(v);
    }
    if (videos.length) result.videos = videos;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/mcp/mobile/client-recording.test.ts`
Expected: PASS, all four cases.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. `client.ts` is widely covered — `client.test.ts`, `maestro-driver-retry.test.ts`, and `transient-boot-race.test.ts` are the ones most likely to notice a change in `runOnce`.

- [ ] **Step 8: Commit**

```bash
git add mcp/mobile/client.ts test/mcp/mobile/client-recording.test.ts
git commit -m "feat(mobile): record every local recipe run, one segment per attempt"
```

---

### Task 5: Skill + playbook changes (publication)

**Files:**
- Modify: `skills/app-screenshot-capture/SKILL.md` (new Step 5.7; Step 6 manifest block)
- Modify: `skills/common-screenshot-capture/SKILL.md` (sweep step)
- Modify: `playbook/integrations/mobile-integration.md` (Recording section)

**Interfaces:**
- Consumes: `RecipeRunResult.videos[]` (Task 4) and the spool at `~/.ace/mobile-videos/<ppid>/` (Task 3).
- Produces: Drive artifacts at `6-qa-and-training/videos/<recipe-base>.mp4` and `6-qa-and-training/videos/_device/<name>.mp4`; a `videos:` block in `app-screenshot-capture_manifest.yaml`.

No code, so no TDD cycle. The gate is `npm test` — `test/skill-atom-references.test.ts` fails if a skill names an atom that doesn't exist.

- [ ] **Step 1: Add Step 5.7 to `app-screenshot-capture`**

Insert after the existing `### Step 5.5: Distinctness check` section and before `### Step 6`:

````markdown
### Step 5.7: Upload session videos + sweep the device-video spool

Since 0.13.x every local `mobile_run_recipe` call records an mp4 of the
run (on-device `screenrecord`, see
`playbook/integrations/mobile-integration.md § Recording`). Two sources,
both uploaded:

1. **This dispatch's journey videos** — `RecipeRunResult.videos[]` from
   each Step 5 leg. Upload each to
   `ACE/<opp>/runs/<run-id>/6-qa-and-training/videos/<recipe-base>.mp4`
   via `drive_upload_binary` with `mimeType: "video/mp4"` and
   `shareAnyoneWithLink: true` (so the run-summary page can embed it
   without an auth round-trip). A recipe that needed a driver heal
   contributes two entries — `<recipe-base>.mp4` (pre-crash) and
   `<recipe-base>-attempt2.mp4`; upload both.
2. **The spool** — `~/.ace/mobile-videos/<ppid>/*.mp4`, which collects
   videos from recipes whose callers aren't uploading skills (the
   registration and heal recipes inside `mobile_ensure_avd_running`, the
   static prerequisite recipes from Step 4). Upload each to
   `6-qa-and-training/videos/_device/<filename>` (same mimeType; no
   `shareAnyoneWithLink` needed — these are forensic, not presentational),
   then delete the spool directory.

`videos[]` absent or the spool empty is **not** a failure: recording is
best-effort by contract, and `ACE_MOBILE_RECORD=off` disables it
entirely. Log the count and continue — never halt a dispatch over a
missing video.
````

- [ ] **Step 2: Extend the Step 6 manifest contract**

In `### Step 6: Write '6-qa-and-training/app-screenshot-capture_manifest.yaml'`, append:

````markdown
The manifest also carries a `videos:` block so the training skills and the
run-summary page can find the recordings without re-listing Drive:

```yaml
videos:
  - journey_id: journey-learn-pass
    recipe_base: journey-learn
    attempt: 1
    drive_path: 6-qa-and-training/videos/journey-learn.mp4
    file_id: <drive fileId>
  - journey_id: journey-deliver-submit
    recipe_base: journey-deliver
    attempt: 1
    drive_path: 6-qa-and-training/videos/journey-deliver.mp4
    file_id: <drive fileId>
```

Omit the block entirely when no videos were captured.
````

- [ ] **Step 3: Add the sweep to the other run-scoped capture skill**

Five skills invoke `mobile_run_recipe`: `app-screenshot-capture` (Step 1
above), `common-screenshot-capture`, `connect-baseline-screenshots` (which
`common-screenshot-capture` supersedes — leave it alone),
`selector-map-calibrate`, and `app-test-cases`. Only the first two are
run-scoped, i.e. have a Drive run folder to upload into. The other three
leave their videos in the spool, which is correct: the spool is
session-scoped and cumulative, so the next sweep in that session collects
them.

So add the sweep to `skills/common-screenshot-capture/SKILL.md` only, near
the end of its recipe-running section:

````markdown
**Sweep the device-video spool.** Local `mobile_run_recipe` calls record
an mp4 per run into `~/.ace/mobile-videos/<ppid>/`. Upload each file to
this run's `videos/_device/` folder via `drive_upload_binary`
(`mimeType: "video/mp4"`), then delete the spool directory. Empty spool is
normal — recording is best-effort and `ACE_MOBILE_RECORD=off` disables it.
````

Use that skill's own Drive path convention for the destination folder — read its surrounding upload steps and match them rather than pasting the Phase 6 path.

- [ ] **Step 4: Document the mechanism in the playbook**

Add to `playbook/integrations/mobile-integration.md`:

````markdown
## Recording

Every local `mobile_run_recipe` call records an mp4 via on-device
`adb shell screenrecord --time-limit 0`, started and stopped by
`mcp/mobile/screen-recorder.ts` around each attempt. Videos land in the
run's `screenshotDir` (`<recipeId>.mp4`, plus `<recipeId>-attempt<N>.mp4`
when a driver heal forced a retry) and are copied into a per-session spool
at `~/.ace/mobile-videos/<ppid>/` for skill-side upload.

**Why on-device and not the emulator console.** `adb emu screenrecord`
authenticates against `~/.emulator_console_auth_token`, which is
per-macOS-user. ACE workstations run emulators under more than one account
— probed live 2026-07-30, an `adb emu screenrecord` against a sibling
account's emulator returns `KO: authentication token does not match`. The
console recorder would work for emulators we spawned and fail on any we
merely attach to. On-device `screenrecord` is owner-agnostic.

**`--time-limit 0` is load-bearing.** screenrecord's default limit is 180
seconds; Maestro runs are allowed up to 10 minutes. Without the flag a long
journey silently records only its first three minutes.

**Stop with SIGINT, never SIGKILL.** screenrecord writes the mp4 moov atom
on a clean interrupt; SIGKILL leaves an unplayable file.

**Off switch:** `ACE_MOBILE_RECORD=off`. Tuning: `ACE_MOBILE_RECORD_BITRATE`
(default `1M`), `ACE_MOBILE_RECORD_SIZE` (default `540x1140`) — roughly
5–8 MB per journey-minute at the defaults.

**Cloud backend does not record yet** (Phase 2 — see
`docs/superpowers/specs/2026-07-30-avd-session-recording-design.md`).
````

- [ ] **Step 5: Verify the skill drift detectors still pass**

Run: `npm test -- test/skill-atom-references.test.ts test/scripts/dump-atom-schemas.test.ts`
Expected: PASS. `mobile_run_recipe`'s *parameters* are unchanged, so no atom-schema regeneration is expected — but if the staleness gate fails, run `npx tsx scripts/dump-atom-schemas.ts` and commit the diff.

- [ ] **Step 6: Commit**

```bash
git add skills/app-screenshot-capture/SKILL.md skills/common-screenshot-capture/SKILL.md playbook/integrations/mobile-integration.md
git commit -m "docs(mobile): publish recorded session videos from Phase 6 skills"
```

---

### Task 6: Live validation gate (blocks merge)

**Files:** none — this task changes no code. It is the merge gate the spec requires under § Unproven property.

Why it exists: the design probe recorded an **idle** screen and decoded to 1 frame with `duration=N/A`. That is plausible for a static display, but it does not prove the SIGINT stop-and-finalize path produces a well-formed mp4 for a screen that is moving. `CLAUDE.md § close the loop to the source of truth` forbids shipping an unvalidated device path — an unvalidated recipe/selector fix recreates the class it was meant to fix.

- [ ] **Step 1: Confirm the session is running the code you just wrote**

MCP subprocesses bind their module code at startup, so a session that predates your edits is running stale code.

Run:
```bash
ps -eo ppid,command | awk -v c="$PPID" '$1==c' | grep -o "0\.13\.[0-9]*"
```
Then read the VERSION *inside* that directory (the directory name can lie):
```bash
cat ~/.claude/plugins/cache/ace/ace/<dir-from-above>/VERSION
```
If it doesn't match your working tree, quit and reopen Claude Code before continuing.

- [ ] **Step 2: Run one real journey recipe on a live AVD**

Use an existing opp/run that already has Phase 3 output, and run the Phase 6 capture step:

```
/ace:step app-screenshot-capture <opp>/<run-id>
```

- [ ] **Step 3: Verify the produced mp4 is real**

```bash
ls -l /tmp/ace-screenshots/*/*.mp4
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=nb_read_frames,duration,avg_frame_rate \
  -show_entries format=duration,size \
  -of default=noprint_wrappers=1 <path-to-mp4>
```

**Pass criteria — all three:**
- `nb_read_frames` > 1 (the idle-screen probe returned exactly 1)
- a real `duration` (not `N/A`, not `0.000000`)
- the file opens and plays in QuickTime

If any fails, the stop-and-finalize path is wrong. Most likely causes, in order: the SIGINT didn't reach the device-side process (check `adb -s <serial> shell pgrep screenrecord` after the pkill), or the pull raced the finalize (raise `stableTimeoutMs`). **Do not merge on a partial pass** and do not "fix" it by switching to SIGKILL.

- [ ] **Step 4: Confirm the Drive upload landed**

Check `ACE/<opp>/runs/<run-id>/6-qa-and-training/videos/` for the journey mp4s and `videos/_device/` for the swept spool files. Confirm the spool directory `~/.ace/mobile-videos/<ppid>/` is empty afterwards.

- [ ] **Step 5: Confirm the off switch works**

```bash
ACE_MOBILE_RECORD=off  # set in the environment of a fresh session
```
Re-run one recipe and confirm no mp4 appears and the recipe still passes.

- [ ] **Step 6: Version bump, PR, auto-merge**

```bash
bash scripts/version-bump.sh
git add -A && git commit -m "chore: version bump for AVD session recording"
git push -u origin <branch>
gh pr create -R dimagi-internal/ace --head <branch> \
  --title "feat(mobile): record AVD sessions alongside screenshots" \
  --body "$(cat <<'EOF'
Implements Phase 1 of docs/superpowers/specs/2026-07-30-avd-session-recording-design.md.

Records an mp4 of every local recipe run via on-device `screenrecord`, one
segment per attempt, published to Drive alongside the screenshots.

Live-validated: <paste the ffprobe output from Step 3 here>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge <pr> --auto --merge
```

If the version bump collides with a sibling worktree: `bash scripts/version-bump.sh --rebase-first` then `git push --force-with-lease`.

- [ ] **Step 7: After the PR merges, update this session**

Run `/ace:update`, then **quit and reopen Claude Code** — `/reload-plugins` does not respawn MCP subprocesses, and this is MCP code.

---

## Out of scope (Phase 2, separate plan)

Cloud-backend recording. The mechanism is identical (`adb shell screenrecord` in the ace-web VM), and the plumbing is mostly there already — `controller.run_recipe` syncs an artifact dir to S3 and `_presign_prefix` presigns everything in it, while the plugin's cloud `runRecipe` already downloads every artifact and only gates *classification* on `image/*`. Work: ~20 lines of bash in the SSM script (ace-web PR + deploy) plus `video/*` classification into `videos[]` (plugin). Write that plan once Phase 1's contract is proven live.
