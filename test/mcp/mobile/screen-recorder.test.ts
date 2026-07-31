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

  it('returns undefined when pull exits nonzero (even with file on disk)', async () => {
    const dir = tmpdir();
    const h = handleFor(dir, []);
    // Pre-create a file at outPath to simulate a partial transfer
    fs.writeFileSync(h.outPath, Buffer.alloc(1024));
    const shellFn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('pull')) {
        return { stdout: '', stderr: 'adb: error: cannot stat remote object', exitCode: 1 };
      }
      return { stdout: '10\n', stderr: '', exitCode: 0 };
    });
    const art = await stopRecording(h, { shell: shellFn, pollMs: 1, stableTimeoutMs: 20 });
    expect(art).toBeUndefined();
  });
});
