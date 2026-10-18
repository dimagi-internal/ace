import { describe, it, expect } from 'vitest';
import {
  computeSimCalendar,
  assertSimCalendar,
  deliveryWindow,
  weekOf,
  mondayOnOrBefore,
  SimCalendarError,
} from '../../lib/sim-calendar';
import { simulatedDate } from '../../lib/supply-chain-ref';

describe('computeSimCalendar', () => {
  // 2026-10-18 is a Sunday: the Connect FI run's start day.
  const cal = computeSimCalendar('2026-10-18T20:38:53Z', 4);

  it('lays out week 0 plus N delivery weeks, indexed by week number', () => {
    expect(cal.weeks.map((w) => w.w)).toEqual([0, 1, 2, 3, 4]);
    expect(cal.delivery_weeks).toBe(4);
    expect(cal.sim_start).toBe(cal.weeks[0].start);
  });

  it('starts on the Monday on or before run − (N+1) weeks', () => {
    // 2026-10-18 − 35d = 2026-09-13 (Sunday) → Monday 2026-09-07.
    expect(cal.sim_start).toBe('2026-09-07');
    expect(cal.weeks[4]).toEqual({ w: 4, start: '2026-10-05', end: '2026-10-11' });
  });

  it('is entirely in the past', () => {
    for (const wk of cal.weeks) expect(wk.end < cal.run_started_on).toBe(true);
  });

  it('is in the past even when the run starts on a Monday', () => {
    const c = computeSimCalendar('2026-10-19', 4); // Monday
    expect(c.sim_start).toBe('2026-09-14');
    expect(c.weeks[4].end).toBe('2026-10-18');
    expect(c.weeks[4].end < '2026-10-19').toBe(true);
  });

  it('every week start is a Monday the supply-chain skills can date events in', () => {
    for (const wk of cal.weeks) expect(simulatedDate(wk.start, 6)).toBe(wk.end);
  });

  it('is deterministic for a resume', () => {
    expect(computeSimCalendar('2026-10-18', 4)).toEqual(computeSimCalendar('2026-10-18T23:59:59Z', 4));
  });

  it('refuses a week count outside 1..12', () => {
    expect(() => computeSimCalendar('2026-10-18', 0)).toThrow(SimCalendarError);
    expect(() => computeSimCalendar('2026-10-18', 13)).toThrow(SimCalendarError);
    expect(() => computeSimCalendar('2026-10-18', 2.5)).toThrow(SimCalendarError);
  });

  it('refuses a bad run start', () => {
    expect(() => computeSimCalendar('yesterday', 4)).toThrow(SimCalendarError);
  });
});

describe('assertSimCalendar', () => {
  const good = computeSimCalendar('2026-10-18', 2);

  it('refuses a week that reaches the run start (future-dated records)', () => {
    const bad = { ...good, run_started_on: good.weeks[2].end };
    expect(() => assertSimCalendar(bad)).toThrow(/backdated/);
  });

  it('refuses a week not starting on Monday', () => {
    const bad = structuredClone(good);
    bad.weeks[1] = { w: 1, start: '2026-09-29', end: '2026-10-05' };
    expect(() => assertSimCalendar(bad)).toThrow(/Monday/);
  });

  it('refuses a gap between weeks', () => {
    const bad = structuredClone(good);
    bad.weeks[2] = { w: 2, start: '2026-10-12', end: '2026-10-18' };
    bad.run_started_on = '2026-10-25';
    expect(() => assertSimCalendar(bad)).toThrow(/does not follow/);
  });

  it('refuses a mislabelled week', () => {
    const bad = structuredClone(good);
    bad.weeks[1].w = 3;
    expect(() => assertSimCalendar(bad)).toThrow(/weeks\[w\] must be week w/);
  });
});

describe('helpers', () => {
  const cal = computeSimCalendar('2026-10-18', 4);

  it('deliveryWindow spans week 1 start to week N end', () => {
    expect(deliveryWindow(cal)).toEqual({ start_date: '2026-09-14', end_date: '2026-10-11', weeks: 4 });
  });

  it('weekOf finds the week of a date, or null outside', () => {
    expect(weekOf(cal, '2026-09-07')).toBe(0);
    expect(weekOf(cal, '2026-09-20')).toBe(1);
    expect(weekOf(cal, '2026-10-11')).toBe(4);
    expect(weekOf(cal, '2026-10-12')).toBeNull();
  });

  it('mondayOnOrBefore keeps a Monday and walks back from a Sunday', () => {
    expect(mondayOnOrBefore(new Date('2026-10-19T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-19');
    expect(mondayOnOrBefore(new Date('2026-10-18T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-12');
  });
});
