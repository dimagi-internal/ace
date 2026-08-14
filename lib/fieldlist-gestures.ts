/**
 * Where a scroll gesture may safely originate on a CommCare field-list that
 * contains an inline date question.
 *
 * Why this exists (dimagi-internal/ace#1300), calibrated against a LIVE
 * CommCare 2.63.2 form on `ACE_Pixel_API_34`, 2026-08-14:
 *
 * ```
 * DatePicker                  bounds=[214,1208][865,1765]     (portrait 1080x2400)
 *   NumberPicker  month       [235,1250][403,1723]   numberpicker_input "Aug"
 *   NumberPicker  day         [445,1250][613,1723]   numberpicker_input "14"
 *   NumberPicker  year        [655,1250][823,1723]   numberpicker_input "2026"
 * ```
 *
 * `scrollUntilVisible` swipes from around the vertical centre of the screen,
 * which on this layout is INSIDE the day column. Measured three times across
 * two orientations:
 *
 * ```
 * portrait   swipe x=540  (centre)  Aug 14 -> Aug 22    page did NOT scroll
 * landscape  swipe x=1200 (centre)  Aug 22 -> Aug 25    page did NOT scroll
 * landscape  swipe x=300  (edge)    Aug 25 -> Aug 25    no mutation
 * ```
 *
 * Both halves of the issue hold. The screen cannot be scrolled — the group
 * label stayed at `[0,430][1080,588]` across the centre swipe — so every
 * question below the picker is unreachable. And the gesture **silently
 * mutates the date**, which on a real form is a payment-gating field being
 * changed by automation with no error and nothing able to assert against it.
 *
 * The fix is geometric and needs no new selector: originate the swipe outside
 * the picker's x-range. The edge-origin swipe above is the measured proof.
 */

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Would a gesture starting here be consumed by the picker? */
export function gestureWouldHitPicker(origin: Point, picker: Bounds): boolean {
  return (
    origin.x >= picker.left &&
    origin.x <= picker.right &&
    origin.y >= picker.top &&
    origin.y <= picker.bottom
  );
}

/**
 * An x-coordinate outside the picker, in the wider of the two margins.
 *
 * Throws when the picker spans the full width: there is then no safe origin,
 * and silently returning one would put us back to spinning the date. That case
 * needs a different strategy (collapse the picker, or reorder the question),
 * and the caller must be told rather than handed a number that looks fine.
 */
export function safeScrollOriginX(picker: Bounds, viewport: Viewport, margin = 24): number {
  const leftRoom = picker.left;
  const rightRoom = viewport.width - picker.right;

  if (leftRoom < margin * 2 && rightRoom < margin * 2) {
    throw new Error(
      `safeScrollOriginX: no safe gesture origin — the picker spans [${picker.left}, ${picker.right}] ` +
        `of a ${viewport.width}px viewport, leaving ${leftRoom}px left and ${rightRoom}px right. ` +
        'A centre-origin swipe would spin the date instead of scrolling (dimagi-internal/ace#1300); ' +
        'reorder the question out of the field-list rather than scrolling past it.',
    );
  }
  return leftRoom >= rightRoom
    ? Math.max(margin, Math.round(leftRoom / 2))
    : Math.min(viewport.width - margin, picker.right + Math.round(rightRoom / 2));
}
