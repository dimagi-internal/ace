/**
 * Tests for `lib/iterate-health.ts` — the rolling-window health computation
 * that replaced the frozen-version streak as `/ace:iterate`'s exit condition.
 *
 * Why this exists (the bug these tests lock out): the old loop stored `streak`
 * in `iterate-state.yaml` and zeroed it on every autofix merge, counting the
 * streak "against a plugin version". ACE merges ~9 VERSION bumps/day from
 * parallel worktrees, so `required_streak: 5` demanded five consecutive clean
 * end-to-end runs with nothing merging underneath — a code freeze that never
 * happened. The loop could therefore never report success, and never did.
 *
 * The fix is structural, not a tuning change: streak is now DERIVED from
 * `iterations[]` rather than stored, so no code path can zero it, and the
 * primary metric is a rolling pass rate that does not care which version each
 * iteration ran on.
 */
import { describe, it, expect } from 'vitest';
import {
  computeIterateHealth,
  DEFAULT_ITERATE_WINDOW,
  DEFAULT_ITERATE_PASS_TARGET,
  type IterateIteration,
} from '../../lib/iterate-health.js';

/** Build an iteration list from a verdict string: 'c' = clean, 'd' = dirty. */
function iters(pattern: string, versions?: string[]): IterateIteration[] {
  return pattern.split('').map((ch, i) => ({
    run_id: `2026072${i}-1200`,
    verdict: ch === 'c' ? ('clean' as const) : ('dirty' as const),
    version_at_run: versions?.[i] ?? `0.13.${500 + i}`,
  }));
}

describe('computeIterateHealth', () => {
  describe('insufficient data', () => {
    it('reports insufficient-data below a full window and does not claim convergence', () => {
      const h = computeIterateHealth(iters('ccc'), { window: 5, pass_target: 0.8 });
      expect(h.verdict).toBe('insufficient-data');
      expect(h.considered).toBe(3);
      expect(h.runs_until_readable).toBe(2);
      expect(h.converged).toBe(false);
    });

    it('treats an empty history as insufficient-data, not as a regression', () => {
      const h = computeIterateHealth([], { window: 5, pass_target: 0.8 });
      expect(h.verdict).toBe('insufficient-data');
      expect(h.total).toBe(0);
      expect(h.pass_rate).toBeNull();
      expect(h.runs_until_readable).toBe(5);
    });
  });

  describe('rolling pass rate', () => {
    it('computes pass rate over the last `window` iterations only', () => {
      // 10 iterations; the first five are dirty, the last five clean.
      const h = computeIterateHealth(iters('dddddccccc'), { window: 5, pass_target: 0.8 });
      expect(h.considered).toBe(5);
      expect(h.clean).toBe(5);
      expect(h.dirty).toBe(0);
      expect(h.pass_rate).toBe(1);
      expect(h.verdict).toBe('converged');
    });

    it('ignores version changes entirely — the whole point of the rewrite', () => {
      // Every single iteration ran on a DIFFERENT plugin version. Under the old
      // frozen-version streak this could never converge; here it converges.
      const versions = ['0.13.500', '0.14.001', '0.14.002', '0.15.300', '0.16.999'];
      const h = computeIterateHealth(iters('ccccc', versions), { window: 5, pass_target: 0.8 });
      expect(h.verdict).toBe('converged');
      expect(h.pass_rate).toBe(1);
      expect(Object.keys(h.by_version)).toHaveLength(5);
    });

    it('converges at exactly the target (>=, not >)', () => {
      const h = computeIterateHealth(iters('ccccd'), { window: 5, pass_target: 0.8 });
      expect(h.pass_rate).toBe(0.8);
      expect(h.verdict).toBe('converged');
    });

    it('does not converge just below the target', () => {
      const h = computeIterateHealth(iters('cccdd'), { window: 5, pass_target: 0.8 });
      expect(h.pass_rate).toBeCloseTo(0.6);
      expect(h.verdict).toBe('not-converged');
      expect(h.converged).toBe(false);
    });
  });

  describe('derived streaks (cannot be zeroed by a merge)', () => {
    it('derives the current trailing clean streak from the tail', () => {
      const h = computeIterateHealth(iters('dccc'), { window: 4, pass_target: 0.9 });
      expect(h.current_streak).toBe(3);
    });

    it('reports a current streak of 0 when the newest iteration is dirty', () => {
      const h = computeIterateHealth(iters('cccd'), { window: 4, pass_target: 0.9 });
      expect(h.current_streak).toBe(0);
    });

    it('derives the longest streak across the WHOLE history, not just the window', () => {
      // Longest run of cleans (4) sits outside a 3-wide window.
      const h = computeIterateHealth(iters('ccccdd'), { window: 3, pass_target: 0.9 });
      expect(h.longest_streak).toBe(4);
      expect(h.current_streak).toBe(0);
    });
  });

  describe('trend', () => {
    it('reports improving when the newer half of the window beats the older half', () => {
      const h = computeIterateHealth(iters('ddcc'), { window: 4, pass_target: 0.99 });
      expect(h.trend).toBe('improving');
    });

    it('reports regressing when the newer half is worse', () => {
      const h = computeIterateHealth(iters('ccdd'), { window: 4, pass_target: 0.99 });
      expect(h.trend).toBe('regressing');
    });

    it('reports flat when both halves match', () => {
      const h = computeIterateHealth(iters('cdcd'), { window: 4, pass_target: 0.99 });
      expect(h.trend).toBe('flat');
    });

    it('reports unknown when the window is too small to halve meaningfully', () => {
      const h = computeIterateHealth(iters('cc'), { window: 2, pass_target: 0.5 });
      expect(h.trend).toBe('unknown');
    });
  });

  describe('per-version attribution', () => {
    it('buckets the considered window by version so a bad bump is visible', () => {
      const versions = ['0.13.500', '0.13.500', '0.14.000', '0.14.000'];
      const h = computeIterateHealth(iters('ccdd', versions), { window: 4, pass_target: 0.9 });
      expect(h.by_version['0.13.500']).toEqual({ clean: 2, dirty: 0 });
      expect(h.by_version['0.14.000']).toEqual({ clean: 0, dirty: 2 });
    });

    it('buckets iterations with no recorded version under "unknown"', () => {
      const list: IterateIteration[] = [
        { run_id: 'a', verdict: 'clean' },
        { run_id: 'b', verdict: 'dirty' },
      ];
      const h = computeIterateHealth(list, { window: 2, pass_target: 0.5 });
      expect(h.by_version.unknown).toEqual({ clean: 1, dirty: 1 });
    });
  });

  describe('failure-class concentration', () => {
    it('ranks the failure classes in the window, most frequent first', () => {
      const list: IterateIteration[] = [
        { run_id: 'a', verdict: 'dirty', failure_class: 'app-screenshot-capture: selector-not-found' },
        { run_id: 'b', verdict: 'dirty', failure_class: 'app-screenshot-capture: selector-not-found' },
        { run_id: 'c', verdict: 'dirty', failure_class: 'app-release-qa: ccz mismatch' },
        { run_id: 'd', verdict: 'clean' },
      ];
      const h = computeIterateHealth(list, { window: 4, pass_target: 0.9 });
      expect(h.top_failure_classes[0]).toEqual({
        failure_class: 'app-screenshot-capture: selector-not-found',
        count: 2,
      });
      expect(h.top_failure_classes).toHaveLength(2);
    });

    it('returns an empty failure-class list on an all-clean window', () => {
      const h = computeIterateHealth(iters('cccc'), { window: 4, pass_target: 0.9 });
      expect(h.top_failure_classes).toEqual([]);
    });
  });

  describe('defaults and guards', () => {
    it('falls back to the exported defaults when no options are given', () => {
      const h = computeIterateHealth(iters('c'.repeat(DEFAULT_ITERATE_WINDOW)));
      expect(h.window).toBe(DEFAULT_ITERATE_WINDOW);
      expect(h.pass_target).toBe(DEFAULT_ITERATE_PASS_TARGET);
      expect(h.verdict).toBe('converged');
    });

    it('clamps a nonsensical window to at least 2 rather than dividing by zero', () => {
      const h = computeIterateHealth(iters('cc'), { window: 0, pass_target: 0.5 });
      expect(h.window).toBe(2);
      expect(h.pass_rate).toBe(1);
    });

    it('clamps a pass_target outside (0,1] into range', () => {
      expect(computeIterateHealth(iters('cc'), { window: 2, pass_target: 5 }).pass_target).toBe(1);
      expect(computeIterateHealth(iters('cc'), { window: 2, pass_target: -1 }).pass_target).toBe(
        DEFAULT_ITERATE_PASS_TARGET,
      );
    });

    it('tolerates a non-array history without throwing', () => {
      const h = computeIterateHealth(undefined as unknown as IterateIteration[]);
      expect(h.verdict).toBe('insufficient-data');
      expect(h.total).toBe(0);
    });
  });

  describe('summary line', () => {
    it('renders a one-line human summary the loop can print each iteration', () => {
      const h = computeIterateHealth(iters('dccccc'), { window: 5, pass_target: 0.8 });
      expect(h.summary).toContain('5/5');
      expect(h.summary).toContain('100%');
      expect(h.summary).toContain('converged');
    });

    it('says how many more runs are needed when the window is not yet full', () => {
      const h = computeIterateHealth(iters('cc'), { window: 5, pass_target: 0.8 });
      expect(h.summary).toContain('3 more');
    });
  });
});
