/**
 * Static QA checks for `verdict-yaml-qa`.
 *
 * Validates a verdict YAML written by any `-eval` skill against
 * `lib/verdict-schema.ts` plus a small set of cross-field invariants
 * (weighted-mean consistency, verdict-tier ranges, gate disposition,
 * `live_state_verified` cap behavior) that the Zod schema can't express.
 *
 * Imported by:
 * - The skill body via `scripts/qa-run.ts` at runtime (orchestrator dispatch
 *   when `opp-eval` ingests verdicts, or per-eval inline self-check).
 * - Per-skill tests under `test/skills/verdict-yaml-qa/` (vitest).
 *
 * The `CHECKS` array is the canonical ordering — both runtime and tests
 * iterate it. Add a check by appending to the array; surface in the
 * SKILL.md `## Checks` table simultaneously.
 *
 * Companion to the `validateVerdict` helper in `lib/verdict-schema.ts`.
 * `validateVerdict` returns a single ok/errors blob; this skill splits the
 * concerns into per-check failures with specific `auto_fix_hint`s the
 * orchestrator can pass back to the producing `-eval` skill.
 */

import { parse as parseYaml } from 'yaml';

import type { QACheck, QACheckResult } from '../../lib/qa-types';
import { VerdictSchema, type Verdict } from '../../lib/verdict-schema';

// ── Tolerance constants ────────────────────────────────────────────

/**
 * Tolerance for `dimensions[].weight` summing to 1.0.
 *
 * Mirrors `lib/verdict-schema.ts § validateVerdict`. Allows for float
 * accumulation drift across N dimensions but catches genuinely off-by
 * cases (0.95, 1.05, etc.) that signal a real misweighting.
 */
const WEIGHT_SUM_TOLERANCE = 0.01;

/**
 * Tolerance for `overall_score` matching the dimensional weighted mean.
 *
 * Looser than the weight-sum tolerance because `overall_score` may have
 * been rounded to 1 decimal place after the weighted-mean computation,
 * and several rubrics declare hard-deduct rules that adjust the raw mean.
 * The QA's job is to catch *gross* misalignment (mean=8.5 with overall=4.2),
 * not float-precision drift.
 */
const OVERALL_SCORE_TOLERANCE = 0.5;

/**
 * `live_state_verified: false` caps the verdict at `partial` and the score
 * at this value (per `lib/verdict-schema.ts § VerdictDispositionSchema` /
 * the rubric's documented partial-tier behavior).
 */
const LIVE_STATE_PARTIAL_CAP = 8.5;

// ── Verdict-tier ranges ────────────────────────────────────────────

/**
 * Score → expected verdict tier mapping.
 *
 * Mirrored from `skills/README.md § Verdict YAML shape § Disposition
 * tiers` and the boilerplate at the bottom of every `-eval` SKILL.md.
 *
 * Tiers `incomplete` and `partial` are NOT score-driven (they signal
 * gradability gaps, not dimensional results), so they're skipped by
 * the verdict-tier-vs-score consistency check.
 */
const VERDICT_TIER_RANGES = {
  pass: { min: 7.0, max: 10.0 },
  warn: { min: 5.0, max: 7.0 }, // exclusive upper bound — a 7.0 lands in pass
  fail: { min: 0.0, max: 5.0 }, // exclusive upper bound — a 5.0 lands in warn
} as const;

// ── Parse helper ───────────────────────────────────────────────────

interface ParseOk {
  ok: true;
  parsed: unknown;
}
interface ParseErr {
  ok: false;
  error: string;
}
type ParseResult = ParseOk | ParseErr;

function tryParseYaml(artifact: string): ParseResult {
  try {
    const parsed = parseYaml(artifact);
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Returned when a check's prerequisite (typically YAML parsing or schema
 * validation) didn't hold. Marking the check as `pass: true` with a
 * `skipped: ...` detail keeps the failure singular — the orchestrator
 * fixes the parse / schema issue first, and downstream checks rerun.
 */
function skipped(reason: string): QACheckResult {
  return { pass: true, detail: `skipped: ${reason}` };
}

function safeVerdict(artifact: string): Verdict | null {
  const parse = tryParseYaml(artifact);
  if (!parse.ok) return null;
  const result = VerdictSchema.safeParse(parse.parsed);
  return result.success ? result.data : null;
}

// ── Checks ─────────────────────────────────────────────────────────

/**
 * Check 1: The verdict file is parseable YAML.
 *
 * If parsing fails here, every subsequent check returns `skipped` so the
 * orchestrator's auto-fix loop sees a single actionable failure (fix the
 * YAML) rather than an avalanche of consequence-failures.
 */
export function checkYamlParses(artifact: string): QACheckResult {
  const parse = tryParseYaml(artifact);
  if (parse.ok) return { pass: true };
  return {
    pass: false,
    detail: `YAML parse error: ${parse.error}`,
    auto_fix_hint:
      'fix the YAML syntax error reported above and re-emit the verdict file. ' +
      'Common causes: unquoted strings containing colons, inconsistent indentation, ' +
      'missing closing quote on multi-line values.',
  };
}

/**
 * Check 2: The parsed verdict matches `lib/verdict-schema.ts § VerdictSchema`.
 *
 * Surfaces all Zod schema errors as a single failure — typed enums (verdict,
 * mode, severity), required fields (skill, target, ran_at, capture_path,
 * overall_score, verdict, dimensions), per-field range constraints
 * (overall_score in 0-10, weight in 0-1, score in 0-10 or null).
 *
 * Cross-field invariants (weight-sum, score-vs-mean, verdict-vs-score,
 * gate-disposition, live-state-cap) are split into their own checks below
 * so each failure carries a specific `auto_fix_hint`.
 */
export function checkSchemaValidates(artifact: string): QACheckResult {
  const parse = tryParseYaml(artifact);
  if (!parse.ok) return skipped('YAML did not parse (see yaml_parses)');

  const result = VerdictSchema.safeParse(parse.parsed);
  if (result.success) return { pass: true };

  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return {
    pass: false,
    detail: `verdict YAML fails schema: ${issues}`,
    auto_fix_hint:
      'fix the listed schema violations. Reference: lib/verdict-schema.ts § VerdictSchema. ' +
      'Common causes: missing required field (skill / target / ran_at / capture_path / overall_score / verdict / dimensions), ' +
      'verdict not in {pass, warn, fail, incomplete, partial}, severity not in {BLOCKER, WARN, INFO, PLATFORM, DRIFT, INFO-SKIPPED}, ' +
      'overall_score out of 0-10 range, dimension weight out of 0-1 range.',
  };
}

/**
 * Check 3: `dimensions[].weight` values sum to 1.0 (± WEIGHT_SUM_TOLERANCE).
 *
 * The aggregator (`opp-eval`) renormalizes when summing across skills, but
 * a verdict that doesn't sum to 1.0 standalone is malformed — the rubric
 * itself was misweighted. Specific auto_fix_hint so the producing eval can
 * redistribute rather than guess what's wrong.
 */
export function checkDimensionWeightsSumToOne(artifact: string): QACheckResult {
  const verdict = safeVerdict(artifact);
  if (!verdict) return skipped('verdict failed yaml_parses or schema_validates');

  const weights = Object.entries(verdict.dimensions);
  if (weights.length === 0) {
    return {
      pass: false,
      detail: 'no dimensions in verdict',
      auto_fix_hint:
        'a verdict must declare at least one rubric dimension. Re-emit with the rubric ' +
        'dimensions from the eval skill\'s SKILL.md § LLM-as-Judge Rubric.',
    };
  }
  const sum = weights.reduce((acc, [, d]) => acc + d.weight, 0);
  if (Math.abs(sum - 1.0) <= WEIGHT_SUM_TOLERANCE) return { pass: true };

  const drift = (sum - 1.0).toFixed(3);
  const breakdown = weights.map(([k, d]) => `${k}=${d.weight}`).join(', ');
  return {
    pass: false,
    detail: `dimensions weights sum to ${sum.toFixed(3)} (drift ${drift}); expected 1.0. Weights: ${breakdown}`,
    auto_fix_hint:
      `redistribute weights so they sum to 1.0 ± ${WEIGHT_SUM_TOLERANCE}. ` +
      'Reference the eval skill\'s SKILL.md § LLM-as-Judge Rubric for the canonical weight table; ' +
      'if the SKILL.md is the source of drift, fix it there first then re-grade.',
  };
}

/**
 * Check 4: `overall_score` is consistent with the dimensional weighted mean.
 *
 * The weighted mean is `Σ(dim.score * dim.weight) / Σ(dim.weight)` over
 * dimensions where `score` is non-null. Comparing against `overall_score`
 * directly would falsely fail when a rubric applied an inflation cap; the
 * spec says rubrics with caps emit `overall_score_pre_cap` for the raw
 * mean and `overall_score` for the post-cap value. So:
 *
 *   - If `overall_score_pre_cap` is present, compare it against the mean.
 *   - Otherwise, compare `overall_score` against the mean.
 *
 * Tolerance is generous (OVERALL_SCORE_TOLERANCE = 0.5) because rubrics
 * routinely round and may apply small per-dimension hard-deducts before
 * the overall is computed. The QA is catching gross misalignment.
 */
export function checkOverallScoreConsistentWithDimensions(artifact: string): QACheckResult {
  const verdict = safeVerdict(artifact);
  if (!verdict) return skipped('verdict failed yaml_parses or schema_validates');

  const dims = Object.entries(verdict.dimensions);
  const scored = dims.filter(([, d]) => d.score !== null);
  if (scored.length === 0) {
    // All dimensions null — typical for `incomplete` verdicts. No mean to check.
    return { pass: true, detail: 'all dimensions are null (incomplete verdict)' };
  }
  const totalWeight = scored.reduce((acc, [, d]) => acc + d.weight, 0);
  if (totalWeight === 0) return skipped('all scored dimensions have weight 0');

  const weightedSum = scored.reduce((acc, [, d]) => acc + (d.score as number) * d.weight, 0);
  const computedMean = weightedSum / totalWeight;

  const candidate = verdict.overall_score_pre_cap ?? verdict.overall_score;
  if (Math.abs(candidate - computedMean) <= OVERALL_SCORE_TOLERANCE) return { pass: true };

  const drift = (candidate - computedMean).toFixed(2);
  const which = verdict.overall_score_pre_cap !== undefined
    ? 'overall_score_pre_cap'
    : 'overall_score';
  return {
    pass: false,
    detail:
      `${which}=${candidate} but weighted mean of scored dimensions = ${computedMean.toFixed(2)} ` +
      `(drift ${drift}; tolerance ±${OVERALL_SCORE_TOLERANCE}).`,
    auto_fix_hint:
      'recompute overall_score (and overall_score_pre_cap if you applied a cap) from the ' +
      'dimensional weighted mean. If the rubric DID apply a cap, set overall_score_pre_cap to the ' +
      'raw mean and overall_score to the capped value — this QA expects pre_cap when present.',
  };
}

/**
 * Check 5: Verdict tier matches the score range.
 *
 * - `pass`: overall_score ≥ 7.0
 * - `warn`: 5.0 ≤ overall_score < 7.0
 * - `fail`: overall_score < 5.0
 * - `incomplete` / `partial`: skipped (gradability tiers, not score-driven)
 *
 * Catches the common drift where a rubric updates the score but forgets to
 * update the verdict (or vice versa).
 */
export function checkVerdictTierMatchesScore(artifact: string): QACheckResult {
  const verdict = safeVerdict(artifact);
  if (!verdict) return skipped('verdict failed yaml_parses or schema_validates');

  if (verdict.verdict === 'incomplete' || verdict.verdict === 'partial') {
    return { pass: true, detail: `verdict tier '${verdict.verdict}' is not score-driven` };
  }
  const range = VERDICT_TIER_RANGES[verdict.verdict];
  const score = verdict.overall_score;
  // pass uses inclusive upper at the 10 end; warn/fail use exclusive upper bounds
  // (a score of 7.0 lands in pass, a 5.0 lands in warn — see the constant).
  const inRange = verdict.verdict === 'pass'
    ? score >= range.min && score <= range.max
    : score >= range.min && score < range.max;
  if (inRange) return { pass: true };

  // Compute the verdict tier the score actually maps to for a hint.
  const expected = score >= 7.0 ? 'pass' : score >= 5.0 ? 'warn' : 'fail';
  return {
    pass: false,
    detail: `verdict='${verdict.verdict}' but overall_score=${score} maps to tier '${expected}'.`,
    auto_fix_hint:
      `align verdict and overall_score: either set verdict='${expected}' to match the score, ` +
      'or re-grade dimensions to land overall_score in the correct range. Reference: ' +
      'skills/README.md § Disposition tiers (pass ≥7.0, warn 5.0-7.0, fail <5.0).',
  };
}

/**
 * Check 6: `live_state_verified: false` requires verdict ≤ `partial` and
 * overall_score ≤ LIVE_STATE_PARTIAL_CAP (8.5).
 *
 * Per `lib/verdict-schema.ts § live_state_verified`: "When `false` *and*
 * the artifact is non-degraded, the verdict tier should be capped at
 * `partial` (≤8.5)." This QA catches rubrics that ignored the cap.
 *
 * If `live_state_verified` is omitted (rubric had no live-probe step),
 * the check passes — many rubrics legitimately don't probe live state.
 */
export function checkLiveStateVerifiedConsistency(artifact: string): QACheckResult {
  const verdict = safeVerdict(artifact);
  if (!verdict) return skipped('verdict failed yaml_parses or schema_validates');

  if (verdict.live_state_verified !== false) return { pass: true };

  // false → must be partial / incomplete / fail / warn (never pass), and overall ≤ 8.5
  if (verdict.verdict === 'pass') {
    return {
      pass: false,
      detail:
        `live_state_verified=false but verdict='pass'. When live probes failed, the ` +
        `rubric must cap the tier at 'partial' (or lower).`,
      auto_fix_hint:
        "set verdict='partial' (artifact looks correct but live state couldn't be verified). " +
        `If the score is high enough that 'pass' is genuinely earned, re-run the live probes ` +
        'and set live_state_verified=true.',
    };
  }
  if (verdict.overall_score > LIVE_STATE_PARTIAL_CAP) {
    return {
      pass: false,
      detail:
        `live_state_verified=false but overall_score=${verdict.overall_score} ` +
        `exceeds the partial-tier cap of ${LIVE_STATE_PARTIAL_CAP}.`,
      auto_fix_hint:
        `cap overall_score at ${LIVE_STATE_PARTIAL_CAP} per the partial-tier contract. ` +
        'overall_score_pre_cap may stay at the higher raw value for auditability.',
    };
  }
  return { pass: true };
}

/**
 * Check 7: `gate.disposition` is consistent with `overall_score` vs
 * `gate.threshold`.
 *
 * - `approve`: overall_score ≥ threshold (the gate said yes; the score
 *   should justify it).
 * - `reject`: overall_score < threshold.
 * - `iterate`: no constraint — iterate is for borderline cases the gate
 *   wants a human to look at.
 *
 * Skipped when `gate` is omitted (most rubrics omit it; the aggregator
 * applies a default threshold at rollup).
 */
export function checkGateDispositionConsistent(artifact: string): QACheckResult {
  const verdict = safeVerdict(artifact);
  if (!verdict) return skipped('verdict failed yaml_parses or schema_validates');

  const gate = verdict.gate;
  if (!gate) return { pass: true, detail: 'no gate block; aggregator applies default' };

  const score = verdict.overall_score;
  if (gate.disposition === 'approve' && score < gate.threshold) {
    return {
      pass: false,
      detail:
        `gate.disposition='approve' but overall_score=${score} < gate.threshold=${gate.threshold}.`,
      auto_fix_hint:
        "gate.disposition='approve' requires overall_score ≥ gate.threshold. Either re-grade " +
        "the dimensions higher, lower the threshold, or change disposition to 'reject' or 'iterate'.",
    };
  }
  if (gate.disposition === 'reject' && score >= gate.threshold) {
    return {
      pass: false,
      detail:
        `gate.disposition='reject' but overall_score=${score} ≥ gate.threshold=${gate.threshold}.`,
      auto_fix_hint:
        "gate.disposition='reject' requires overall_score < gate.threshold. Either re-grade " +
        "the dimensions lower, raise the threshold, or change disposition to 'approve' or 'iterate'.",
    };
  }
  return { pass: true };
}

// ── CHECKS array (canonical ordering) ───────────────────────────────

export const CHECKS: QACheck[] = [
  {
    id: 'yaml_parses',
    type: 'static',
    description: 'verdict file is parseable YAML',
    run: (artifact) => checkYamlParses(artifact),
  },
  {
    id: 'schema_validates',
    type: 'static',
    description: 'parsed verdict matches lib/verdict-schema.ts § VerdictSchema (top-level fields, enums, ranges)',
    run: (artifact) => checkSchemaValidates(artifact),
  },
  {
    id: 'dimension_weights_sum_to_one',
    type: 'static',
    description: 'dimensions[].weight values sum to 1.0 ± 0.01',
    run: (artifact) => checkDimensionWeightsSumToOne(artifact),
  },
  {
    id: 'overall_score_consistent_with_dimensions',
    type: 'static',
    description: 'overall_score (or overall_score_pre_cap when capped) ≈ weighted mean of scored dimensions ± 0.5',
    run: (artifact) => checkOverallScoreConsistentWithDimensions(artifact),
  },
  {
    id: 'verdict_tier_matches_score',
    type: 'static',
    description: 'pass ≥7.0, warn 5.0-7.0, fail <5.0; incomplete/partial skipped',
    run: (artifact) => checkVerdictTierMatchesScore(artifact),
  },
  {
    id: 'live_state_verified_consistency',
    type: 'static',
    description: 'live_state_verified=false caps verdict at partial and overall_score at 8.5',
    run: (artifact) => checkLiveStateVerifiedConsistency(artifact),
  },
  {
    id: 'gate_disposition_consistent',
    type: 'static',
    description: 'gate.disposition (approve/reject) consistent with overall_score vs gate.threshold',
    run: (artifact) => checkGateDispositionConsistent(artifact),
  },
];
