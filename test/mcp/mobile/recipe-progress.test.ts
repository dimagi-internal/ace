import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';
import {
  createProgressHeartbeat,
  createDispatchProgressRecorder,
  defaultMaxSilenceMs,
  withRecipeProgress,
  DISPATCH_PROGRESS_FILE,
  type RecipeProgressEvent,
} from '../../../mcp/mobile/recipe-progress.js';
import { CEILING_MS } from '../../../lib/maestro-chunk-timeout.js';

/**
 * dimagi-internal/ace#2877 — `mobile_run_recipe` sent no MCP progress, so
 * Claude Code's stdio idle timeout (1800s, "sent no response or progress")
 * aborted a HEALTHY 25-form Learn walk on smallholder-seasonal/20261012-1549
 * Phase 6 and the tool result was lost.
 *
 * Premise, verified in Claude Code 2.1.296 itself: its tool-call path passes
 * `onprogress` to `callTool` (so the SDK sends `_meta.progressToken`) and that
 * callback resets the idle clock. So progress is the fix, and these tests pin
 * that the server actually sends it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function bootedProbe(cmd: string, args: string[]) {
  if (cmd === 'adb' && args.includes('getprop')) return { stdout: '1\n', stderr: '', exitCode: 0 };
  return null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MaestroBackend chunk loop emits progress (ace#2877)', () => {
  it('sends a start and a finish event for every chunk, in order', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-progress-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(
      recipePath,
      'appId: org.commcare.dalvik\n---\n- tapOn: A\n- takeScreenshot: "screen-a"\n- tapOn: B\n- takeScreenshot: "screen-b"\n- tapOn: C\n',
    );
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const p = bootedProbe(cmd, args);
      if (p) return p;
      if (cmd === 'maestro' || cmd === 'adb') return { stdout: 'OK\n', stderr: '', exitCode: 0 };
      throw new Error(`Unscripted shell call: ${cmd} ${args.join(' ')}`);
    });
    const events: RecipeProgressEvent[] = [];
    const backend = new MaestroBackend({ shell });
    await backend.runRecipe(recipePath, {}, tmp, {
      serial: 'emulator-5554',
      onProgress: (ev) => events.push(ev),
    });

    const maestroCalls = shell.mock.calls.filter(([c, a]) => c === 'maestro' && a.includes('test')).length;
    expect(maestroCalls).toBe(3);
    expect(events.map((e) => `${e.kind}:${'chunkIndex' in e ? e.chunkIndex : ''}`)).toEqual([
      'chunk-start:1', 'chunk-done:1',
      'chunk-start:2', 'chunk-done:2',
      'chunk-start:3', 'chunk-done:3',
    ]);
    expect(events[1]).toMatchObject({ chunksTotal: 3, screenshotName: 'screen-a', exitCode: 0 });
  });

  it('a throwing listener never changes the verdict', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-progress-throw-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- tapOn: A\n- takeScreenshot: "a"\n');
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const p = bootedProbe(cmd, args);
      if (p) return p;
      return { stdout: 'OK\n', stderr: '', exitCode: 0 };
    });
    const r = await new MaestroBackend({ shell }).runRecipe(recipePath, {}, tmp, {
      serial: 'emulator-5554',
      onProgress: () => {
        throw new Error('listener blew up');
      },
    });
    expect(r.status).toBe('pass');
  });
});

describe('progress heartbeat', () => {
  it('beats on an interval between real events, with a strictly increasing progress value', () => {
    vi.useFakeTimers();
    const sent: { progress: number; message: string }[] = [];
    const hb = createProgressHeartbeat({ send: (p) => sent.push(p), intervalMs: 30_000, maxSilenceMs: 10 * 60_000 });
    hb.event('chunk 1/25 running');
    vi.advanceTimersByTime(30_000 * 4);
    hb.stop();
    expect(sent.length).toBe(5);
    expect(sent.map((s) => s.progress)).toEqual([1, 2, 3, 4, 5]);
    expect(sent[4].message).toMatch(/chunk 1\/25 running — still running/);
    vi.advanceTimersByTime(60_000);
    expect(sent.length).toBe(5); // stopped means stopped
  });

  it('a long walk that keeps producing chunks streams progress for its whole length', () => {
    // The live shape: ~25 chunks at ~20s each, then a 12-question final run —
    // well past the 1800s idle window in total. No gap may exceed the window.
    vi.useFakeTimers();
    const times: number[] = [];
    const hb = createProgressHeartbeat({ send: () => times.push(Date.now()) });
    const start = Date.now();
    for (let i = 1; i <= 120; i++) {
      hb.event(`chunk ${i}/120 running`);
      vi.advanceTimersByTime(20_000);
    }
    hb.stop();
    expect(Date.now() - start).toBeGreaterThan(1_800_000);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
  });

  it('covers one long chunk with no boundary inside it (heartbeat, not just events)', () => {
    vi.useFakeTimers();
    let sent = 0;
    const hb = createProgressHeartbeat({ send: () => { sent++; } });
    hb.event('chunk 1/1 running');
    vi.advanceTimersByTime(40 * 60_000); // inside the 45-min per-chunk ceiling
    hb.stop();
    expect(sent).toBe(1 + 80);
  });

  it('goes quiet after maxSilenceMs without a real event, so a true hang still hits the idle timeout', () => {
    vi.useFakeTimers();
    let sent = 0;
    const hb = createProgressHeartbeat({ send: () => { sent++; }, intervalMs: 1_000, maxSilenceMs: 5_000 });
    hb.event('chunk 1/2 running');
    vi.advanceTimersByTime(60_000);
    hb.stop();
    expect(sent).toBe(1 + 5);
  });

  it('the default silence bound sits above the per-chunk ceiling', () => {
    expect(defaultMaxSilenceMs({})).toBe(CEILING_MS + 5 * 60_000);
    expect(defaultMaxSilenceMs({ ACE_MOBILE_CHUNK_TIMEOUT_MS: String(90 * 60_000) })).toBe(95 * 60_000);
  });
});

describe('withRecipeProgress over a real MCP client/server pair', () => {
  async function connect(heartbeatMs: number | null) {
    const server = new McpServer({ name: 'progress-test', version: '0.0.0' });
    server.tool('slow_recipe', {}, async (_args, extra) => {
      const run = async () => {
        await new Promise((r) => setTimeout(r, 600));
        return { content: [{ type: 'text' as const, text: 'done' }] };
      };
      if (heartbeatMs === null) return run();
      return withRecipeProgress(extra, async () => run(), { intervalMs: heartbeatMs });
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it('a silent call longer than the idle window times out (the bug)', async () => {
    const client = await connect(null);
    await expect(
      client.callTool({ name: 'slow_recipe', arguments: {} }, undefined, {
        timeout: 250,
        resetTimeoutOnProgress: true,
        onprogress: () => {},
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('the same call survives when the server streams progress (the fix)', async () => {
    const client = await connect(50);
    const seen: unknown[] = [];
    const r = await client.callTool({ name: 'slow_recipe', arguments: {} }, undefined, {
      timeout: 250,
      resetTimeoutOnProgress: true,
      onprogress: (p) => seen.push(p),
    });
    expect((r.content as { text: string }[])[0].text).toBe('done');
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  it('sends nothing when the request carries no progressToken', async () => {
    const send = vi.fn(async () => {});
    const out = await withRecipeProgress({ sendNotification: send }, async (onProgress) => {
      expect(onProgress).toBeUndefined();
      return 7;
    });
    expect(out).toBe(7);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('dispatch-progress.json survives a lost tool result', () => {
  it('records chunk progress on disk and the final state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-progress-file-'));
    const rec = createDispatchProgressRecorder({ recipeId: 'journey-learn', dispatchId: 'd1', screenshotsDir: dir });
    rec.observe({ kind: 'dispatch-start', recipeId: 'journey-learn', screenshotsDir: dir });
    rec.observe({ kind: 'chunk-start', chunkIndex: 1, chunksTotal: 25, screenshotName: 'm1-check' });
    rec.observe({ kind: 'chunk-done', chunkIndex: 1, chunksTotal: 25, screenshotName: 'm1-check', exitCode: 0 });
    let onDisk = JSON.parse(fs.readFileSync(path.join(dir, DISPATCH_PROGRESS_FILE), 'utf8'));
    expect(onDisk).toMatchObject({
      state: 'running', chunksTotal: 25, chunksCompleted: 1, lastCompletedScreenshot: 'm1-check', screenshotsDir: dir,
    });
    rec.finish('pass');
    onDisk = JSON.parse(fs.readFileSync(path.join(dir, DISPATCH_PROGRESS_FILE), 'utf8'));
    expect(onDisk.state).toBe('pass');
  });
});

describe('mobile_run_recipe is wired to send progress', () => {
  it('the handler takes the request extra and runs inside withRecipeProgress', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'mcp/mobile-server.ts'), 'utf8');
    const start = src.indexOf("'mobile_run_recipe',");
    const end = src.indexOf('server.tool(', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/async \(\{[^}]*\}, extra\) =>/);
    expect(body).toMatch(/withRecipeProgress\(extra,/);
    expect(body).toMatch(/onProgress/);
  });
});
