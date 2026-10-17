/**
 * Tests for `lib/date-picker-drive.ts` (dimagi-internal/ace#2518).
 *
 * The load-bearing assertion is the first one: the element-relative
 * derivation, fed the recorded 2.64.0 layout, must reproduce EXACTLY the
 * swipe that moved the day 27 -> 28 on spark-facilitator/20260926-1413.
 * If the derivation drifts from the device observation, this fails.
 */
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import {
  DATE_PICKER_2_64_0_OBSERVED,
  DATE_PICKER_2_64_0_OTHER_MEETING,
  datePickerDriveFor,
  dayStepBackFling,
  dayStepBackFlingYaml,
  dayStepFling,
  dayStepFlingYaml,
  nextCellTapIsNoop,
} from '../../lib/date-picker-drive';

describe('dayStepFling', () => {
  it('reproduces the on-device 2.64.0 swipe from the recorded cell bounds', () => {
    expect(dayStepFling(DATE_PICKER_2_64_0_OBSERVED)).toEqual({
      start: '529, 968',
      end: '529, 818',
      duration: 600,
    });
  });

  it('is exactly one row: next-cell centre to current-cell centre', () => {
    const s = dayStepFling(DATE_PICKER_2_64_0_OBSERVED);
    const [, y0] = s.start.split(',').map(Number);
    const [, y1] = s.end.split(',').map(Number);
    expect(y0 - y1).toBe(150);
  });

  it('shifts with the picker (element-relative, not pinned pixels)', () => {
    const dy = 400;
    const shifted = {
      current: { ...DATE_PICKER_2_64_0_OBSERVED.current, top: 755 + dy, bottom: 881 + dy },
      next: { ...DATE_PICKER_2_64_0_OBSERVED.next, top: 881 + dy, bottom: 1055 + dy },
    };
    expect(dayStepFling(shifted)).toEqual({ start: '529, 1368', end: '529, 1218', duration: 600 });
  });

  it('refuses geometry that cannot be current/next cells of one column', () => {
    const { current, next } = DATE_PICKER_2_64_0_OBSERVED;
    expect(() => dayStepFling({ current: next, next: current })).toThrow(/not below/);
    expect(() =>
      dayStepFling({ current, next: { ...next, left: next.left + 210, right: next.right + 210 } }),
    ).toThrow(/one column/);
  });

  it('emits a Maestro swipe step that parses to the observed values', () => {
    const doc = parse(dayStepFlingYaml()) as Array<{ swipe: Record<string, unknown> }>;
    expect(doc).toEqual([{ swipe: { start: '529, 968', end: '529, 818', duration: 600 } }]);
  });
});

describe('dayStepBackFling (ace#2785)', () => {
  // The load-bearing pin: fed the cells measured on spark-facilitator/
  // 20261004-1706 "Other Meeting Record" (2026-10-17), it must reproduce the
  // swipe that moved the day 16 -> 15 and then 15 -> 14 on-device.
  it('reproduces the on-device 2.64.0 back swipe from the measured cells', () => {
    expect(dayStepBackFling(DATE_PICKER_2_64_0_OTHER_MEETING)).toEqual({
      start: '529, 969',
      end: '529, 1119',
      duration: 600,
    });
  });

  it('the forward fling derived from the same cells is the one that moved 14 -> 15 there', () => {
    expect(dayStepFling(DATE_PICKER_2_64_0_OTHER_MEETING)).toEqual({
      start: '529, 1119',
      end: '529, 969',
      duration: 600,
    });
  });

  it('is exactly one row DOWNWARD: current-cell centre to next-cell centre', () => {
    const s = dayStepBackFling(DATE_PICKER_2_64_0_OTHER_MEETING);
    const [x0, y0] = s.start.split(',').map(Number);
    const [x1, y1] = s.end.split(',').map(Number);
    expect(x0).toBe(x1);
    expect(y1 - y0).toBe(150);
  });

  it('is the exact reverse of dayStepFling for any valid layout', () => {
    for (const cells of [DATE_PICKER_2_64_0_OBSERVED, DATE_PICKER_2_64_0_OTHER_MEETING]) {
      const f = dayStepFling(cells);
      expect(dayStepBackFling(cells)).toEqual({ start: f.end, end: f.start, duration: f.duration });
    }
  });

  it('refuses the same impossible geometry dayStepFling refuses', () => {
    const { current, next } = DATE_PICKER_2_64_0_OTHER_MEETING;
    expect(() => dayStepBackFling({ current: next, next: current })).toThrow(/not below/);
  });

  it('emits a Maestro swipe step that parses to the measured values', () => {
    const doc = parse(dayStepBackFlingYaml()) as Array<{ swipe: Record<string, unknown> }>;
    expect(doc).toEqual([{ swipe: { start: '529, 969', end: '529, 1119', duration: 600 } }]);
  });
});

describe('per-APK drive mechanism', () => {
  it('2.63.2 taps the next cell (ace#1081); 2.64.0 flings (ace#2518)', () => {
    expect(datePickerDriveFor('2.63.2')).toBe('tap-next-cell');
    expect(datePickerDriveFor('2.64.0')).toBe('row-fling');
    expect(nextCellTapIsNoop('2.64.0')).toBe(true);
    expect(nextCellTapIsNoop('2.63.2')).toBe(false);
  });

  it('an uncalibrated APK has no drive — never inherited from a sibling', () => {
    expect(datePickerDriveFor('2.65.0')).toBeUndefined();
    expect(nextCellTapIsNoop('2.65.0')).toBe(false);
  });
});
