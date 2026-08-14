/**
 * dimagi-internal/ace#1084 — the parked minor findings from the #1083
 * whole-branch review (AVD session recording, Phase 1). All were adjudicated
 * real-but-not-load-bearing and filed rather than fixed before merge.
 *
 * Four are code defects with a test each:
 *
 *  1. `clearSessionVideos` counts `cleared` from `list()` (which filters
 *     `.mp4`) while `clearSpool` removes the directory RECURSIVELY. Exact
 *     today only because the spool happens to hold nothing else; it
 *     under-reports the moment anything else lands there — including the
 *     `.meta.json` sidecars that fix (4) starts writing.
 *  2. The outer catch around throw-path provenance stamping + spooling is
 *     untested. Both inner operations are self-guarding, so it is
 *     belt-and-braces — but NOTHING proved the original error survives a throw
 *     from that block, which is the whole point of the guard.
 *  3. `nodeSpawn as unknown as NodeSpawnLike` is a DOUBLE cast, which erases
 *     the compile-time check that Node's real `spawn` signature still matches.
 *     This branch shipped #1083 specifically about not erasing its own type
 *     checks.
 *  4. `video-spool` spools the mp4 but not its `<video>.meta.json` provenance
 *     sidecar, so videos uploaded from the spool to `videos/_device/` arrive
 *     UNSTAMPED even though the originals are stamped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { spoolVideo, listSpooled, clearSpool, spoolDir } from '../../../mcp/mobile/video-spool.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-1084-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const artifact = (over = {}) => ({
  path: path.join(home, 'src.mp4'),
  recipeId: 'journey-learn',
  attempt: 1,
  ...over,
});

describe('spoolVideo carries the provenance sidecar (#1084 item 4)', () => {
  it('copies <video>.meta.json alongside the mp4', () => {
    fs.writeFileSync(path.join(home, 'src.mp4'), 'video-bytes');
    fs.writeFileSync(path.join(home, 'src.mp4.meta.json'), '{"recipeId":"journey-learn"}');

    const dest = spoolVideo(artifact() as any, { homeDir: home, ppid: 42, nowMs: 1000 });
    expect(dest).toBeTruthy();
    expect(fs.existsSync(`${dest}.meta.json`), 'sidecar must ride along').toBe(true);
    expect(JSON.parse(fs.readFileSync(`${dest}.meta.json`, 'utf8')).recipeId).toBe('journey-learn');
  });

  it('still spools the mp4 when there is no sidecar to copy', () => {
    fs.writeFileSync(path.join(home, 'src.mp4'), 'video-bytes');
    const dest = spoolVideo(artifact() as any, { homeDir: home, ppid: 42, nowMs: 1000 });
    expect(fs.existsSync(dest!)).toBe(true);
    expect(fs.existsSync(`${dest}.meta.json`)).toBe(false);
  });

  it('a sidecar copy failure never loses the video', () => {
    fs.writeFileSync(path.join(home, 'src.mp4'), 'video-bytes');
    // A directory where the sidecar is expected makes copyFileSync throw.
    fs.mkdirSync(path.join(home, 'src.mp4.meta.json'));
    const dest = spoolVideo(artifact() as any, { homeDir: home, ppid: 42, nowMs: 1000 });
    expect(dest, 'the mp4 must still be spooled').toBeTruthy();
    expect(fs.existsSync(dest!)).toBe(true);
  });
});

describe('listSpooled still enumerates only videos (#1084 item 1 guard)', () => {
  it('does not return the sidecars as if they were recordings', () => {
    fs.writeFileSync(path.join(home, 'src.mp4'), 'v');
    fs.writeFileSync(path.join(home, 'src.mp4.meta.json'), '{}');
    spoolVideo(artifact() as any, { homeDir: home, ppid: 7, nowMs: 1 });

    const listed = listSpooled({ homeDir: home, ppid: 7 });
    expect(listed).toHaveLength(1);
    expect(listed[0].endsWith('.mp4')).toBe(true);
  });
});

describe('countSpooledEntries backs an honest cleared count (#1084 item 1)', () => {
  it('counts every entry the wipe removes, not just the mp4s', async () => {
    const { countSpooledEntries } = await import('../../../mcp/mobile/video-spool.js');
    fs.writeFileSync(path.join(home, 'src.mp4'), 'v');
    fs.writeFileSync(path.join(home, 'src.mp4.meta.json'), '{}');
    spoolVideo(artifact() as any, { homeDir: home, ppid: 9, nowMs: 1 });

    // 1 mp4 + 1 sidecar in the spool.
    expect(listSpooled({ homeDir: home, ppid: 9 })).toHaveLength(1);
    expect(countSpooledEntries({ homeDir: home, ppid: 9 })).toBe(2);
  });

  it('is 0 on a spool that does not exist', async () => {
    const { countSpooledEntries } = await import('../../../mcp/mobile/video-spool.js');
    expect(countSpooledEntries({ homeDir: home, ppid: 123456 })).toBe(0);
  });

  it('clearSpool removes everything it counted', async () => {
    const { countSpooledEntries } = await import('../../../mcp/mobile/video-spool.js');
    fs.writeFileSync(path.join(home, 'src.mp4'), 'v');
    fs.writeFileSync(path.join(home, 'src.mp4.meta.json'), '{}');
    spoolVideo(artifact() as any, { homeDir: home, ppid: 11, nowMs: 1 });
    expect(countSpooledEntries({ homeDir: home, ppid: 11 })).toBe(2);

    clearSpool({ homeDir: home, ppid: 11 });
    expect(fs.existsSync(spoolDir({ homeDir: home, ppid: 11 }))).toBe(false);
    expect(countSpooledEntries({ homeDir: home, ppid: 11 })).toBe(0);
  });
});

describe('createDefaultSpawnFn keeps its compile-time signature check (#1084 item 3)', () => {
  it('accepts the real child_process.spawn without a double cast', async () => {
    // The assertion is that `mcp/mobile/screen-recorder.ts` no longer erases
    // the check with `as unknown as`. `tsc` proves the signatures match; this
    // pins the source so the cast cannot come back.
    const src = fs.readFileSync(
      new URL('../../../mcp/mobile/screen-recorder.ts', import.meta.url).pathname,
      'utf8',
    );
    // Match the CODE, not the doc comment above it — that comment quotes the
    // retired form on purpose, so a naive whole-file grep would fail forever.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/as unknown as NodeSpawnLike/);
    expect(code, 'the default argument must still be the real spawn').toMatch(
      /spawnImpl: NodeSpawnLike = nodeSpawn as NodeSpawnLike/,
    );
  });

  it('still installs the error listener that keeps a spawn failure from killing the MCP', async () => {
    const { createDefaultSpawnFn } = await import('../../../mcp/mobile/screen-recorder.js');
    const on = vi.fn();
    const fake = vi.fn(() => ({ on, pid: 1, kill: vi.fn() }) as any);
    const spawnFn = createDefaultSpawnFn('label', fake as any);
    spawnFn('adb', ['shell'], {} as any);
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});

describe('the throw-path stamp/spool guard is proven, not assumed (#1084 item 2)', () => {
  it('the ORIGINAL recipe error survives a throw from the stamp/spool block', async () => {
    const { MobileClient } = await import('../../../mcp/mobile/client.js');

    const original = new Error('recipe blew up on step 4');
    const recorder = {
      start: () => ({ handle: 'h', devicePath: '/sdcard/x.mp4' }),
      // Return one video so the stamp/spool block is entered at all.
      stop: () => ({
        path: path.join(home, 'rec.mp4'),
        bytes: 10,
        recipeId: 'journey-learn',
        dispatchId: 'd1',
        attempt: 1,
      }),
    };
    // A spool whose `video()` throws is the belt-and-braces case the outer
    // catch exists for: the inner per-video try only wraps sidecar writing.
    const spool = {
      video: () => { throw new Error('spool exploded'); },
      list: () => [],
      clear: () => {},
      dir: () => '/fake',
      count: () => 0,
    };

    const client = new MobileClient({
      avd: {
        requireRunningAvd: async () => ({ avdName: 'a', serial: 'emulator-5556', adbPort: 5037 }),
        diagnose: async () => ({}),
      } as never,
      maestro: { runRecipe: async () => { throw original; } } as never,
      cloud: null as never,
      bootstrapConfig: null,
      recorder: recorder as never,
      spool: spool as never,
      staticRecipesDir: home,
    });

    fs.writeFileSync(path.join(home, 'r.yaml'), 'appId: x\n---\n- launchApp: x\n');
    await expect(
      client.runRecipe(path.join(home, 'r.yaml'), {}, path.join(os.tmpdir(), 'ace-screenshots', 'x', 'y')),
    ).rejects.toThrow(/recipe blew up on step 4/);
  });
});
