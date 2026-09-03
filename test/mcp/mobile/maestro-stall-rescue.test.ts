/**
 * Wiring test: a stalled or failed `maestro test` chunk must not abandon the
 * captures it already earned.
 *
 * ace#1164 made the watchdog expiry a THROWN `MAESTRO_STALL`, which means no
 * `RecipeRunResult` is built and `collectScreenshots` never runs. These pin
 * that the rescue happens anyway, that the thrown error names what it
 * recovered, and that the pass path is untouched.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';
import { MobileError } from '../../../mcp/mobile/errors.js';
import { RESCUED_PREFIX } from '../../../mcp/mobile/maestro-debug-harvest.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stall-'));
}

/** Populate a Maestro debug bundle as a real killed run would have left one. */
function strandCaptures(maestroHome: string, pngs: string[], log?: string): void {
  const runDir = path.join(maestroHome, 'tests', '2026-08-26_193734');
  const shotDir = path.join(runDir, 'chunk-0', 'takeScreenshot');
  fs.mkdirSync(shotDir, { recursive: true });
  for (const p of pngs) fs.writeFileSync(path.join(shotDir, p), 'realbytes');
  if (log) fs.writeFileSync(path.join(runDir, 'maestro.log'), log);
}

function shellThatStalls() {
  return vi.fn(async () => {
    const e = new Error('shell timeout: maestro test') as Error & { code?: string };
    e.code = 'SHELL_TIMEOUT';
    throw e;
  });
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('MAESTRO_STALL capture rescue', () => {
  it('rescues stranded captures even though the stall throws', async () => {
    const maestroHome = tmpdir();
    process.env.MAESTRO_CLI_HOME = maestroHome;
    const out = tmpdir();
    const recipePath = path.join(out, 'journey-learn.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- tapOn: "a"\n');
    strandCaptures(
      maestroHome,
      ['learn-module-1.png', 'learn-module-2.png'],
      'COMMAND tapOn Next\n',
    );

    const backend = new MaestroBackend({ shell: shellThatStalls() });
    const err = await backend.runRecipe(recipePath, {}, out).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MobileError);
    const e = err as MobileError & {
      diagnostics?: { rescued_screenshots?: string[]; rescued_log?: string | null };
    };
    expect(e.code).toBe('MAESTRO_STALL');

    // The captures are on disk in the dispatch dir, prefix-marked.
    const onDisk = fs.readdirSync(out).filter((f) => f.startsWith(RESCUED_PREFIX)).sort();
    expect(onDisk).toEqual([
      `${RESCUED_PREFIX}chunk-0--learn-module-1.png`,
      `${RESCUED_PREFIX}chunk-0--learn-module-2.png`,
      `${RESCUED_PREFIX}maestro.log`,
    ]);

    // …and the error itself names them, so a caller never has to go digging.
    expect(e.diagnostics?.rescued_screenshots).toHaveLength(2);
    expect(e.diagnostics?.rescued_log).toContain(`${RESCUED_PREFIX}maestro.log`);
    expect(e.message).toContain('rescued 2 stranded capture(s)');
  });

  it('keeps the ace#1164 stall diagnosis intact (progress context preserved)', async () => {
    process.env.MAESTRO_CLI_HOME = tmpdir();
    const out = tmpdir();
    const recipePath = path.join(out, 'journey-learn.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- tapOn: "a"\n');

    const err = await new MaestroBackend({ shell: shellThatStalls() })
      .runRecipe(recipePath, {}, out)
      .then(
        () => null,
        (e: unknown) => e as MobileError,
      );

    expect(err?.code).toBe('MAESTRO_STALL');
    expect(err?.message).toContain('maestro wedged');
    expect(err?.message).toContain('journey-learn.yaml');
    // Nothing to rescue → no misleading "rescued 0 captures" noise.
    expect(err?.message).not.toContain('rescued');
    expect(err?.remediation).toContain('Do NOT assume the walk failed');
  });

  it('rescues on a plain non-zero chunk exit too (driver death, failed assert)', async () => {
    const maestroHome = tmpdir();
    process.env.MAESTRO_CLI_HOME = maestroHome;
    const out = tmpdir();
    const recipePath = path.join(out, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- tapOn: "a"\n');
    strandCaptures(maestroHome, ['before-crash.png']);

    const shell = vi.fn(async () => ({ stdout: '', stderr: 'UNAVAILABLE', exitCode: 1 }));
    const r = await new MaestroBackend({ shell }).runRecipe(recipePath, {}, out);

    expect(r.status).toBe('fail');
    const rescued = r.screenshots.filter((s) => s.stepName.startsWith(RESCUED_PREFIX));
    expect(rescued).toHaveLength(1);
    expect(rescued[0].stepName).toBe(`${RESCUED_PREFIX}chunk-0--before-crash`);
  });

  it('does not rescue on the pass path', async () => {
    const maestroHome = tmpdir();
    process.env.MAESTRO_CLI_HOME = maestroHome;
    const out = tmpdir();
    const recipePath = path.join(out, 'flow.yaml');
    fs.writeFileSync(recipePath, 'appId: x\n---\n- tapOn: "a"\n');
    strandCaptures(maestroHome, ['unrelated.png']);

    const shell = vi.fn(async () => ({ stdout: 'OK', stderr: '', exitCode: 0 }));
    const r = await new MaestroBackend({ shell }).runRecipe(recipePath, {}, out);

    expect(r.status).toBe('pass');
    expect(r.screenshots.filter((s) => s.stepName.startsWith(RESCUED_PREFIX))).toEqual([]);
  });
});
