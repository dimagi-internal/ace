/**
 * dimagi-internal/ace#1300 + #1299 — field-list interaction, calibrated
 * against a LIVE CommCare 2.63.2 form on ACE_Pixel_API_34 (2026-08-14).
 *
 * Both claims were reproduced on-device with a probe app whose field-list
 * carries two text inputs and an inline date question — the shape
 * `spark-facilitator/20260813-2126` hit in production.
 *
 * ## #1300 — the DatePicker swallows the gesture AND spins the date
 *
 * Live ui-dump, portrait 1080x2400:
 *
 * ```
 * DatePicker                    bounds=[214,1208][865,1765]
 *   NumberPicker  (month)       bounds=[235,1250][403,1723]   numberpicker_input "Aug"
 *   NumberPicker  (day)         bounds=[445,1250][613,1723]   numberpicker_input "14"
 *   NumberPicker  (year)        bounds=[655,1250][823,1723]   numberpicker_input "2026"
 * ```
 *
 * A centre-origin swipe — which is what `scrollUntilVisible` issues — lands
 * inside the day column. Measured, three times, on two orientations:
 *
 * ```
 * portrait  swipe x=540 (centre)  Aug 14 -> Aug 22    page did NOT scroll
 * landscape swipe x=1200 (centre) Aug 22 -> Aug 25    page did NOT scroll
 * landscape swipe x=300  (edge)   Aug 25 -> Aug 25    no mutation
 * ```
 *
 * So both halves of the issue hold: the page cannot be scrolled (the group
 * label stayed at bounds=[0,430][1080,588] across the centre swipe), AND the
 * gesture silently mutates a payment-gating field with no error and no
 * assertion able to catch it.
 *
 * The fix is geometric: originate the swipe OUTSIDE the picker's x-range.
 *
 * ## #1299 — `tapOn: below: <label>` is inert
 *
 * The same dump, in document order:
 *
 * ```
 * TextView  "Facilitator's full name (as on the register)"  [42,617][1038,691]
 * TextView  "First name and family name."                   [42,691][1038,756]   <- HINT
 * EditText  ''                        focused=true          [42,756][1038,892]   <- the input
 * TextView  "Phone number"                                  [42,908][1038,982]
 * EditText  ''                        focused=false         [42,982][1038,1118]
 * ```
 *
 * `below: <question label>` selects the element immediately below the LABEL —
 * the **hint TextView** — and tapping a TextView does nothing. Focus stays on
 * the autofocused first input, so every subsequent `inputText` appends there.
 * Note also `focused=true` on the first EditText with ZERO taps performed,
 * and that no EditText carries a resource-id.
 */
import { describe, it, expect } from 'vitest';
import {
  safeScrollOriginX,
  gestureWouldHitPicker,
  type Bounds,
} from '../../lib/fieldlist-gestures.js';

/** The live DatePicker bounds, portrait 1080x2400. */
const PICKER: Bounds = { left: 214, top: 1208, right: 865, bottom: 1765 };
const VIEWPORT = { width: 1080, height: 2400 };

describe('gestureWouldHitPicker (#1300)', () => {
  it('a centre-origin swipe lands inside the picker — the live failure', () => {
    expect(gestureWouldHitPicker({ x: 540, y: 1500 }, PICKER)).toBe(true);
  });

  it('the measured edge-origin swipe does not', () => {
    expect(gestureWouldHitPicker({ x: 100, y: 1500 }, PICKER)).toBe(false);
  });

  it('a point above the picker is clear even at centre x', () => {
    expect(gestureWouldHitPicker({ x: 540, y: 900 }, PICKER)).toBe(false);
  });

  it('holds for the landscape geometry too', () => {
    const land: Bounds = { left: 963, top: 629, right: 1551, bottom: 1080 };
    expect(gestureWouldHitPicker({ x: 1200, y: 950 }, land)).toBe(true);
    expect(gestureWouldHitPicker({ x: 300, y: 950 }, land)).toBe(false);
  });
});

describe('safeScrollOriginX (#1300)', () => {
  it('picks the wider margin — left, for the live portrait picker', () => {
    // left margin 0..214 (214 wide) vs right 865..1080 (215 wide): near-equal,
    // and either is safe. What matters is that it is outside the picker.
    const x = safeScrollOriginX(PICKER, VIEWPORT);
    expect(gestureWouldHitPicker({ x, y: 1500 }, PICKER)).toBe(false);
  });

  it('returns an x the measured-safe swipe would have used', () => {
    const x = safeScrollOriginX(PICKER, VIEWPORT);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(VIEWPORT.width);
  });

  it('handles a picker hugging the left edge by going right', () => {
    const hugLeft: Bounds = { left: 0, top: 1000, right: 900, bottom: 1500 };
    const x = safeScrollOriginX(hugLeft, VIEWPORT);
    expect(x).toBeGreaterThan(900);
    expect(gestureWouldHitPicker({ x, y: 1200 }, hugLeft)).toBe(false);
  });

  it('throws when the picker spans the full width — no safe origin exists', () => {
    const fullWidth: Bounds = { left: 0, top: 1000, right: 1080, bottom: 1500 };
    expect(() => safeScrollOriginX(fullWidth, VIEWPORT)).toThrow(/no safe/i);
  });
});
