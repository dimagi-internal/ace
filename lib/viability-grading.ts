/**
 * Which `idea-to-pdd-eval` viability dimensions may be scored into the GATING
 * mean, and which are structurally unwinnable for the opp being graded.
 *
 * dimagi-internal/ace#2128.
 *
 * ## The defect
 *
 * `demand_reality` (weight 0.22) asks: is there a NAMED downstream consumer of
 * this programme's output, with a documented commitment to act on it? Its 4.0
 * anchor is "no named consumer; data collection in search of a buyer".
 *
 * On an `/ace:iterate` FIXTURE opp there is never a named consumer, and there
 * must never be one. The fixture's whole purpose is to be a disposable
 * regression baseline; `skills/idea-to-pdd` is under a standing
 * `no-inferred-backstory` rule (docs/learnings/2026-05-12-no-inferred-backstory.md)
 * that forbids inventing a partner org to satisfy a rubric. So Phase 1 is
 * docked 22% of the composite for OBEYING that rule, on every run, forever.
 *
 * Measured on `bednet-check-2-visit/20260906-2228`: five document-quality
 * dimensions averaged 9.0, `demand_reality` scored 4.0, and the composite
 * landed at 6.62 against a 7.0 gate. The judge's own note said the quiet part
 * out loud — the PDD's refusal to name a consumer "is the correct behaviour
 * and would have scored WORSE had it fabricated one."
 *
 * A dimension that returns the same value for every possible artifact carries
 * ZERO information while holding 22% of the weight. That does not merely
 * mis-score one run: it breaks the instrument. This opp IS the `/ace:iterate`
 * regression baseline, so a permanently-red eval on it cannot detect the
 * regression it exists to detect.
 *
 * ## The fix, and its deliberate limits
 *
 * The precedent is ace#1487, which gave Phase 1's *input* a fixture branch.
 * Nothing gave the *grading* one. This module is that branch, in the same
 * shape: pure, no I/O, so the rubric prose and the tests bind to one rule
 * rather than two prose copies that drift.
 *
 * Three properties, each chosen against a way this could go wrong:
 *
 *  1. **`demand_reality` is still SCORED and still REPORTED.** It is excluded
 *     from the gating mean, not from the verdict. Dropping it outright would
 *     hide the one case where it is informative — a fixture brief that
 *     genuinely regressed on demand framing.
 *  2. **BOTH scores are emitted.** `overall_score` (fixture-adjusted, gates)
 *     and `overall_score_all_dimensions` (raw, all nine). The raw number keeps
 *     cross-opp comparison honest and makes the adjustment auditable rather
 *     than silent.
 *  3. **The exclusion is MINIMAL — `demand_reality` only.** `resource_realism`
 *     stays in the gating mean on fixtures. It is NOT structurally constant:
 *     on the run that motivated this module it scored 5.0 and caught a real
 *     defect (a worker-day payment grain at `daily_cap 1` paying USD 0.31-0.75
 *     per completed visit). Excluding the whole viability axis because one
 *     dimension is unwinnable would throw away the finding that made this
 *     worth fixing.
 */

import { isIterateFixtureOpp } from './opp-root-files.js';

/**
 * Dimensions excluded from the GATING mean on a fixture opp.
 *
 * Deliberately a one-element list. Every future addition needs its own
 * argument that the dimension is *structurally constant* on a fixture — not
 * merely that it scores low there. A dimension that scores low because the
 * fixture has a real defect is the instrument working.
 */
export const FIXTURE_EXCLUDED_DIMENSIONS: readonly string[] = ['demand_reality'];

export type ViabilityGradingMode = 'full' | 'fixture-adjusted';

export interface ViabilityGradingDecision {
  mode: ViabilityGradingMode;
  /** Dimensions to score and report, but leave OUT of the gating weighted mean. */
  excludedFromGate: string[];
  /** One sentence the eval can paste into its verdict and the pause summary. */
  reason: string;
}

export interface DimensionWeights {
  [dimension: string]: number;
}

export interface DimensionScores {
  [dimension: string]: number;
}

/**
 * Decide how `idea-to-pdd-eval` grades this opp's viability axis.
 *
 *   (a) fixture opp (an `iterate-state.yaml` at the opp root)
 *         → `fixture-adjusted`: score every dimension, gate on all but
 *           `demand_reality`.
 *   (b) otherwise → `full`: gate on all nine, unchanged.
 */
export function classifyViabilityGrading(input: {
  oppRootNames: string[];
}): ViabilityGradingDecision {
  if (isIterateFixtureOpp(input.oppRootNames)) {
    return {
      mode: 'fixture-adjusted',
      excludedFromGate: [...FIXTURE_EXCLUDED_DIMENSIONS],
      reason:
        'Fixture opp (iterate-state.yaml at the opp root): `demand_reality` is scored and ' +
        'reported but EXCLUDED from the gating mean, because a regression fixture has no ' +
        'named downstream consumer and must not invent one — the dimension is constant at ' +
        'its 4.0 anchor for every possible artifact, so it carries no information while ' +
        'holding 22% of the weight (dimagi-internal/ace#2128). `overall_score_all_dimensions` ' +
        'carries the unadjusted number.',
    };
  }

  return {
    mode: 'full',
    excludedFromGate: [],
    reason:
      'Real opp: the full nine-dimension rubric gates, `demand_reality` included ' +
      '(dimagi-internal/ace#2128).',
  };
}

/**
 * Renormalize `weights` after removing `excluded`, preserving the RATIO between
 * the dimensions that remain.
 *
 * Proportional redistribution rather than equal-split: the surviving weights
 * encode a considered judgement about their relative importance (0.13.84 and
 * 0.13.88 both rebalanced them deliberately), and an equal split would silently
 * discard that.
 *
 * Returns weights summing to 1.0. Throws if that is impossible, rather than
 * emitting a mean whose denominator is wrong — a weight-sum bug is exactly what
 * 0.13.84 had to go back and fix.
 */
export function renormalizeWeights(
  weights: DimensionWeights,
  excluded: readonly string[],
): DimensionWeights {
  const kept = Object.entries(weights).filter(([dim]) => !excluded.includes(dim));

  if (kept.length === 0) {
    throw new Error(
      'renormalizeWeights: every dimension was excluded — there is no gating mean left to compute.',
    );
  }

  const keptTotal = kept.reduce((sum, [, w]) => sum + w, 0);
  if (keptTotal <= 0) {
    throw new Error(
      `renormalizeWeights: surviving weights sum to ${keptTotal}, cannot renormalize.`,
    );
  }

  const out: DimensionWeights = {};
  for (const [dim, w] of kept) {
    out[dim] = w / keptTotal;
  }
  return out;
}

export interface ViabilityScores {
  /** The GATING score — fixture-adjusted when the opp is a fixture. */
  overall_score: number;
  /** Every dimension, unadjusted. Equal to `overall_score` on a real opp. */
  overall_score_all_dimensions: number;
  mode: ViabilityGradingMode;
  excludedFromGate: string[];
}

/** Tolerance on the `weights` sum. Generous enough for float noise in a 2dp rubric. */
const WEIGHT_SUM_TOLERANCE = 0.001;

export interface ComputeViabilityScoresInput {
  /** Per-dimension judge scores, 0–10. */
  scores: DimensionScores;
  /** Per-dimension rubric weights. MUST sum to 1.0. */
  weights: DimensionWeights;
  decision: ViabilityGradingDecision;
}

/**
 * Compute both the gating and the unadjusted composite from per-dimension
 * scores and weights.
 *
 * Rounded to 2dp to match what the verdict files already carry, so a verdict
 * written from this helper is byte-comparable with the hand-computed ones in
 * the existing corpus.
 *
 * ## Why one object param and not `(scores, weights, decision)` — ace#2162
 *
 * `DimensionScores` and `DimensionWeights` are the SAME structural type
 * (`{[k: string]: number}`), so two adjacent positional params of those types
 * are freely transposable and TypeScript cannot see it. That would be merely
 * annoying if a swap failed loudly. It does not: `overall_score_all_dimensions`
 * is `Σ score × weight` and multiplication commutes, so a swapped call returns
 * that number **exactly right** while `overall_score` — which renormalizes over
 * a denominator built from the wrong record — returns nonsense. One correct
 * number validating one garbage number, and `overall_score` is the GATING one
 * (ace#2128).
 *
 * Measured on the `bednet-check-2-visit` 20260906-2228 corpus:
 *   correct → { overall_score: 7.36, overall_score_all_dimensions: 6.62 }
 *   swapped → { overall_score: 0.09, overall_score_all_dimensions: 6.62 }
 * i.e. the same all-dimensions score either side of a gating number that
 * crossed the 7.0 gate.
 *
 * There is no code caller: this function is invoked by an LLM hand-writing the
 * call from `skills/idea-to-pdd-eval/SKILL.md` prose — the one caller class
 * that gets no compiler help at all. So it gets TWO defences, because either
 * alone is defeatable:
 *
 *  1. **The named object param** kills the positional transposition outright —
 *     a two-arg call no longer typechecks.
 *  2. **The weight-sum assertion below** kills the remaining case, where the
 *     two values are transposed *inside* the object literal (`{ scores: w,
 *     weights: s }`) — which still typechecks, because the types are still
 *     identical. Scores are 0–10 and nine of them sum nowhere near 1.0, so a
 *     transposed payload is caught by arithmetic that has to hold anyway.
 */
export function computeViabilityScores(input: ComputeViabilityScoresInput): ViabilityScores {
  const { scores, weights, decision } = input;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const weightSum = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(
      `computeViabilityScores: weights must sum to 1.0, got ${round2(weightSum)} over ` +
        `${Object.keys(weights).length} dimension(s). A sum far from 1.0 usually means ` +
        '`scores` and `weights` were transposed — scores are 0-10 (ace#2162).',
    );
  }

  const weightedMean = (w: DimensionWeights) =>
    Object.entries(w).reduce((sum, [dim, weight]) => {
      const score = scores[dim];
      if (score === undefined) {
        throw new Error(`computeViabilityScores: no score for weighted dimension "${dim}".`);
      }
      return sum + score * weight;
    }, 0);

  const all = weightedMean(weights);
  const gating =
    decision.excludedFromGate.length === 0
      ? all
      : weightedMean(renormalizeWeights(weights, decision.excludedFromGate));

  return {
    overall_score: round2(gating),
    overall_score_all_dimensions: round2(all),
    mode: decision.mode,
    excludedFromGate: [...decision.excludedFromGate],
  };
}
