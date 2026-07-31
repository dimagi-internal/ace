import { describe, expect, it } from 'vitest';

import {
  checkLearnModuleTimeEstimates,
  expectedHoursForMinutes,
  formatTimeEstimateReport,
} from '../../lib/time-estimate-check';

describe('expectedHoursForMinutes', () => {
  it('rounds up and floors at 1 hour', () => {
    expect(expectedHoursForMinutes(10)).toBe(1);
    expect(expectedHoursForMinutes(20)).toBe(1);
    expect(expectedHoursForMinutes(60)).toBe(1);
    expect(expectedHoursForMinutes(61)).toBe(2);
    expect(expectedHoursForMinutes(90)).toBe(2);
    expect(expectedHoursForMinutes(180)).toBe(3);
  });
});

describe('checkLearnModuleTimeEstimates', () => {
  it('passes the ace#1077 CORRECT shape: 10-20 minute modules declaring 1 hour', () => {
    // spark-facilitator/20260730-1718: five modules budgeted 10-20 minutes,
    // architect (correctly, per the ACE brief) set time_estimate: 1.
    const report = checkLearnModuleTimeEstimates(
      ['m1', 'm2', 'm3', 'm4', 'm5'].map((moduleId) => ({
        moduleId,
        timeEstimate: 1,
        budgetedMinutes: 15,
      })),
    );
    expect(report.modulesChecked).toBe(5);
    expect(report.violations).toEqual([]);
  });

  it('blocks the ace#1077 FAILURE shape: a raw minute count written as hours', () => {
    // An architect obeying Nova's stale "Estimated minutes" description
    // writes 20 for a 20-minute module -> Connect renders "20 hours".
    const report = checkLearnModuleTimeEstimates([
      { moduleId: 'm1_intro', timeEstimate: 20, budgetedMinutes: 20 },
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      moduleId: 'm1_intro',
      violationClass: 'minutes-not-hours',
      severity: 'blocker',
      expectedHours: 1,
    });
  });

  it('flags a near-miss minute count (approximate, not exact match)', () => {
    const report = checkLearnModuleTimeEstimates([
      { moduleId: 'm2', timeEstimate: 44, budgetedMinutes: 45 },
    ]);
    expect(report.violations[0]?.violationClass).toBe('minutes-not-hours');
    expect(report.violations[0]?.severity).toBe('blocker');
  });

  it('blocks missing, non-positive, and non-integer values', () => {
    const report = checkLearnModuleTimeEstimates([
      { moduleId: 'a', timeEstimate: undefined, budgetedMinutes: 15 },
      { moduleId: 'b', timeEstimate: 0, budgetedMinutes: 15 },
      { moduleId: 'c', timeEstimate: 1.5, budgetedMinutes: 90 },
    ]);
    expect(report.violations.map((v) => v.violationClass)).toEqual([
      'missing',
      'non-positive',
      'non-integer',
    ]);
    expect(report.violations.every((v) => v.severity === 'blocker')).toBe(true);
  });

  it('passes a multi-hour module with the right conversion', () => {
    const report = checkLearnModuleTimeEstimates([
      { moduleId: 'm_long', timeEstimate: 2, budgetedMinutes: 90 },
    ]);
    expect(report.violations).toEqual([]);
  });

  it('warns (not blocks) on a modestly inflated or understated estimate', () => {
    const report = checkLearnModuleTimeEstimates([
      // 20-minute module declaring 2hr: inflated, but the unit is right.
      { moduleId: 'inflated', timeEstimate: 2, budgetedMinutes: 20 },
      // 3-hour budget declaring 1hr: understates.
      { moduleId: 'understated', timeEstimate: 1, budgetedMinutes: 180 },
    ]);
    expect(report.violations).toHaveLength(2);
    expect(report.violations.every((v) => v.severity === 'warn')).toBe(true);
    expect(report.violations.every((v) => v.violationClass === 'out-of-range')).toBe(true);
  });

  it('blocks an order-of-magnitude inflated estimate that is not a minute echo', () => {
    // 20-minute budget, value 5: not ~20 (no minute echo) but 5x expected.
    const report = checkLearnModuleTimeEstimates([
      { moduleId: 'way_off', timeEstimate: 5, budgetedMinutes: 20 },
    ]);
    expect(report.violations[0]?.violationClass).toBe('out-of-range');
    expect(report.violations[0]?.severity).toBe('blocker');
  });

  it('without a PDD budget, allows small hour counts and blocks two-digit minute-like counts', () => {
    const report = checkLearnModuleTimeEstimates([
      { moduleId: 'ok1', timeEstimate: 1 },
      { moduleId: 'ok2', timeEstimate: 2 },
      { moduleId: 'suspect', timeEstimate: 45 },
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      moduleId: 'suspect',
      violationClass: 'minutes-not-hours',
      severity: 'blocker',
    });
  });
});

describe('formatTimeEstimateReport', () => {
  it('renders a clean pass line', () => {
    const text = formatTimeEstimateReport({ modulesChecked: 3, violations: [] });
    expect(text).toContain('3 learn module(s)');
    expect(text).toContain('all plausible as hours');
  });

  it('renders one line per violation with severity + class', () => {
    const report = checkLearnModuleTimeEstimates([
      { moduleId: 'm1', timeEstimate: 20, budgetedMinutes: 20 },
    ]);
    const text = formatTimeEstimateReport(report);
    expect(text).toContain('[BLOCKER]');
    expect(text).toContain('minutes-not-hours');
    expect(text).toContain('m1');
  });
});
