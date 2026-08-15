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

/**
 * ace#1433 — `maxAchievableCoverage` modelled an item bank as ONE rule per
 * item, justified as "an item that covers two rules covers neither well enough
 * to qualify". Measured false on bednet-check-2-visit/20260814-2019: the helper
 * declared 0.667 the ceiling and the built 6-item bank reached 0.867 (13/15).
 * The rubric's qualifying test is *does answering REQUIRE the rule*, and item
 * q6 requires both R6 and R7 — its key is unreachable knowing either alone.
 */
describe('multi-entry items (ace#1433)', () => {
  // The repro's enumeration.
  const e = { counterIntuitiveRules: 4, highConsequenceOps: 7 };

  it('reproduces the shipped under-estimate by default', () => {
    // Every existing caller must keep its current answer.
    expect(maxAchievableCoverage({ ...e, itemCount: 6 })).toBeCloseTo(0.667, 3);
  });

  it('reproduces the MEASURED ceiling from the real blueprint', () => {
    // 3 of the 6 items each carry two entries: q6 (R6+R7), q5 (both
    // observation ops), q3 (R3 + the consent re-affirmation op).
    expect(
      maxAchievableCoverage({ ...e, itemCount: 6, maxEntriesPerItem: 2, pairedItems: 3 }),
    ).toBeCloseTo(13 / 15, 3);
  });

  it('clears the 0.7 band the PDD declared unreachable at 6 items', () => {
    const ratio = maxAchievableCoverage({ ...e, itemCount: 6, maxEntriesPerItem: 2, pairedItems: 3 });
    expect(ratio).toBeGreaterThanOrEqual(0.7);
    expect(coverageBandCeiling(ratio)).toBe(8);
  });

  it('does NOT assume every item is paired — that error runs the dangerous way', () => {
    // Assuming all six are paired returns 1.000 against a measured 0.867. A
    // ceiling nothing can reach declares an infeasible mandate feasible.
    const assumed = maxAchievableCoverage({ ...e, itemCount: 6, maxEntriesPerItem: 2 });
    const actual = maxAchievableCoverage({ ...e, itemCount: 6, maxEntriesPerItem: 2, pairedItems: 3 });
    expect(assumed).toBeGreaterThan(actual);
    expect(actual).toBeCloseTo(13 / 15, 3);
  });

  it('pairedItems: 0 is identical to the old model', () => {
    expect(maxAchievableCoverage({ ...e, itemCount: 6, maxEntriesPerItem: 2, pairedItems: 0 }))
      .toBeCloseTo(maxAchievableCoverage({ ...e, itemCount: 6 }), 6);
  });

  it('cannot pair more items than the bank has', () => {
    expect(maxAchievableCoverage({ ...e, itemCount: 6, maxEntriesPerItem: 2, pairedItems: 99 }))
      .toBeCloseTo(maxAchievableCoverage({ ...e, itemCount: 6, maxEntriesPerItem: 2, pairedItems: 6 }), 6);
  });

  it('never exceeds 1', () => {
    expect(maxAchievableCoverage({ ...e, itemCount: 50, maxEntriesPerItem: 4, pairedItems: 50 })).toBe(1);
  });

  it('spends capacity on the double-weighted rules first', () => {
    // 1 paired item, 2 entries, both should land on CI rules (worth 2 each).
    const r = maxAchievableCoverage({
      counterIntuitiveRules: 4, highConsequenceOps: 7,
      itemCount: 1, maxEntriesPerItem: 2, pairedItems: 1,
    });
    expect(r).toBeCloseTo(4 / 15, 3);
  });

  it('minimumItemsForBand tracks the same model', () => {
    // The number a PDD quotes as "reaching 0.7 would require N items" — an
    // inflated N reads as a source constraint the design does not have.
    expect(minimumItemsForBand(e, 0.7)).toBe(7);
    expect(minimumItemsForBand(e, 0.7, { maxEntriesPerItem: 2, pairedItems: 3 })).toBeLessThan(7);
  });

  it('minimumItemsForBand never pairs more items than the bank it is trying', () => {
    // Otherwise a 1-item bank would be credited with 3 paired items.
    expect(minimumItemsForBand(e, 0.7, { maxEntriesPerItem: 2, pairedItems: 99 })).toBeGreaterThan(0);
  });
});
