import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RESCUED_PREFIX,
  harvestMaestroDebugScreenshots,
  maestroTestsRoot,
} from '../../../mcp/mobile/maestro-debug-harvest.js';

/** Build a fake `~/.maestro` bundle: `<home>/tests/<run>/<flow>/takeScreenshot/*.png` */
function bundle(
  home: string,
  run: string,
  flow: string,
  pngs: Record<string, string>,
  extras: { log?: string } = {},
): string {
  const runDir = path.join(home, 'tests', run);
  const shotDir = path.join(runDir, flow, 'takeScreenshot');
  fs.mkdirSync(shotDir, { recursive: true });
  for (const [name, content] of Object.entries(pngs)) {
    fs.writeFileSync(path.join(shotDir, name), content);
  }
  if (extras.log !== undefined) fs.writeFileSync(path.join(runDir, 'maestro.log'), extras.log);
  return runDir;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-'));
}

describe('harvestMaestroDebugScreenshots', () => {
  it('rescues PNGs a timed-out dispatch stranded in the debug bundle', () => {
    const home = tmpdir();
    const out = tmpdir();
    const since = Date.now();
    bundle(home, '2026-08-26_193734', 'chunk-0', {
      'learn-module-1.png': 'realbytes',
      'learn-module-2.png': 'realbytes',
    });

    const r = harvestMaestroDebugScreenshots({ screenshotDir: out, since, maestroHome: home });

    expect(r.rescued).toHaveLength(2);
    const names = fs.readdirSync(out).sort();
    expect(names).toEqual([
      `${RESCUED_PREFIX}chunk-0--learn-module-1.png`,
      `${RESCUED_PREFIX}chunk-0--learn-module-2.png`,
    ]);
    // Content must survive the copy — a zero-byte "rescue" is worse than none.
    expect(fs.readFileSync(path.join(out, names[0]), 'utf8')).toBe('realbytes');
  });

  it('marks every rescued file so it can never pass as a completed step capture (#756)', () => {
    const home = tmpdir();
    const out = tmpdir();
    bundle(home, 'run-1', 'chunk-0', { 'shot.png': 'x' });
    const r = harvestMaestroDebugScreenshots({
      screenshotDir: out,
      since: Date.now(),
      maestroHome: home,
    });
    expect(r.rescued).toHaveLength(1);
    for (const p of r.rescued) expect(path.basename(p).startsWith(RESCUED_PREFIX)).toBe(true);
  });

  it('IGNORES bundles from before this dispatch started (#756 freshness)', () => {
    const home = tmpdir();
    const out = tmpdir();
    const stale = bundle(home, 'yesterday', 'chunk-0', { 'old.png': 'stale' });
    // Backdate the bundle well past the mtime slack.
    const old = new Date(Date.now() - 6 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const r = harvestMaestroDebugScreenshots({
      screenshotDir: out,
      since: Date.now(),
      maestroHome: home,
    });

    expect(r.rescued).toEqual([]);
    expect(r.sourceDirs).toEqual([]);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('never overwrites a PNG the dispatch itself wrote', () => {
    const home = tmpdir();
    const out = tmpdir();
    fs.writeFileSync(path.join(out, 'shot.png'), 'authentic-dispatch-output');
    bundle(home, 'run-1', 'chunk-0', { 'shot.png': 'bundle-copy' });

    const r = harvestMaestroDebugScreenshots({
      screenshotDir: out,
      since: Date.now(),
      maestroHome: home,
    });

    expect(r.rescued).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(fs.readFileSync(path.join(out, 'shot.png'), 'utf8')).toBe('authentic-dispatch-output');
  });

  it('disambiguates same-named screenshots across chunks by flow name', () => {
    const home = tmpdir();
    const out = tmpdir();
    bundle(home, 'run-1', 'chunk-0', { 'q1.png': 'a' });
    bundle(home, 'run-1', 'chunk-1', { 'q1.png': 'b' });

    const r = harvestMaestroDebugScreenshots({
      screenshotDir: out,
      since: Date.now(),
      maestroHome: home,
    });

    expect(r.rescued).toHaveLength(2);
    expect(fs.readdirSync(out).sort()).toEqual([
      `${RESCUED_PREFIX}chunk-0--q1.png`,
      `${RESCUED_PREFIX}chunk-1--q1.png`,
    ]);
  });

  it('skips zero-byte PNGs — a placeholder must never be shipped', () => {
    const home = tmpdir();
    const out = tmpdir();
    bundle(home, 'run-1', 'chunk-0', { 'empty.png': '', 'real.png': 'bytes' });

    const r = harvestMaestroDebugScreenshots({
      screenshotDir: out,
      since: Date.now(),
      maestroHome: home,
    });

    expect(r.rescued).toHaveLength(1);
    expect(path.basename(r.rescued[0])).toBe(`${RESCUED_PREFIX}chunk-0--real.png`);
    expect(r.skipped).toBe(1);
  });

  it('rescues maestro.log — the only artifact showing where a killed walk died', () => {
    const home = tmpdir();
    const out = tmpdir();
    bundle(home, 'run-1', 'chunk-0', { 'a.png': 'x' }, { log: 'COMMAND ... tapOn Next\n' });

    const r = harvestMaestroDebugScreenshots({
      screenshotDir: out,
      since: Date.now(),
      maestroHome: home,
    });

    expect(r.logPath).toBeDefined();
    expect(fs.readFileSync(r.logPath!, 'utf8')).toContain('tapOn Next');
  });

  it('is a silent no-op when Maestro has never run on this host', () => {
    const out = tmpdir();
    const r = harvestMaestroDebugScreenshots({
      screenshotDir: out,
      since: Date.now(),
      maestroHome: path.join(tmpdir(), 'does-not-exist'),
    });
    expect(r).toEqual({ rescued: [], sourceDirs: [], skipped: 0 });
  });

  it('honours MAESTRO_CLI_HOME when no explicit home is passed', () => {
    expect(maestroTestsRoot(undefined, { MAESTRO_CLI_HOME: '/custom/maestro' })).toBe(
      path.join('/custom/maestro', 'tests'),
    );
  });
});
