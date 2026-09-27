/**
 * How to advance CommCare's inline date widget (a native `DatePicker` of three
 * `NumberPicker` columns) by ONE day, per APK version.
 *
 * Why this exists (dimagi-internal/ace#2518). The ace#1081 idiom — tap the
 * Button directly below the day column's `numberpicker_input` — was measured on
 * CommCare 2.63.2 (Aug 14 -> 15 -> 16, read back). On APK 2.64.0 the same tap
 * is a silent NO-OP: Maestro reports `COMPLETED`, the picker stays on today,
 * and FINISH is then refused by any `. > today()` constraint. Measured on
 * spark-facilitator/20260926-1413 Phase 6 (2026-09-27, 1080x2400), four
 * candidates on the same open form, each read back from a ui dump:
 *
 * ```
 * ace#1081 relational tap (below/rightOf/leftOf numberpicker_input)  27 -> 27
 * tapOn {text: "28", below: {text: "27"}}  (next cell [445,881][613,1055])  27 -> 27
 * tapOn numberpicker_input + eraseText + inputText "28" + hideKeyboard
 *     (hideKeyboard fell through to BACK -> "Exit Form?")               27 -> 27
 * swipe start 529,968 end 529,818 duration 600                          27 -> 28  (constraint cleared)
 * ```
 *
 * So on 2.64.0 the drive is a ONE-ROW upward fling on the DAY column: from the
 * centre of the next-value cell to the centre of the current-value cell.
 *
 * WHY THE RECIPE CARRIES COORDINATES. Maestro 2.5.1 cannot express a bounded,
 * element-anchored swipe: `swipe: {from: <selector>, direction: UP}` goes from
 * the element's centre to y = 10% of the screen height
 * (`AndroidDriver.swipe(Point, SwipeDirection, long)`, bytecode read from
 * `~/.maestro/lib/maestro-client.jar`) — a many-row fling, i.e. the ace#1300
 * "unpredictable number of steps" hazard, not a one-step drive. Percentage
 * `start`/`end` are screen-relative. So the element-relative part lives HERE,
 * at authoring time: `dayStepFling` derives the gesture from the two cells'
 * bounds, and the recipe carries the result.
 *
 * WHAT WAS OBSERVED vs WHAT IS GENERALISED.
 *   - Observed on-device (2.64.0): direction (upward), distance (exactly one
 *     row: next-cell centre -> current-cell centre), column (day), duration
 *     600 ms, and the resulting +1 day.
 *   - Generalised: anchoring on the cells' bounds rather than the literal
 *     pixels, so a picker at a different screen position yields a shifted
 *     gesture. `DATE_PICKER_2_64_0_OBSERVED` reproduces the device pixels
 *     exactly (pinned by test). The current-cell bounds below are INFERRED
 *     (top = next cell's top edge minus the 126px current-row height measured
 *     on 2.63.2; centre 818 matches the recorded current-row centre); the next
 *     cell's bounds are measured.
 *   - Falsified by: a fling built this way on a 2.64.0 picker at another screen
 *     position that leaves the day unchanged or moves it by more than one.
 */

import type { Bounds } from './fieldlist-gestures';

export type DatePickerDrive =
  /** Tap the Button directly below `numberpicker_input` (ace#1081, 2.63.2). */
  | 'tap-next-cell'
  /** One-row upward fling on the day column (ace#2518, 2.64.0). */
  | 'row-fling';

/**
 * Per-APK drive mechanism, each entry backed by an on-device read-back.
 * An APK not listed here has NO calibrated drive — calibrate against a live
 * dump of that build (CLAUDE.md "close the loop to the source of truth"),
 * never transcribe from a sibling version.
 */
export const DATE_PICKER_DRIVE_BY_APK: Readonly<Record<string, DatePickerDrive>> = {
  '2.63.2': 'tap-next-cell',
  '2.64.0': 'row-fling',
};

export function datePickerDriveFor(apkVersion: string): DatePickerDrive | undefined {
  return DATE_PICKER_DRIVE_BY_APK[apkVersion];
}

/** APKs on which the ace#1081 next-cell tap is a MEASURED no-op. */
export function nextCellTapIsNoop(apkVersion: string): boolean {
  return datePickerDriveFor(apkVersion) === 'row-fling';
}

/** The day column's cells, from a ui dump (or the recorded observation). */
export interface DayColumnCells {
  /** The `numberpicker_input` EditText holding the CURRENT day. */
  current: Bounds;
  /** The Button directly below it, holding the NEXT day. */
  next: Bounds;
}

/**
 * The day column as recorded on APK 2.64.0, spark-facilitator/20260926-1413,
 * 1080x2400 portrait, date question at the top of its field-list screen.
 * `next` is measured; `current` is inferred (see file header).
 */
export const DATE_PICKER_2_64_0_OBSERVED: Readonly<DayColumnCells> = {
  current: { left: 445, top: 755, right: 613, bottom: 881 },
  next: { left: 445, top: 881, right: 613, bottom: 1055 },
};

/** Measured on-device; do not change without a new read-back. */
export const ROW_FLING_DURATION_MS = 600;

export interface MaestroSwipe {
  start: string;
  end: string;
  duration: number;
}

const centre = (b: Bounds) => ({
  x: Math.round((b.left + b.right) / 2),
  y: Math.round((b.top + b.bottom) / 2),
});

/**
 * The one-day fling for a 2.64.0 day column: next-cell centre -> current-cell
 * centre, same x. Throws on geometry that cannot be the observed layout
 * (next cell not below current, or columns not vertically aligned), because a
 * fling built from wrong bounds spins the date silently (ace#1300).
 */
export function dayStepFling(cells: DayColumnCells): MaestroSwipe {
  const cur = centre(cells.current);
  const nxt = centre(cells.next);
  if (nxt.y <= cur.y) {
    throw new Error(
      `dayStepFling: next cell centre y=${nxt.y} is not below current cell centre y=${cur.y} — ` +
        'these are not the day column\'s current/next cells (ace#2518).',
    );
  }
  if (Math.abs(nxt.x - cur.x) > 4) {
    throw new Error(
      `dayStepFling: current (x=${cur.x}) and next (x=${nxt.x}) cells are not in one column (ace#2518).`,
    );
  }
  return { start: `${cur.x}, ${nxt.y}`, end: `${cur.x}, ${cur.y}`, duration: ROW_FLING_DURATION_MS };
}

/** The recipe step for a one-day advance, as Maestro YAML lines. */
export function dayStepFlingYaml(cells: DayColumnCells = DATE_PICKER_2_64_0_OBSERVED): string {
  const s = dayStepFling(cells);
  return ['- swipe:', `    start: ${s.start}`, `    end: ${s.end}`, `    duration: ${s.duration}`].join('\n');
}
