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
  datePickerDriveFor,
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
