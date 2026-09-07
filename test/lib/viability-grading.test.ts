import { describe, expect, it } from 'vitest';
import {
  FIXTURE_EXCLUDED_DIMENSIONS,
  classifyViabilityGrading,
  computeViabilityScores,
  renormalizeWeights,
} from '../../lib/viability-grading.js';

/**
 * dimagi-internal/ace#2128 — `demand_reality` is structurally unwinnable on an
 * `/ace:iterate` fixture opp, and (worse) BIMODAL, because the rubric never
 * said what a fixture's "named downstream consumer" is.
 *
 * The controls below are the REAL corpus, not invented numbers. Two runs of
 * `bednet-check-2-visit` twelve hours apart, on a byte-identical rubric row
 * (verified: `git show f6ac3b15:skills/idea-to-pdd-eval/SKILL.md` and HEAD
 * produce the same `**Demand reality**` row), scored the same fixture:
 *
 *   20260814-0856 → demand_reality 8.5 — "A named consumer with a documented,
 *     pre-committed action does exist and is sourced, not invented: ACE's
 *     /ace:iterate campaign [...] Honesty is credited here, not penalised."
 *   20260814-2019 → demand_reality 4.0 — "The source names a consumer of the
 *     FIXTURE (ACE's /ace:iterate campaign) but none of the data. [...] Not
 *     softened for a fixture: THE RUBRIC HAS NO FIXTURE BRANCH."
 *
 * A 4.5-point swing at weight 0.22 is 0.99 of composite — larger than the
 * margin between every pass and fail this opp has recorded. That is the
 * defect: not that the score is harsh, but that it is noise holding 22% of
 * the weight on the opp that IS the regression baseline.
 */

const REAL_WEIGHTS = {
  reviewer_comment_fidelity: 0.08,
  archetype_coherence: 0.08,
  numbers_consistent: 0.08,
  feasibility_headline_metrics: 0.08,
  source_conflict_honesty: 0.08,
  demand_reality: 0.22,
  resource_realism: 0.17,
  mission_alignment: 0.12,
  fallback_validates_primary: 0.09,
};

/** Verbatim per-dimension scores from `bednet-check-2-visit/20260906-2228`. */
const RUN_20260906_SCORES = {
  reviewer_comment_fidelity: 9.0,
  archetype_coherence: 8.0,
  numbers_consistent: 9.0,
  feasibility_headline_metrics: 9.5,
  source_conflict_honesty: 9.5,
  demand_reality: 4.0,
  resource_realism: 5.0,
  mission_alignment: 7.0,
  fallback_validates_primary: 5.0,
};

const FIXTURE_ROOT = ['opp.yaml', 'inputs', 'runs', 'open-questions.md', 'iterate-state.yaml'];
const REAL_ROOT = ['opp.yaml', 'inputs', 'runs', 'open-questions.md'];

describe('classifyViabilityGrading', () => {
  it('POSITIVE CONTROL: a fixture opp excludes demand_reality from the gate', () => {
    const d = classifyViabilityGrading({ oppRootNames: FIXTURE_ROOT });
    expect(d.mode).toBe('fixture-adjusted');
    expect(d.excludedFromGate).toEqual(['demand_reality']);
    expect(d.reason).toMatch(/ace#2128/);
  });

  it('NEGATIVE CONTROL: a real opp gates on all nine dimensions', () => {
    const d = classifyViabilityGrading({ oppRootNames: REAL_ROOT });
    expect(d.mode).toBe('full');
    expect(d.excludedFromGate).toEqual([]);
  });

  it('detects the fixture via the shared opp-root registry, not a hardcoded name', () => {
    // `iterate-state-legacy-*.yaml` is a registered ACE-owned variant. The
    // registry resolves it to the same label, so a legacy-suffixed campaign
    // file still marks the opp a fixture.
    const d = classifyViabilityGrading({
      oppRootNames: ['opp.yaml', 'iterate-state-legacy-20260814.yaml'],
    });
    expect(d.mode).toBe('fixture-adjusted');
  });

  it('is not fooled by a same-named file that is not at the opp root level', () => {
    const d = classifyViabilityGrading({ oppRootNames: ['opp.yaml', 'notes-about-iterate.md'] });
    expect(d.mode).toBe('full');
  });

  it('excludes demand_reality ONLY — resource_realism still gates on a fixture', () => {
    // Scope discipline: resource_realism is not structurally constant on a
    // fixture. On 20260906-2228 it scored 5.0 and caught a real defect (a
    // worker-day payment grain at daily_cap 1 paying USD 0.31-0.75/visit).
    // Dropping the whole viability axis would discard that finding.
    expect(FIXTURE_EXCLUDED_DIMENSIONS).not.toContain('resource_realism');
    expect(FIXTURE_EXCLUDED_DIMENSIONS).toHaveLength(1);
  });
});

describe('renormalizeWeights', () => {
  it('renormalized weights sum to 1.0', () => {
    const w = renormalizeWeights(REAL_WEIGHTS, ['demand_reality']);
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('preserves the RATIO between surviving dimensions (proportional, not equal-split)', () => {
    const w = renormalizeWeights(REAL_WEIGHTS, ['demand_reality']);
    // resource_realism (0.17) must stay exactly 17/12 of mission_alignment (0.12).
    expect(w.resource_realism / w.mission_alignment).toBeCloseTo(0.17 / 0.12, 10);
    // and it must NOT have become an equal share.
    expect(w.resource_realism).not.toBeCloseTo(1 / 8, 4);
  });

  it('drops the excluded dimension entirely', () => {
    const w = renormalizeWeights(REAL_WEIGHTS, ['demand_reality']);
    expect(w.demand_reality).toBeUndefined();
    expect(Object.keys(w)).toHaveLength(8);
  });

  it('throws rather than emitting a wrong denominator when everything is excluded', () => {
    expect(() => renormalizeWeights(REAL_WEIGHTS, Object.keys(REAL_WEIGHTS))).toThrow(
      /no gating mean left/,
    );
  });
});

describe('computeViabilityScores', () => {
  it('reproduces the shipped 6.62 as the unadjusted score', () => {
    // Guards the arithmetic against the real verdict file: if this drifts, the
    // helper disagrees with what the corpus already recorded.
    const full = classifyViabilityGrading({ oppRootNames: REAL_ROOT });
    const s = computeViabilityScores({ scores: RUN_20260906_SCORES, weights: REAL_WEIGHTS, decision: full });
    expect(s.overall_score).toBe(6.62);
    expect(s.overall_score_all_dimensions).toBe(6.62);
  });

  it('on a fixture, lifts 20260906-2228 over the 7.0 gate without touching any score', () => {
    const fixture = classifyViabilityGrading({ oppRootNames: FIXTURE_ROOT });
    const s = computeViabilityScores({ scores: RUN_20260906_SCORES, weights: REAL_WEIGHTS, decision: fixture });

    // The unadjusted number is preserved for cross-opp comparison...
    expect(s.overall_score_all_dimensions).toBe(6.62);
    // ...while the gating number reflects the dimensions the fixture can win.
    expect(s.overall_score).toBeGreaterThan(7.0);
    expect(s.excludedFromGate).toEqual(['demand_reality']);
  });

  it('THE REGRESSION THIS EXISTS TO PREVENT: the 8.5/4.0 judge swing no longer moves the gate', () => {
    const fixture = classifyViabilityGrading({ oppRootNames: FIXTURE_ROOT });

    // The two real gradings of the same fixture, twelve hours apart.
    const lenient = { ...RUN_20260906_SCORES, demand_reality: 8.5 };
    const strict = { ...RUN_20260906_SCORES, demand_reality: 4.0 };

    const a = computeViabilityScores({ scores: lenient, weights: REAL_WEIGHTS, decision: fixture });
    const b = computeViabilityScores({ scores: strict, weights: REAL_WEIGHTS, decision: fixture });

    // Gating score is now IDENTICAL under both readings — the ambiguity is
    // no longer able to decide pass/fail.
    expect(a.overall_score).toBe(b.overall_score);

    // But the raw score still records that the judge disagreed, so the
    // instability stays visible rather than being papered over.
    expect(a.overall_score_all_dimensions).not.toBe(b.overall_score_all_dimensions);
    expect(
      a.overall_score_all_dimensions - b.overall_score_all_dimensions,
    ).toBeCloseTo(0.22 * 4.5, 2);
  });

  it('a real opp is completely unaffected by this change', () => {
    const full = classifyViabilityGrading({ oppRootNames: REAL_ROOT });
    const lenient = { ...RUN_20260906_SCORES, demand_reality: 8.5 };
    const s = computeViabilityScores({ scores: lenient, weights: REAL_WEIGHTS, decision: full });
    // demand_reality still moves the gate on a real opp — that is the point.
    expect(s.overall_score).toBeGreaterThan(6.62);
    expect(s.overall_score).toBe(s.overall_score_all_dimensions);
  });

  it('throws on a weighted dimension with no score, rather than treating it as 0', () => {
    const full = classifyViabilityGrading({ oppRootNames: REAL_ROOT });
    const { demand_reality, ...incomplete } = RUN_20260906_SCORES;
    expect(() => computeViabilityScores({ scores: incomplete, weights: REAL_WEIGHTS, decision: full })).toThrow(
      /no score for weighted dimension "demand_reality"/,
    );
  });
});

/**
 * dimagi-internal/ace#2162 — a transposed `scores`/`weights` pair returned ONE
 * CORRECT NUMBER and one garbage number, and the correct one validated the
 * garbage one.
 *
 * `overall_score_all_dimensions` is `Σ score × weight`; multiplication
 * commutes, so a swap leaves it EXACTLY right. `overall_score` renormalizes
 * over a denominator built from the wrong record, so it is nonsense — and it
 * is the GATING number (ace#2128).
 *
 * Measured verbatim on the `20260906-2228` corpus below, before the fix:
 *
 *   computeViabilityScores(SCORES, WEIGHTS, fixture)   // correct
 *     → { overall_score: 7.36, overall_score_all_dimensions: 6.62 }
 *   computeViabilityScores(WEIGHTS, SCORES, fixture)   // ARGS SWAPPED
 *     → { overall_score: 0.09, overall_score_all_dimensions: 6.62 }
 *
 * Same 6.62 either side; the gate moved 7.36 → 0.09, i.e. across the 7.0 gate.
 *
 * The function has NO code caller — an LLM hand-writes the call from
 * `skills/idea-to-pdd-eval/SKILL.md` prose, the one caller class that gets no
 * compiler help. So the class is closed twice over, and both halves are
 * pinned here.
 */
describe('computeViabilityScores: the scores/weights transposition is structurally impossible', () => {
  it('DEFENCE 1 (static): the old positional call no longer typechecks', () => {
    const fixture = classifyViabilityGrading({ oppRootNames: FIXTURE_ROOT });

    // @ts-expect-error — ace#2162: `(scores, weights, decision)` is exactly the
    // shape that let the two structurally-identical records be transposed. If
    // anyone reverts to a positional signature this directive goes unused and
    // `tsc --noEmit` fails the build ("Unused '@ts-expect-error' directive"),
    // which is the point: CI type-checks test/**, vitest does not.
    expect(() => computeViabilityScores(RUN_20260906_SCORES, REAL_WEIGHTS, fixture)).toThrow();
  });

  it('DEFENCE 2 (runtime): a swap INSIDE the object literal throws instead of scoring', () => {
    const fixture = classifyViabilityGrading({ oppRootNames: FIXTURE_ROOT });

    // The object param kills the positional swap, but `scores` and `weights`
    // are still the same TYPE, so transposing the two values inside the
    // literal still typechecks. That is the remaining hole, and this is what
    // plugs it: nine judge scores on a 0-10 scale cannot sum to 1.0.
    expect(() =>
      computeViabilityScores({
        scores: REAL_WEIGHTS,
        weights: RUN_20260906_SCORES,
        decision: fixture,
      }),
    ).toThrow(/weights must sum to 1\.0/);
  });

  it('names the transposition in the error, because that is what it almost always is', () => {
    const fixture = classifyViabilityGrading({ oppRootNames: FIXTURE_ROOT });
    expect(() =>
      computeViabilityScores({
        scores: REAL_WEIGHTS,
        weights: RUN_20260906_SCORES,
        decision: fixture,
      }),
    ).toThrow(/transposed/);
  });

  it('THE MEASURED REGRESSION: the swap used to return a CORRECT-LOOKING all-dimensions score', () => {
    const fixture = classifyViabilityGrading({ oppRootNames: FIXTURE_ROOT });

    // The correct call is unchanged by this fix — 7.36 / 6.62, verbatim.
    const correct = computeViabilityScores({
      scores: RUN_20260906_SCORES,
      weights: REAL_WEIGHTS,
      decision: fixture,
    });
    expect(correct.overall_score).toBe(7.36);
    expect(correct.overall_score_all_dimensions).toBe(6.62);

    // And this is why the swap was so dangerous: recomputing the commuting
    // half by hand off the SWAPPED pair reproduces 6.62 exactly. A reviewer
    // sanity-checking that number would have confirmed a verdict whose gating
    // score was 0.09.
    const commutingHalf =
      Object.entries(RUN_20260906_SCORES).reduce(
        (sum, [dim, score]) => sum + score * REAL_WEIGHTS[dim as keyof typeof REAL_WEIGHTS],
        0,
      );
    expect(Math.round(commutingHalf * 100) / 100).toBe(6.62);
  });

  it('rejects a weight set that does not sum to 1.0 even when nothing was transposed', () => {
    const full = classifyViabilityGrading({ oppRootNames: REAL_ROOT });
    // 0.13.84 had to go back and fix a weight-sum bug once; this is the guard
    // that would have caught it, independent of the transposition class.
    const dropped = { ...REAL_WEIGHTS, demand_reality: 0.02 };
    expect(() =>
      computeViabilityScores({ scores: RUN_20260906_SCORES, weights: dropped, decision: full }),
    ).toThrow(/weights must sum to 1\.0, got 0\.8/);
  });

  it('tolerates float noise in a legitimately-1.0 weight set', () => {
    const full = classifyViabilityGrading({ oppRootNames: REAL_ROOT });
    const noisy = { ...REAL_WEIGHTS, fallback_validates_primary: 0.09 + 0.0005 };
    expect(() =>
      computeViabilityScores({ scores: RUN_20260906_SCORES, weights: noisy, decision: full }),
    ).not.toThrow();
  });
});
