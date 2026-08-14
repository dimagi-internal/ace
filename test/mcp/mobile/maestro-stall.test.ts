import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultShell } from '../../../mcp/mobile/backends/avd.js';
import { MaestroBackend } from '../../../mcp/mobile/backends/maestro.js';
import { runRecipeWithDriverHeal } from '../../../mcp/mobile/maestro-driver-retry.js';
import { MobileError, ShellTimeoutError } from '../../../mcp/mobile/errors.js';

/**
 * dimagi-internal/ace#1164 — the 3.1h silent stall, root-caused.
 *
 * The per-call 10-minute Maestro shell timeout has existed since April; the
 * hang was never a missing timeout. The chain was:
 *
 *   1. a wedged `maestro test` rejects with the STRING `"shell timeout: …"`;
 *   2. `isTransientNetworkError` bare-substring-matches `timeout`, so the
 *      driver-heal envelope classified a 10-minute wall-clock burn as a
 *      transport blip;
 *   3. it cold-booted and silently REPLAYED the entire journey from the top
 *      — ~1h of real work — then wedged again and finally threw a bare
 *      string with no context.
 *
 * Two passes + two 10-minute wedges ≈ the 11,259s the harness aborted at,
 * with zero MCP progress the whole time (spark-facilitator/20260731-0656).
 *
 * The fix: type the timeout (`ShellTimeoutError`), convert it to a
 * `MAESTRO_STALL` MobileError naming the last completed chunk, and exclude
 * wall-clock stalls from the transient-throw retry — a stall is a REAL
 * result of a recipe that ran, not a transport crash, per the envelope's
 * own taxonomy.
 */

describe('defaultShell timeout is typed (#1164)', () => {
  it('rejects with ShellTimeoutError carrying code SHELL_TIMEOUT', async () => {
    await expect(defaultShell('sleep', ['5'], { timeoutMs: 120 })).rejects.toMatchObject({
      name: 'MobileError',
      code: 'SHELL_TIMEOUT',
    });
  });

  it('names the command and the budget in the message', async () => {
    await expect(defaultShell('sleep', ['5'], { timeoutMs: 120 })).rejects.toThrow(
      /sleep.*120/s,
    );
  });
});

describe('driver-heal envelope must NOT replay on a wall-clock stall (#1164)', () => {
  it('propagates a SHELL_TIMEOUT throw without healing', async () => {
    const heal = vi.fn();
    const runOnce = vi
      .fn()
      .mockRejectedValue(new ShellTimeoutError('maestro', ['test', 'chunk-7.yaml'], 600_000));
    await expect(
      runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 }),
    ).rejects.toMatchObject({ code: 'SHELL_TIMEOUT' });
    expect(heal).not.toHaveBeenCalled();
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('propagates a MAESTRO_STALL throw without healing', async () => {
    const heal = vi.fn();
    const runOnce = vi
      .fn()
      .mockRejectedValue(new MobileError('MAESTRO_STALL', 'stalled after chunk 3'));
    await expect(
      runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 }),
    ).rejects.toMatchObject({ code: 'MAESTRO_STALL' });
    expect(heal).not.toHaveBeenCalled();
  });

  it('still heals + retries on a genuine transport throw (EPIPE) — the #592 contract is unchanged', async () => {
    const heal = vi.fn();
    const runOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('write EPIPE'))
      .mockResolvedValueOnce({ status: 'pass', exitCode: 0, stdout: '', stderr: '', screenshotsDir: '', screenshots: [] });
    const r = await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 });
    expect(r.status).toBe('pass');
    expect(heal).toHaveBeenCalledTimes(1);
  });
});

describe('MaestroBackend converts a chunk stall into MAESTRO_STALL with progress context (#1164)', () => {
  function bootedProbe(cmd: string, args: string[]) {
    if (cmd !== 'adb') return null;
    if (args.includes('get-state')) return { stdout: 'device\n', stderr: '', exitCode: 0 };
    if (args.includes('getprop') && args.includes('sys.boot_completed')) {
      return { stdout: '1\n', stderr: '', exitCode: 0 };
    }
    return null;
  }

  it('names the last completed chunk + screenshot when a later chunk wedges', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-stall-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    fs.writeFileSync(
      recipePath,
      'appId: org.commcare.dalvik\n---\n- tapOn: A\n- takeScreenshot: "screen-a"\n- tapOn: B\n- takeScreenshot: "screen-b"\n- tapOn: C\n',
    );

    let maestroCalls = 0;
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const p = bootedProbe(cmd, args);
      if (p) return p;
      if (cmd === 'maestro' && args.includes('test')) {
        maestroCalls++;
        if (maestroCalls === 1) return { stdout: 'OK\n', stderr: '', exitCode: 0 };
        throw new ShellTimeoutError(cmd, args, 600_000);
      }
      // uiautomator dump + pull after chunk 1's screenshot
      if (cmd === 'adb') return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`Unscripted shell call: ${cmd} ${args.join(' ')}`);
    });

    const backend = new MaestroBackend({ shell });
    let thrown: unknown;
    try {
      await backend.runRecipe(recipePath, {}, tmp, { serial: 'emulator-5554' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MobileError);
    const err = thrown as MobileError;
    expect(err.code).toBe('MAESTRO_STALL');
    // Progress context: chunk 0 (ending in screen-a) completed; chunk 1 wedged.
    expect(err.diagnostics).toMatchObject({
      chunks_completed: 1,
      last_completed_screenshot: 'screen-a',
    });
    expect(err.message).toMatch(/screen-a/);
    expect(err.remediation).toBeTruthy();
  });

  it('reports zero progress when the single-invocation path wedges', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-stall2-'));
    const recipePath = path.join(tmp, 'flow.yaml');
    // No takeScreenshot → single-invocation fallback path.
    fs.writeFileSync(recipePath, 'appId: org.commcare.dalvik\n---\n- tapOn: A\n');
    const shell = vi.fn(async (cmd: string, args: string[]) => {
      const p = bootedProbe(cmd, args);
      if (p) return p;
      if (cmd === 'maestro') throw new ShellTimeoutError(cmd, args, 600_000);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const backend = new MaestroBackend({ shell });
    await expect(
      backend.runRecipe(recipePath, {}, tmp, { serial: 'emulator-5554' }),
    ).rejects.toMatchObject({ code: 'MAESTRO_STALL' });
  });
});
