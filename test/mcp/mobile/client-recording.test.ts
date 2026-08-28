import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MobileClient } from '../../../mcp/mobile/client.js';
import type { RecorderHooks, SpoolHooks } from '../../../mcp/mobile/client.js';
import type { AvdInfo, RecipeRunResult, VideoArtifact } from '../../../mcp/mobile/types.js';

// ace#1111 pinned screenshot dirs under an allow-listed root. These suites
// build scratch dirs with `mkdtemp` under the OS temp dir, which is outside
// the default roots — point the override at it so they exercise the
// production code path instead of the refusal.
process.env.ACE_SCREENSHOT_ROOT = os.tmpdir();

// Every client in this file is built with `cloud: null` — these suites are
// about the LOCAL recorder/spool path. Backend selection reads
// ACE_MOBILE_BACKEND, and vitest reuses a worker process across test files, so
// a sibling mobile suite that sets it to 'cloud' leaks in whenever the
// scheduler happens to pair them: `requireCloud()` then throws
// CLOUD_NOT_CONFIGURED and every test here fails. The siblings all save and
// restore it correctly, which is exactly why this was invisible — it depends
// on file ordering, not on any one test misbehaving, so merely adding an
// unrelated test file elsewhere in the repo can surface it. Pin it here so
// this file's result does not depend on who it shares a worker with.
process.env.ACE_MOBILE_BACKEND = 'local';




/**
 * A fake recorder that records call order and returns a synthetic artifact.
 *
 * `hooks` is annotated `RecorderHooks` rather than cast through `as never`
 * at the call site. `RecorderHooks` is an interface THIS branch introduces,
 * and it is small enough to satisfy honestly — the `as never` precedent in
 * these tests belongs to the large pre-existing `avd`/`maestro`/`cloud`
 * backend mocks, not to it. Keeping the annotation preserves the one
 * compile-time check that would have caught commit d39377eb's
 * `SpawnedRecorder` signature error, which survived clean per-task reviews.
 */
function fakeRecorder() {
  const events: string[] = [];
  const start = vi.fn(
    (args: Parameters<RecorderHooks['start']>[0]): ReturnType<RecorderHooks['start']> => {
      events.push(`start:${args.attempt}`);
      return {
        serial: 'emulator-5554',
        recipeId: args.recipeId,
        dispatchId: 'abc',
        attempt: args.attempt,
        devicePath: `/sdcard/ace-rec-abc-${args.attempt}.mp4`,
        // Mirror `outFileName` in screen-recorder.ts: attempt 1 is
        // `<recipeId>.mp4`, later attempts carry `-attemptN`. The previous
        // fake returned `<recipeId>.mp4` for EVERY attempt, which would
        // have made a heal-retry test pass over two identical paths.
        outPath: path.join(
          args.outDir,
          args.attempt <= 1 ? `${args.recipeId}.mp4` : `${args.recipeId}-attempt${args.attempt}.mp4`,
        ),
        child: { kill: () => {} },
      };
    },
  );
  const stop = vi.fn(
    async (h: Parameters<RecorderHooks['stop']>[0]): ReturnType<RecorderHooks['stop']> => {
      events.push(`stop:${h.attempt}`);
      fs.writeFileSync(h.outPath, 'VIDEO');
      return {
        path: h.outPath, bytes: 5, recipeId: h.recipeId, dispatchId: 'abc', attempt: h.attempt,
      } as VideoArtifact;
    },
  );
  const hooks: RecorderHooks = { start, stop };
  return { hooks, start, stop, events };
}

/**
 * An in-memory spool. Production `spoolVideo` resolves the REAL
 * `os.homedir()` and the REAL `process.ppid`, so a client test without
 * this seam writes 5-byte "VIDEO" files into the developer's own
 * `~/.ace/mobile-videos/<ppid>/` — one directory per `npm test`, with
 * nothing to GC them. `video-spool.test.ts` already avoids that via its
 * `homeDir` override; this is the client-side equivalent.
 */
function fakeSpool() {
  const spooled: VideoArtifact[] = [];
  let cleared = 0;
  const hooks: SpoolHooks = {
    video: (a) => { spooled.push(a); return `/fake-spool/${path.basename(a.path)}`; },
    list: () => spooled.map((a) => `/fake-spool/${path.basename(a.path)}`),
    clear: () => { cleared += 1; spooled.length = 0; },
    dir: () => '/fake-spool',
    // ace#1084: the wipe removes each video AND its provenance sidecar, so
    // the honest count is 2 per spooled artifact — not `list().length`.
    count: () => spooled.length * 2,
  };
  return { hooks, spooled, get clearCount() { return cleared; } };
}

function tmpShots(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-rec-')), 'journey-learn');
}

function tmpRecipe(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')), 'journey-learn.yaml');
  fs.writeFileSync(p, 'appId: org.commcare.dalvik\n---\n- launchApp\n');
  return p;
}

function passResult(dir: string): RecipeRunResult {
  return {
    status: 'pass', exitCode: 0, stdout: '', stderr: '',
    screenshotsDir: dir, screenshots: [],
  };
}

/**
 * `MobileClient.runRecipe`'s local path resolves the AVD serial via
 * `this.avd.findRunningAvd(avdName)` (see `resolveAvdInfo` in client.ts)
 * BEFORE the recorder ever gets a chance to start — so any test that wants
 * recording to actually fire needs this on the `avd` mock. The plan's test
 * sketch omitted it, which would throw `findRunningAvd is not a function`
 * before recording is ever reached; matching the codebase's real
 * `resolveAvdInfo` contract instead of the sketch's shorthand mock.
 */
function fakeAvd() {
  return {
    findRunningAvd: vi.fn().mockResolvedValue({ name: 'ace-avd', serial: 'emulator-5554', status: 'booted' }),
    getAdbShell: () => vi.fn(),
    getAllocatedPorts: async () => ({ adbServerPort: 5039 }),
  };
}

describe('MobileClient.runRecipe recording', () => {
  it('starts before the maestro run and stops after it, attaching videos[]', async () => {
    const rec = fakeRecorder();
    const spool = fakeSpool();
    const dir = tmpShots();
    const recipePath = tmpRecipe();

    const maestro = {
      runRecipe: vi.fn(async () => {
        rec.events.push('maestro');
        return passResult(dir);
      }),
    };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: fakeAvd() as never,
      cloud: null as never,
      bootstrapConfig: null,
      recorder: rec.hooks,
      spool: spool.hooks,
    });

    const result = await client.runRecipe(recipePath, {}, dir, 'ace-avd');

    expect(rec.events).toEqual(['start:1', 'maestro', 'stop:1']);
    expect(result.videos).toHaveLength(1);
    expect(result.videos![0].attempt).toBe(1);
    // Spool wiring was previously untested — the success path must ALSO
    // drop the video in the spool, because the spool is the only delivery
    // path for recipes whose callers aren't uploading skills.
    expect(spool.spooled.map((v) => v.path)).toEqual([result.videos![0].path]);
  });

  /**
   * The spec's testing section requires: "`videos[]` populated; heal-retry
   * produces two entries." No such test existed — Task 4's plan sketch
   * silently narrowed the spec's list, leaving `fakeRecorder`'s unused
   * `attempts` getter as the only fossil of it.
   *
   * This is the least-obvious mechanism on the branch and the one the
   * design says justifies the complexity: a `recordAttempt` counter closed
   * over from OUTSIDE `runOnce`, a `videos` array accumulating ACROSS
   * attempts, and the `<recipeId>.mp4` / `<recipeId>-attempt2.mp4` naming
   * split. All three are only exercised when a heal actually fires.
   *
   * `ensureAvdRunning` is stubbed because the heal itself is not what's
   * under test — `maestro-driver-retry.test.ts` owns that. Calling the
   * real one here would drag in the whole cold-boot funnel (APK install,
   * environment baseline, `registerTestUser`) and drown the assertion.
   */
  it('a driver heal produces one video PER ATTEMPT, at distinct paths', async () => {
    const rec = fakeRecorder();
    const spool = fakeSpool();
    const dir = tmpShots();
    const recipePath = tmpRecipe();

    let call = 0;
    const maestro = {
      runRecipe: vi.fn(async (): Promise<RecipeRunResult> => {
        call += 1;
        rec.events.push(`maestro:${call}`);
        if (call === 1) {
          return {
            status: 'fail', exitCode: 1, stdout: '', stderr: 'Broken pipe',
            screenshotsDir: dir, screenshots: [],
            failure: { failureClass: 'driver', stderrExcerpt: 'Broken pipe' },
          };
        }
        return passResult(dir);
      }),
    };

    class HealStubClient extends MobileClient {
      healCalls = 0;
      async ensureAvdRunning(name: string): Promise<AvdInfo> {
        this.healCalls += 1;
        return { name, serial: 'emulator-5554', status: 'booted' };
      }
    }

    const client = new HealStubClient({
      maestro: maestro as never,
      avd: fakeAvd() as never,
      cloud: null as never,
      bootstrapConfig: null,
      recorder: rec.hooks,
      spool: spool.hooks,
    });

    const result = await client.runRecipe(recipePath, {}, dir, 'ace-avd');

    expect(client.healCalls).toBe(1);
    expect(result.status).toBe('pass');
    // A recorder per attempt, each closed before the next opens — NOT one
    // recorder spanning the cold-boot (the serial rotates across a heal).
    expect(rec.events).toEqual([
      'start:1', 'maestro:1', 'stop:1',
      'start:2', 'maestro:2', 'stop:2',
    ]);
    expect(result.videos!.map((v) => v.attempt)).toEqual([1, 2]);
    expect(path.basename(result.videos![0].path)).toBe('journey-learn.mp4');
    expect(path.basename(result.videos![1].path)).toBe('journey-learn-attempt2.mp4');
    expect(result.videos![0].path).not.toBe(result.videos![1].path);
    // Both attempts reach the spool — the pre-crash clip is the one worth most.
    expect(spool.spooled).toHaveLength(2);
  });

  it('stops the recorder when the maestro run THROWS, and rethrows the original error', async () => {
    const rec = fakeRecorder();
    const spool = fakeSpool();
    const dir = tmpShots();
    const recipePath = tmpRecipe();

    const maestro = {
      runRecipe: vi.fn(async () => { throw new Error('driver died'); }),
    };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: fakeAvd() as never,
      cloud: null as never, bootstrapConfig: null,
      recorder: rec.hooks, spool: spool.hooks,
    });

    // avdName must be set (not undefined) for recording to start at all —
    // `runRecipe` only resolves an AVD serial (and therefore only starts a
    // recorder) when an avdName is given. The plan's sketch passed
    // `undefined` here, which would make recording never start, and the
    // `stop:` assertion below vacuously fail; using a real avdName is what
    // actually exercises "stop still fires on a driver death".
    await expect(client.runRecipe(recipePath, {}, dir, 'ace-avd')).rejects.toThrow('driver died');
    expect(rec.events.filter((e) => e.startsWith('stop:')).length).toBeGreaterThanOrEqual(1);
  });

  /**
   * The throw path is where the FORENSICALLY interesting footage lands —
   * the device hung or the driver died — and it used to be the only path
   * that shipped its videos WITHOUT a provenance sidecar. (The success
   * path stamped; the throw path only spooled.) A pre-crash clip with no
   * `dispatch_id` can't be told apart from leftover footage of an earlier
   * run, which is the entire reason sidecars exist.
   */
  it('stamps AND spools videos on the throw path, then rethrows untouched', async () => {
    const rec = fakeRecorder();
    const spool = fakeSpool();
    const dir = tmpShots();
    const recipePath = tmpRecipe();

    const boom = new Error('driver died');
    const maestro = { runRecipe: vi.fn(async () => { throw boom; }) };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: fakeAvd() as never,
      cloud: null as never, bootstrapConfig: null,
      recorder: rec.hooks, spool: spool.hooks,
    });

    const caught: unknown = await client.runRecipe(recipePath, {}, dir, 'ace-avd').then(
      () => { throw new Error('expected runRecipe to reject'); },
      (e) => e,
    );

    expect(caught).toBe(boom);
    expect(spool.spooled).toHaveLength(1);
    const video = spool.spooled[0];
    expect(video.provenance?.dispatch_id).toBeTruthy();
    expect(video.provenance?.recipe_id).toBe('journey-learn');
    expect(fs.existsSync(`${video.path}.meta.json`)).toBe(true);
  });

  // `start` throws SYNCHRONOUSLY here, so `handle` is never assigned inside
  // `runOnce` and the `finally` block's `if (handle)` guard skips calling
  // `stop` entirely — `exploding.stop` is wired to throw too but is never
  // actually reached by this scenario. This test proves only the START-side
  // catch. The STOP-side catch (start succeeds, stop throws) is proven
  // independently by the next test.
  it('a recorder failure at start never changes the recipe verdict', async () => {
    const dir = tmpShots();
    const recipePath = tmpRecipe();

    const maestro = { runRecipe: vi.fn(async () => passResult(dir)) };
    const exploding: RecorderHooks = {
      start: () => { throw new Error('spawn failed'); },
      stop: async () => { throw new Error('pull failed'); },
    };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: fakeAvd() as never,
      cloud: null as never, bootstrapConfig: null,
      recorder: exploding, spool: fakeSpool().hooks,
    });

    const result = await client.runRecipe(recipePath, {}, dir, 'ace-avd');
    expect(result.status).toBe('pass');
    expect(result.videos ?? []).toEqual([]);
  });

  // The independent STOP-side proof: `start` SUCCEEDS (returns a real
  // handle, so the `finally` block's `if (handle)` guard is true and
  // `stop` actually gets called), then `stop` throws. Exercises the
  // `this.recorder.stop(...)` try/catch directly — the branch the
  // start-throw test above structurally cannot reach.
  it('a recorder failure at stop (start succeeds) never changes the recipe verdict', async () => {
    const dir = tmpShots();
    const recipePath = tmpRecipe();

    const maestro = { runRecipe: vi.fn(async () => passResult(dir)) };
    const rec = fakeRecorder();
    const stop = vi.fn(async (): ReturnType<RecorderHooks['stop']> => {
      throw new Error('pull failed');
    });
    const hooks: RecorderHooks = { start: rec.start, stop };
    const client = new MobileClient({
      maestro: maestro as never,
      avd: fakeAvd() as never,
      cloud: null as never, bootstrapConfig: null,
      recorder: hooks, spool: fakeSpool().hooks,
    });

    const result = await client.runRecipe(recipePath, {}, dir, 'ace-avd');
    // Prove the stop-throw branch was actually reached, not skipped.
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('pass');
    expect(result.videos ?? []).toEqual([]);
  });

  it('does not record on the cloud backend', async () => {
    const rec = fakeRecorder();
    const dir = tmpShots();
    const recipePath = tmpRecipe();

    const cloud = { runRecipe: vi.fn(async () => passResult(dir)) };
    const client = new MobileClient({
      cloud: cloud as never, bootstrapConfig: null,
      recorder: rec.hooks, spool: fakeSpool().hooks,
      avd: fakeAvd() as never,
    });
    // Force the cloud branch the same way the existing cloud tests do.
    process.env.ACE_MOBILE_BACKEND = 'cloud';
    try {
      const result = await client.runRecipe(recipePath, {}, dir, 'cc-baseline');
      expect(rec.start).not.toHaveBeenCalled();
      expect(result.videos).toBeUndefined();
    } finally {
      delete process.env.ACE_MOBILE_BACKEND;
    }
  });
});

describe('MobileClient session-video spool atoms', () => {
  it('list/clear are scoped to this session and report a real count', () => {
    const spool = fakeSpool();
    const client = new MobileClient({
      avd: fakeAvd() as never, cloud: null as never,
      bootstrapConfig: null, spool: spool.hooks,
    });

    expect(client.listSessionVideos()).toEqual({ spoolDir: '/fake-spool', videos: [] });

    spool.hooks.video({
      path: '/run/journey-learn.mp4', bytes: 5,
      recipeId: 'journey-learn', dispatchId: 'abc', attempt: 1,
    });
    expect(client.listSessionVideos()).toEqual({
      spoolDir: '/fake-spool',
      videos: ['/fake-spool/journey-learn.mp4'],
    });

    // `cleared` must be the count BEFORE the wipe — a skill logs it — and it
    // counts what the WIPE removes, not what `list()` shows. One spooled video
    // is two entries on disk: the mp4 and its `.meta.json` sidecar (ace#1084).
    expect(client.clearSessionVideos()).toEqual({ spoolDir: '/fake-spool', cleared: 2 });
    expect(spool.clearCount).toBe(1);
    expect(client.listSessionVideos().videos).toEqual([]);
  });
});
