import { describe, it, expect, vi } from 'vitest';
import { runRecipeWithDriverHeal } from '../../../mcp/mobile/maestro-driver-retry.js';
import type { RecipeRunResult } from '../../../mcp/mobile/types.js';

// Minimal RecipeRunResult factory — the envelope only reads `status` and
// `failure.failureClass`, so the rest is filler to satisfy the type.
function result(
  status: 'pass' | 'fail',
  failureClass?: RecipeRunResult['failure'] extends infer F
    ? F extends { failureClass: infer C }
      ? C
      : never
    : never,
): RecipeRunResult {
  return {
    status,
    exitCode: status === 'pass' ? 0 : 1,
    stdout: '',
    stderr: '',
    screenshotsDir: '/tmp/x',
    screenshots: [],
    failure: failureClass
      ? { failureClass, stderrExcerpt: String(failureClass) }
      : undefined,
  } as RecipeRunResult;
}

describe('runRecipeWithDriverHeal (jjackson/ace#592 item 5)', () => {
  it('retries once on failureClass=driver, then returns the healed pass', async () => {
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(result('fail', 'driver'))
      .mockResolvedValueOnce(result('pass'));
    const heal = vi.fn().mockResolvedValue(undefined);

    const r = await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 });

    expect(r.status).toBe('pass');
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(heal).toHaveBeenCalledTimes(1); // healed exactly once, between attempts
  });

  it('does NOT retry a real test failure (selector-not-found)', async () => {
    const runOnce = vi.fn().mockResolvedValue(result('fail', 'selector-not-found'));
    const heal = vi.fn().mockResolvedValue(undefined);

    const r = await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 });

    expect(r.status).toBe('fail');
    expect(r.failure?.failureClass).toBe('selector-not-found');
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(heal).not.toHaveBeenCalled(); // a real result — no wasted cold-boot
  });

  it.each(['app-crash', 'test-logic', 'timeout', 'network', 'unknown'] as const)(
    'does NOT retry failureClass=%s',
    async (fc) => {
      const runOnce = vi.fn().mockResolvedValue(result('fail', fc));
      const heal = vi.fn().mockResolvedValue(undefined);

      await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 });

      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(heal).not.toHaveBeenCalled();
    },
  );

  it('retries on a thrown transient transport error (EPIPE), then returns the pass', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const runOnce = vi
      .fn()
      .mockRejectedValueOnce(epipe)
      .mockResolvedValueOnce(result('pass'));
    const heal = vi.fn().mockResolvedValue(undefined);

    const r = await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 });

    expect(r.status).toBe('pass');
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(heal).toHaveBeenCalledTimes(1);
  });

  it('does NOT swallow a non-transient throw (rethrows, no heal)', async () => {
    const boom = new Error('genuine bug: cannot read property of undefined');
    const runOnce = vi.fn().mockRejectedValue(boom);
    const heal = vi.fn().mockResolvedValue(undefined);

    await expect(
      runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 }),
    ).rejects.toThrow('genuine bug');
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(heal).not.toHaveBeenCalled();
  });

  it('is bounded: a persistent driver failure heals once then returns the driver fail', async () => {
    const runOnce = vi.fn().mockResolvedValue(result('fail', 'driver'));
    const heal = vi.fn().mockResolvedValue(undefined);

    const r = await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 1 });

    expect(r.status).toBe('fail');
    expect(r.failure?.failureClass).toBe('driver');
    expect(runOnce).toHaveBeenCalledTimes(2); // first + one retry
    expect(heal).toHaveBeenCalledTimes(1);
  });

  it('maxRetries:0 (no AVD to heal) never heals, returns the driver fail as-is', async () => {
    const runOnce = vi.fn().mockResolvedValue(result('fail', 'driver'));
    const heal = vi.fn().mockResolvedValue(undefined);

    const r = await runRecipeWithDriverHeal({ runOnce, heal, maxRetries: 0 });

    expect(r.status).toBe('fail');
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(heal).not.toHaveBeenCalled();
  });
});
