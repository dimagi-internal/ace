import { describe, expect, it } from 'vitest';
import { planBenchmarkRepublish } from '../../lib/benchmark-republish.js';

const base = { cohortId: 41, workflowId: 7187, programId: 10097 };

// Shape of spark-facilitator/20261004-1706 (ace#2717): weekly runs, rebuild minted new ids.
const before = [
  { run_id: 7198, period_end: '2026-08-02' },
  { run_id: 7203, period_end: '2026-08-09' },
  { run_id: 7208, period_end: '2026-08-16' },
];
const after = [
  { run_id: 7271, period_end: '2026-08-16' },
  { run_id: 7261, period_end: '2026-08-02' },
  { run_id: 7266, period_end: '2026-08-09' },
];

describe('planBenchmarkRepublish', () => {
  it('orders the publishes oldest first and expects the latest period as-of', () => {
    const plan = planBenchmarkRepublish({ ...base, before, after });
    expect(plan.calls.map((c) => c.run_id)).toEqual([7261, 7266, 7271]);
    expect(plan.calls[0]).toEqual({ cohort_id: 41, workflow_id: 7187, run_id: 7261, program_id: 10097, period_end: '2026-08-02' });
    expect(plan.expectedAsOf).toBe('2026-08-16');
  });

  it('publishes periods the rebuild added beyond the old series', () => {
    const plan = planBenchmarkRepublish({ ...base, before, after: [...after, { run_id: 7276, period_end: '2026-08-23' }] });
    expect(plan.expectedAsOf).toBe('2026-08-23');
    expect(plan.calls).toHaveLength(4);
  });

  it('refuses when a period from before has no run after (partial rebuild)', () => {
    expect(() => planBenchmarkRepublish({ ...base, before, after: after.slice(1) })).toThrow(/2026-08-16 \(run 7208\).*no run after/);
  });

  it('refuses a missing week inside the after-series', () => {
    const gappy = [
      { run_id: 1, period_end: '2026-08-02' },
      { run_id: 2, period_end: '2026-08-16' },
    ];
    expect(() => planBenchmarkRepublish({ ...base, before: [], after: gappy })).toThrow(/not contiguous.*14 days/);
  });

  it('accepts a daily series when cadence is daily', () => {
    const daily = [
      { run_id: 2, period_end: '2026-08-03' },
      { run_id: 1, period_end: '2026-08-02' },
    ];
    expect(planBenchmarkRepublish({ ...base, before: [], after: daily, cadence: 'daily' }).calls.map((c) => c.run_id)).toEqual([1, 2]);
  });

  it('refuses two runs for one period', () => {
    expect(() =>
      planBenchmarkRepublish({ ...base, before: [], after: [...after, { run_id: 9999, period_end: '2026-08-09' }] }),
    ).toThrow(/two runs for period ending 2026-08-09/);
  });

  it('refuses an empty after-listing and a non-ISO period_end', () => {
    expect(() => planBenchmarkRepublish({ ...base, before, after: [] })).toThrow(/empty/);
    expect(() => planBenchmarkRepublish({ ...base, before: [], after: [{ run_id: 1, period_end: '9 Aug' }] })).toThrow(/ISO date/);
  });
});
