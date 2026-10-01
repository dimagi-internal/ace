/**
 * `lib/frame-pixels.ts` — what is ON a captured phone frame.
 *
 * Every input here is a REAL capture from spark-facilitator/20260925-1536
 * (the frames its fork 20260926-1800's training deck placed or could have
 * placed), scaled to the 270x600 sampling grid and palette-quantised so the
 * fixtures stay small: `test/fixtures/training-deck/spark-20260926-1800/frames/`.
 * The full-resolution measurements of all 101 frames the binder considers are
 * in `frame-stats.json` beside them (written by `scripts/bind-deck-frames.ts
 * --stats-out` against the live run, 2026-10-01); the cases below assert the
 * fixtures and the full-size frames agree, so a threshold tuned on one cannot
 * silently mean something else on the other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, measureFrame, NEAR_EMPTY_INK, KEYBOARD_COVERS } from '../../lib/frame-pixels';

const FIX = join(__dirname, '../fixtures/training-deck/spark-20260926-1800');
const frame = (name: string) => measureFrame(decodePng(new Uint8Array(readFileSync(join(FIX, 'frames', `${name}.png`)))));
const fullStats = JSON.parse(readFileSync(join(FIX, 'frame-stats.json'), 'utf8')) as Record<
  string,
  { inkRowFraction: number; keyboardFraction: number; width: number; height: number }
>;

describe('decodePng', () => {
  it('decodes a palette PNG to the size it says', () => {
    const r = decodePng(new Uint8Array(readFileSync(join(FIX, 'frames', 'learn-install.png'))));
    expect([r.width, r.height]).toEqual([270, 600]);
    expect(r.rgb.length).toBe(270 * 600 * 3);
  });

  it('refuses bytes that are not a PNG', () => {
    expect(() => decodePng(new Uint8Array(readFileSync(join(FIX, 'run_state.yaml'))))).toThrow(/not a PNG/);
  });
});

describe('near-empty — the frame the eval called "an almost empty blue Downloading Learn App screen" (slide 10)', () => {
  it('learn-install measures below the floor', () => {
    expect(frame('learn-install').inkRowFraction).toBeLessThan(NEAR_EMPTY_INK);
    // …and so does the full-size capture the deck actually placed.
    expect(fullStats['1pHd6Ixz5xVuQmai9vfTgNfnbaSu1gZqo'].inkRowFraction).toBeLessThan(NEAR_EMPTY_INK);
  });

  it('a sparse but REAL screen is not near-empty (three lines of text, slide 28)', () => {
    // The eval scored this 3 (thin), not 1: it says exactly what the slide
    // teaches. A floor that caught it would drop a teaching slide.
    expect(frame('journey-deliver-step-display').inkRowFraction).toBeGreaterThanOrEqual(NEAR_EMPTY_INK);
  });

  it('only two of the 101 full-size frames are below the floor', () => {
    // learn-install (the loading screen) and journey-deliver-enrol-submitted —
    // a two-row facilitator picker on an otherwise blank grey screen, the
    // landing after a submit. Every form, quiz and lesson list is above it.
    const below = Object.entries(fullStats)
      .filter(([, s]) => s.inkRowFraction < NEAR_EMPTY_INK)
      .map(([id]) => id)
      .sort();
    expect(below).toEqual(['1ZJDKdDBrHywaLrToATM6qJtOdmOJeoeb', '1pHd6Ixz5xVuQmai9vfTgNfnbaSu1gZqo']);
  });
});

describe('keyboard — "keyboard occupies half the screenshot" (slides 6 and 32)', () => {
  it('detects the soft keyboard on both frames that carry one', () => {
    expect(frame('journey-deliver-notes-last-item').keyboardFraction).toBeGreaterThanOrEqual(KEYBOARD_COVERS);
    expect(frame('personal-id-name').keyboardFraction).toBeGreaterThanOrEqual(KEYBOARD_COVERS);
  });

  it('does NOT read a form, a tile grid, a list of cards or a lesson list as a keyboard', () => {
    for (const name of [
      'journey-deliver-who-came',
      'learn-launch-suite-root',
      'claim-opp-handoff-learn-home',
      'learn-tap-module-after-Recording a meeting',
      'personal-id-phone',
      'commcare-welcome',
    ]) {
      expect(frame(name).keyboardFraction, name).toBe(0);
    }
  });

  it('across all 101 full-size frames, exactly the two keyboard frames are flagged', () => {
    // claim-opp-list stacks four cards, each with two pill buttons and a
    // progress ring — three flat runs per row, four times, bottom-anchored. The
    // first cut of the detector called it a keyboard; this pins that it is not.
    const flagged = Object.entries(fullStats)
      .filter(([, s]) => s.keyboardFraction >= KEYBOARD_COVERS)
      .map(([id]) => id)
      .sort();
    expect(flagged).toEqual(['1-DIPQ0iCrFzwrifjfweuxBG_ffb9TbaV', '1oujk0rkrnS7CX0SP_gu76CrgyMnm3IX5']);
  });
});
