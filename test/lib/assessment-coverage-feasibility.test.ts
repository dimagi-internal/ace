/**
 * dimagi-internal/ace#1250 — `idea-to-pdd` can mandate an assessment item
 * count that makes it ARITHMETICALLY IMPOSSIBLE for the resulting Learn app to
 * pass `pdd-to-learn-app-eval`'s `assessment_rule_coverage`. Nothing checks the
 * two against each other, so Phase 1 ships a PDD that pre-commits Phase 3 to a
 * `fail`, and the builder is graded down for obeying its brief.
 *
 * Repro: bednet-check-2-visit/20260813-2333. The PDD mandates "exactly 2
 * questions" and forbids adding, dropping or reordering items — recorded as
 * its own deviation D-1, with the residual stated honestly ("not a competence
 * certification"). The rubric then enumerates 3 counter-intuitive rules and 7
 * high-consequence Deliver operations, weights counter-intuitive double, and:
 *
 *   weighted coverage           4/13 = 0.31   (<0.50 band => score <= 3)
 *   counter-intuitive covered   2 of 3
 *   high-consequence covered    0 of 7
 *   dimension                   3.0 => [BLOCKER]
 *   overall                     7.52 => verdict: fail
 *
 * That is the rubric working as designed — it is the out-of-chain fitness
 * axis, deliberately not anchored inside the AI authoring chain, and PDD
 * thinness is a finding rather than an exemption. The defect is that Phase 1
 * had no way to know, and the auto-fix loop cannot converge: it is capped at
 * one round against an immovable number.
 *
 * Blast radius beyond the run: it PERMANENTLY PINS /ace:iterate at 0% on the
 * opp, because the loop's clean gate requires pdd-to-learn-app-eval == pass
 * and no build of this PDD can produce one.
 */
import { describe, it, expect } from 'vitest';
import {
  maxAchievableCoverage,
  coverageBandCeiling,
  minimumItemsForBand,
  checkCoverageFeasibility,
} from '../../lib/assessment-coverage-feasibility.js';

const BEDNET = { itemCount: 2, counterIntuitiveRules: 3, highConsequenceOps: 7 };

describe('maxAchievableCoverage', () => {
  it('reproduces the live number exactly — 4/13', () => {
    expect(maxAchievableCoverage(BEDNET)).toBeCloseTo(4 / 13, 6);
  });

  it('spends items on counter-intuitive rules first, since they weigh double', () => {
    // 1 item, 1 counter-intuitive + 5 ops: best is the double-weighted rule.
    expect(maxAchievableCoverage({ itemCount: 1, counterIntuitiveRules: 1, highConsequenceOps: 5 }))
      .toBeCloseTo(2 / 7, 6);
  });

  it('spills onto high-consequence ops once the counter-intuitive rules are covered', () => {
    expect(maxAchievableCoverage({ itemCount: 5, counterIntuitiveRules: 3, highConsequenceOps: 7 }))
      .toBeCloseTo((2 * 3 + 2) / 13, 6);
  });

  it('caps at 1.0 when there are more items than rules', () => {
    expect(maxAchievableCoverage({ itemCount: 50, counterIntuitiveRules: 3, highConsequenceOps: 7 })).toBe(1);
  });

  it('is 1.0 when there is nothing to cover, rather than dividing by zero', () => {
    expect(maxAchievableCoverage({ itemCount: 0, counterIntuitiveRules: 0, highConsequenceOps: 0 })).toBe(1);
  });
});

describe('coverageBandCeiling', () => {
  it('maps the rubric bands', () => {
    expect(coverageBandCeiling(0.95)).toBe(10);
    expect(coverageBandCeiling(0.75)).toBe(8);
    expect(coverageBandCeiling(0.55)).toBe(6);
    expect(coverageBandCeiling(4 / 13)).toBe(3);
  });
});

describe('minimumItemsForBand', () => {
  it('says how many items the bednet PDD would have needed to clear 0.50', () => {
    // 0.50 of 13 = 6.5 -> need weight >= 6.5: 3 CI (6) + 1 op (1) = 7 => 4 items.
    expect(minimumItemsForBand({ counterIntuitiveRules: 3, highConsequenceOps: 7 }, 0.5)).toBe(4);
  });

  it('returns 0 when there is nothing to cover', () => {
    expect(minimumItemsForBand({ counterIntuitiveRules: 0, highConsequenceOps: 0 }, 0.5)).toBe(0);
  });
});

describe('checkCoverageFeasibility (#1250)', () => {
  it('refuses the bednet mandate and names the number of items it would take', () => {
    const r = checkCoverageFeasibility(BEDNET);
    expect(r.feasible).toBe(false);
    expect(r.maxRatio).toBeCloseTo(4 / 13, 6);
    expect(r.ceilingScore).toBe(3);
    expect(r.minimumItems).toBe(4);
    expect(r.detail).toMatch(/pre-commits/i);
  });

  it('passes a mandate that can reach the band', () => {
    expect(checkCoverageFeasibility({ ...BEDNET, itemCount: 4 }).feasible).toBe(true);
  });

  it('honours a DECLARED coverage deviation instead of blockering — but only a specific one', () => {
    const r = checkCoverageFeasibility({
      ...BEDNET,
      declaredDeviation: { acceptedMaxRatio: 4 / 13, reason: 'D-1: the gate certifies two payment-model facts only' },
    });
    expect(r.feasible).toBe(true);
    expect(r.honouredDeviation).toBe(true);
    expect(r.detail).toMatch(/D-1/);
  });

  it('rejects a deviation that claims MORE coverage than the mandate can reach', () => {
    const r = checkCoverageFeasibility({
      ...BEDNET,
      declaredDeviation: { acceptedMaxRatio: 0.9, reason: 'wishful' },
    });
    expect(r.feasible).toBe(false);
    expect(r.honouredDeviation).toBe(false);
    expect(r.detail).toMatch(/declares a ceiling/i);
  });

  it('rejects a deviation with no stated reason — an unexplained exemption is an escape hatch', () => {
    const r = checkCoverageFeasibility({
      ...BEDNET,
      declaredDeviation: { acceptedMaxRatio: 4 / 13, reason: '' },
    });
    expect(r.feasible).toBe(false);
    expect(r.detail).toMatch(/reason/i);
  });

  it('is silent when the PDD mandates no exact item count', () => {
    const r = checkCoverageFeasibility({ ...BEDNET, itemCount: undefined });
    expect(r.feasible).toBe(true);
    expect(r.detail).toMatch(/no exact item count/i);
  });
});
