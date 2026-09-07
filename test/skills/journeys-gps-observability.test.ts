import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ace#1619 — the journeys producer/eval pair must not demand a GPS capture-gate.
 *
 * `_app-component-library.md` Table A closes Connect-side enforcement of a GPS
 * accuracy radius, and `idea-to-pdd § Step 4a` (ace#1006) FORBIDS the PDD from
 * asserting it. `pdd-to-deliver-app-eval § Capture fitness` was corrected on
 * 2026-07-28 to neither credit nor deduct it. The journeys pair was missed, so
 * for five weeks Phase 2 authored journeys demanding a rejection no build can
 * perform, `app-test-cases` compiled them into negative-path recipes that
 * cannot pass, and the 25%-weight, carve-out-EXEMPT `deployability_fitness`
 * dimension docked the honest absence to 6.0-7.0.
 *
 * This pins the corrected contract on BOTH files, because a one-sided fix is
 * how the drift happened: the grader stops demanding the gate while the
 * producer keeps modelling the forbidden phrasing, and the next journey set
 * still ships it.
 *
 * It also pins the OPPOSITE error. An in-form gate via an adjacent constrained
 * question is ACE *policy*-closed, not platform-closed, so neither file may say
 * enforcement is impossible — over-claiming a platform limit is the failure
 * ace#1213 was reopened for, and it outlives the constraint.
 */

const REPO = join(__dirname, '..', '..');
const PRODUCER = readFileSync(join(REPO, 'skills', 'pdd-to-app-journeys', 'SKILL.md'), 'utf8');
const EVAL = readFileSync(join(REPO, 'skills', 'pdd-to-app-journeys-eval', 'SKILL.md'), 'utf8');
const DELIVER_EVAL = readFileSync(
  join(REPO, 'skills', 'pdd-to-deliver-app-eval', 'SKILL.md'),
  'utf8',
);

/**
 * Everything ABOVE the Change Log. The negative assertions run here only: a
 * Change Log row legitimately QUOTES the retired wording in order to say it is
 * retired, and a test that forbade the quote would force the history to be
 * written vaguely — which is how the 2026-07-28 deliver-app correction became
 * invisible to whoever should have propagated it.
 */
function body(source: string): string {
  const i = source.search(/^##+\s+Change Log/im);
  return i === -1 ? source : source.slice(0, i);
}

const PAIR = [
  ['pdd-to-app-journeys', PRODUCER],
  ['pdd-to-app-journeys-eval', EVAL],
] as const;

describe('the journeys pair grades GPS accuracy as observability, not enforcement', () => {
  it('neither file demands that a low-accuracy fix be REJECTED', () => {
    // The two exact phrasings that shipped, plus the rubric verb. A journey set
    // cannot satisfy any of them, so demanding one makes the dimension
    // ungradable rather than strict.
    for (const [name, source] of PAIR) {
      expect(body(source), `${name} must not demand rejection of a low-accuracy fix`).not.toMatch(
        /low-accuracy GPS fix where a radius is\s+specified/i,
      );
      expect(body(source), `${name} must not model "GPS capture is rejected"`).not.toMatch(
        /GPS capture is rejected/i,
      );
      expect(body(source), `${name} must not demand journeys "reject low-accuracy fixes"`).not.toMatch(
        /reject low-accuracy fixes/i,
      );
    }
  });

  it('both files carry the observability contract instead', () => {
    // Removing the demand without replacing it would silently drop the axis:
    // "capture location" alone is exactly the thin behaviour the dimension
    // exists to catch.
    for (const [name, source] of PAIR) {
      expect(source, `${name} must require the accuracy value be submitted`).toMatch(
        /gps_accuracy_m|accuracy is shown to the\s+FLW and submitted/i,
      );
      expect(source, `${name} must require an on-screen advisory`).toMatch(/advisory/i);
    }
  });

  it('the eval neither credits nor deducts the unbuildable gate, and cites why', () => {
    expect(EVAL).toMatch(/do NOT credit — and do NOT deduct/i);
    expect(EVAL).toMatch(/ace#1006/);
    expect(EVAL).toMatch(/ace#1013/);
    // The mid-band example is the specific text that produced the 7.0 score.
    expect(body(EVAL), 'the mid-band gap example must not be the missing gate').not.toMatch(
      /never gates on accuracy/i,
    );
  });

  it('neither file claims enforcement is impossible — Table A calls it policy-closed', () => {
    for (const [name, source] of PAIR) {
      expect(body(source), `${name} must not call an in-form accuracy gate impossible`).not.toMatch(
        /accuracy[^.\n]{0,60}\bis impossible\b/i,
      );
    }
    expect(EVAL, 'the eval must name the policy-vs-platform distinction').toMatch(
      /policy\*?\*?-closed, not platform-closed/i,
    );
  });

  it('both files point at the section that enumerates the closed mechanisms', () => {
    // The pointer test/skills/pdd-must-not-assert-mechanisms.test.ts already
    // requires of idea-to-pdd and its eval, and never required here — which is
    // how a Table A mechanism reached a 25% rubric anchor unchallenged.
    for (const [name, source] of PAIR) {
      expect(source, `${name}/SKILL.md must reference the must-not-assert section`).toMatch(
        /Mechanisms a PDD\s+must not assert/i,
      );
    }
  });

  it('stays aligned with the sibling rubric that was corrected first', () => {
    // pdd-to-deliver-app-eval received this correction on 2026-07-28. If that
    // wording is ever revisited, this pair must move with it rather than drift
    // apart again — which is the whole defect ace#1619 records.
    expect(DELIVER_EVAL).toMatch(/do NOT credit — and do NOT deduct/i);
    expect(DELIVER_EVAL).toMatch(/unbuildable on both surfaces/i);
  });
});
