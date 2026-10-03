import { describe, it, expect } from 'vitest';
import {
  appDaysRemaining,
  findDayCountDrift,
  opportunityWindow,
} from '../../lib/opportunity-window';

// dimagi-internal/ace#2610 — spark/spark-facilitator/20261001-2208.
const SPARK = opportunityWindow('2026-11-02', '2027-02-26');

describe('opportunityWindow', () => {
  it('computes the spark window as 116 days (117 inclusive)', () => {
    expect(SPARK.days).toBe(116);
    expect(SPARK.inclusiveDays).toBe(117);
  });

  it('refuses a non-ISO date and an inverted window', () => {
    expect(() => opportunityWindow('02/11/2026', '2027-02-26')).toThrow(/ISO/);
    expect(() => opportunityWindow('2027-02-26', '2026-11-02')).toThrow(/before/);
  });
});

describe('appDaysRemaining — the job card countdown', () => {
  it('reproduces the 149 the frame showed when captured on the run date', () => {
    // commcare-android ConnectJobRecord.getDaysRemaining(): toDays(end-now+86399999)+1
    expect(appDaysRemaining('2027-02-26', '2026-10-01')).toBe(149);
  });

  it('reads 1 on the last day and 0 after it', () => {
    expect(appDaysRemaining('2027-02-26', '2027-02-26')).toBe(1);
    expect(appDaysRemaining('2027-02-26', '2027-02-27')).toBe(0);
  });
});

describe('findDayCountDrift', () => {
  it('flags the sentence the spark guide published', () => {
    const md =
      '- **What CBFs see before they start:** the job card lists 21 maximum visits, ' +
      '149 days to complete, 1 visit a day and MWK 7,500 per visit.';
    const f = findDayCountDrift(md, SPARK);
    expect(f).toHaveLength(1);
    expect(f[0].claimed).toBe(149);
  });

  it('flags a stated window length that disagrees', () => {
    expect(findDayCountDrift('This is a 181-day pilot.', SPARK)).toHaveLength(1);
    expect(findDayCountDrift('a window of 90 days', SPARK)).toHaveLength(1);
  });

  it('accepts the configured length, exclusive or inclusive', () => {
    expect(findDayCountDrift('The pilot runs a 116-day window.', SPARK)).toEqual([]);
    expect(findDayCountDrift('It runs for 117 days.', SPARK)).toEqual([]);
  });

  it('does not flag a sentence that explains the card as a countdown', () => {
    const md =
      '"Days to complete" counts down to 26 February 2027, so on the day you look it may read 149 days to complete.';
    expect(findDayCountDrift(md, SPARK)).toEqual([]);
  });
});
