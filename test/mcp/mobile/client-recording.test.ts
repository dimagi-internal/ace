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
      avd: fakeAvd() as never,
      cloud: null as never,
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
      avd: fakeAvd() as never,
      cloud: null as never, bootstrapConfig: null, recorder: rec.hooks as never,
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
      avd: fakeAvd() as never,
      cloud: null as never, bootstrapConfig: null, recorder: exploding as never,
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
      avd: fakeAvd() as never,
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
