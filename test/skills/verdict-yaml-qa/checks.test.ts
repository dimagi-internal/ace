/**
 * Unit tests for static QA checks in skills/verdict-yaml-qa/checks.ts.
 *
 * Each check is a pure function. Tests use small inline YAML strings to
 * exercise individual branches. Cross-cutting "all checks pass on a real
 * verdict" tests use minimal fixture YAMLs inline.
 */

import { describe, expect, test } from 'vitest';

import {
  checkYamlParses,
  checkSchemaValidates,
  checkDimensionWeightsSumToOne,
  checkOverallScoreConsistentWithDimensions,
  checkVerdictTierMatchesScore,
  checkLiveStateVerifiedConsistency,
  checkGateDispositionConsistent,
  CHECKS,
} from '../../../skills/verdict-yaml-qa/checks';
import { runChecks } from '../../../lib/qa-runner';

// ── Fixtures ───────────────────────────────────────────────────────

/** A well-formed verdict that should pass every check. */
const PASSING_VERDICT = `
skill: idea-to-pdd-eval
target: turmeric-market-survey
mode: deep
ran_at: 2026-05-09T10:00:00Z
capture_path: 1-design/idea-to-pdd.md
overall_score: 8.0
verdict: pass
dimensions:
  archetype_fit: { score: 9.0, weight: 0.4 }
  intervention_clarity: { score: 7.5, weight: 0.6 }
auto_surfaced:
  - severity: INFO
    message: "All sections substantive."
`;

/** Verdict with weights that don't sum to 1.0. */
const BAD_WEIGHTS_VERDICT = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 7.0
verdict: pass
dimensions:
  a: { score: 7.0, weight: 0.4 }
  b: { score: 7.0, weight: 0.4 }
`;

/** Verdict where overall_score doesn't match the weighted mean. */
const SCORE_MISMATCH_VERDICT = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 4.0
verdict: pass
dimensions:
  a: { score: 9.0, weight: 0.5 }
  b: { score: 9.0, weight: 0.5 }
`;

/** Verdict with verdict-tier-vs-score drift (verdict='pass' but score=4). */
const TIER_DRIFT_VERDICT = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 4.0
verdict: pass
dimensions:
  a: { score: 4.0, weight: 1.0 }
`;

// ── checkYamlParses ────────────────────────────────────────────────

describe('checkYamlParses', () => {
  test('passes on valid YAML', () => {
    expect(checkYamlParses(PASSING_VERDICT).pass).toBe(true);
  });

  test('fails on invalid YAML', () => {
    const bad = 'foo:\n  bar: [unclosed';
    const result = checkYamlParses(bad);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('YAML parse error');
    expect(result.auto_fix_hint).toBeTruthy();
  });
});

// ── checkSchemaValidates ───────────────────────────────────────────

describe('checkSchemaValidates', () => {
  test('passes on a well-formed verdict', () => {
    expect(checkSchemaValidates(PASSING_VERDICT).pass).toBe(true);
  });

  test('fails when a required field is missing', () => {
    const missing = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
overall_score: 7.0
verdict: pass
dimensions:
  a: { score: 7.0, weight: 1.0 }
`;
    // Missing: capture_path
    const result = checkSchemaValidates(missing);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('capture_path');
  });

  test('fails when verdict is not in the enum', () => {
    const bad = PASSING_VERDICT.replace('verdict: pass', 'verdict: amazing');
    const result = checkSchemaValidates(bad);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('verdict');
  });

  test('fails when severity is not in the enum', () => {
    const bad = PASSING_VERDICT.replace('severity: INFO', 'severity: MAYBE');
    const result = checkSchemaValidates(bad);
    expect(result.pass).toBe(false);
  });

  test('fails when overall_score is out of range', () => {
    const bad = PASSING_VERDICT.replace('overall_score: 8.0', 'overall_score: 12.0');
    const result = checkSchemaValidates(bad);
    expect(result.pass).toBe(false);
  });

  test('skipped when YAML does not parse', () => {
    const result = checkSchemaValidates('not: [valid');
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('skipped');
  });
});

// ── checkDimensionWeightsSumToOne ──────────────────────────────────

describe('checkDimensionWeightsSumToOne', () => {
  test('passes when weights sum to 1.0', () => {
    expect(checkDimensionWeightsSumToOne(PASSING_VERDICT).pass).toBe(true);
  });

  test('passes within tolerance (sum=0.999)', () => {
    const close = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 7.0
verdict: pass
dimensions:
  a: { score: 7.0, weight: 0.333 }
  b: { score: 7.0, weight: 0.333 }
  c: { score: 7.0, weight: 0.333 }
`;
    // 0.999 — within 0.01 tolerance
    expect(checkDimensionWeightsSumToOne(close).pass).toBe(true);
  });

  test('fails when weights drift outside tolerance', () => {
    const result = checkDimensionWeightsSumToOne(BAD_WEIGHTS_VERDICT);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('0.800');
    expect(result.detail).toContain('a=0.4, b=0.4');
    expect(result.auto_fix_hint).toBeTruthy();
  });

  test('fails when no dimensions present', () => {
    const empty = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 7.0
verdict: pass
dimensions: {}
`;
    const result = checkDimensionWeightsSumToOne(empty);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('no dimensions');
  });

  test('skipped when YAML does not parse', () => {
    expect(checkDimensionWeightsSumToOne('garbage: [').pass).toBe(true);
  });
});

// ── checkOverallScoreConsistentWithDimensions ──────────────────────

describe('checkOverallScoreConsistentWithDimensions', () => {
  test('passes when overall matches weighted mean', () => {
    // 9.0*0.4 + 7.5*0.6 = 3.6 + 4.5 = 8.1; overall_score=8.0; drift=0.1; tolerance=0.5 → pass
    expect(checkOverallScoreConsistentWithDimensions(PASSING_VERDICT).pass).toBe(true);
  });

  test('fails when overall is grossly off', () => {
    // weighted mean = 9.0; overall_score=4.0; drift=5.0 → fail
    const result = checkOverallScoreConsistentWithDimensions(SCORE_MISMATCH_VERDICT);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('overall_score=4');
  });

  test('passes with overall_score_pre_cap matching mean (post-cap differs)', () => {
    // weighted mean = 9.0; pre_cap=9.0; overall=7.0 (capped). The QA looks at pre_cap when present.
    const capped = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 7.0
overall_score_pre_cap: 9.0
verdict: warn
dimensions:
  a: { score: 9.0, weight: 1.0 }
`;
    expect(checkOverallScoreConsistentWithDimensions(capped).pass).toBe(true);
  });

  test('passes when all dimensions are null (incomplete)', () => {
    const incomplete = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 0
verdict: incomplete
dimensions:
  a: { score: null, weight: 0.5 }
  b: { score: null, weight: 0.5 }
`;
    const result = checkOverallScoreConsistentWithDimensions(incomplete);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('null');
  });
});

// ── checkVerdictTierMatchesScore ───────────────────────────────────

describe('checkVerdictTierMatchesScore', () => {
  test('passes when pass + score ≥ 7.0', () => {
    expect(checkVerdictTierMatchesScore(PASSING_VERDICT).pass).toBe(true);
  });

  test('fails when verdict=pass but score < 7.0', () => {
    const result = checkVerdictTierMatchesScore(TIER_DRIFT_VERDICT);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("verdict='pass'");
    expect(result.detail).toContain('fail'); // expected tier for score=4
  });

  test('passes for warn tier (score=6.0)', () => {
    const warn = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 6.0
verdict: warn
dimensions:
  a: { score: 6.0, weight: 1.0 }
`;
    expect(checkVerdictTierMatchesScore(warn).pass).toBe(true);
  });

  test('passes for fail tier (score=3.0)', () => {
    const fail = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 3.0
verdict: fail
dimensions:
  a: { score: 3.0, weight: 1.0 }
`;
    expect(checkVerdictTierMatchesScore(fail).pass).toBe(true);
  });

  test('skipped for incomplete tier', () => {
    const incomplete = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 0
verdict: incomplete
dimensions:
  a: { score: null, weight: 1.0 }
`;
    const result = checkVerdictTierMatchesScore(incomplete);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('not score-driven');
  });

  test('skipped for partial tier', () => {
    const partial = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 8.0
verdict: partial
live_state_verified: false
dimensions:
  a: { score: 8.0, weight: 1.0 }
`;
    const result = checkVerdictTierMatchesScore(partial);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('not score-driven');
  });

  test('boundary: score=7.0 maps to pass', () => {
    const boundary = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 7.0
verdict: pass
dimensions:
  a: { score: 7.0, weight: 1.0 }
`;
    expect(checkVerdictTierMatchesScore(boundary).pass).toBe(true);
  });

  test('boundary: score=5.0 maps to warn (not fail)', () => {
    const boundary = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 5.0
verdict: warn
dimensions:
  a: { score: 5.0, weight: 1.0 }
`;
    expect(checkVerdictTierMatchesScore(boundary).pass).toBe(true);
  });
});

// ── checkLiveStateVerifiedConsistency ──────────────────────────────

describe('checkLiveStateVerifiedConsistency', () => {
  test('passes when live_state_verified is omitted', () => {
    expect(checkLiveStateVerifiedConsistency(PASSING_VERDICT).pass).toBe(true);
  });

  test('passes when live_state_verified=true', () => {
    const verified = PASSING_VERDICT + '\nlive_state_verified: true\n';
    expect(checkLiveStateVerifiedConsistency(verified).pass).toBe(true);
  });

  test('fails when live_state_verified=false but verdict=pass', () => {
    const bad = PASSING_VERDICT + '\nlive_state_verified: false\n';
    const result = checkLiveStateVerifiedConsistency(bad);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("verdict='pass'");
  });

  test('passes when live_state_verified=false and verdict=partial with score ≤ 8.5', () => {
    const ok = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 7.5
verdict: partial
live_state_verified: false
dimensions:
  a: { score: 7.5, weight: 1.0 }
`;
    expect(checkLiveStateVerifiedConsistency(ok).pass).toBe(true);
  });

  test('fails when live_state_verified=false but score > 8.5', () => {
    const bad = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 9.0
verdict: partial
live_state_verified: false
dimensions:
  a: { score: 9.0, weight: 1.0 }
`;
    const result = checkLiveStateVerifiedConsistency(bad);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('exceeds the partial-tier cap');
  });
});

// ── checkGateDispositionConsistent ─────────────────────────────────

describe('checkGateDispositionConsistent', () => {
  test('passes when no gate block present', () => {
    expect(checkGateDispositionConsistent(PASSING_VERDICT).pass).toBe(true);
  });

  test('passes when approve and score ≥ threshold', () => {
    const ok = PASSING_VERDICT + `
gate:
  threshold: 7.0
  disposition: approve
`;
    expect(checkGateDispositionConsistent(ok).pass).toBe(true);
  });

  test('fails when approve but score < threshold', () => {
    const bad = PASSING_VERDICT + `
gate:
  threshold: 9.0
  disposition: approve
`;
    const result = checkGateDispositionConsistent(bad);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("'approve'");
  });

  test('passes when reject and score < threshold', () => {
    const ok = `
skill: x-eval
target: opp
ran_at: 2026-05-09T10:00:00Z
capture_path: foo.md
overall_score: 4.0
verdict: fail
dimensions:
  a: { score: 4.0, weight: 1.0 }
gate:
  threshold: 7.0
  disposition: reject
`;
    expect(checkGateDispositionConsistent(ok).pass).toBe(true);
  });

  test('fails when reject but score ≥ threshold', () => {
    const bad = PASSING_VERDICT + `
gate:
  threshold: 7.0
  disposition: reject
`;
    const result = checkGateDispositionConsistent(bad);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("'reject'");
  });

  test('passes when iterate (no constraint)', () => {
    const iterate = PASSING_VERDICT + `
gate:
  threshold: 9.0
  disposition: iterate
`;
    expect(checkGateDispositionConsistent(iterate).pass).toBe(true);
  });
});

// ── End-to-end via runChecks ───────────────────────────────────────

describe('CHECKS array with runChecks', () => {
  test('all 7 checks pass on a well-formed verdict', async () => {
    const result = await runChecks({
      skill: 'verdict-yaml-qa',
      target: 'turmeric',
      capture_path: '1-design/idea-to-pdd-eval_verdict.yaml',
      artifact: PASSING_VERDICT,
      checks: CHECKS,
    });
    expect(result.verdict).toBe('pass');
    expect(result.stats.checks_run).toBe(7);
    expect(result.stats.checks_failed).toBe(0);
  });

  test('failure surfaces specific check ids', async () => {
    const result = await runChecks({
      skill: 'verdict-yaml-qa',
      target: 'opp',
      capture_path: 'foo_verdict.yaml',
      artifact: BAD_WEIGHTS_VERDICT,
      checks: CHECKS,
    });
    expect(result.verdict).toBe('fail');
    expect(result.failures.map((f) => f.check)).toContain('dimension_weights_sum_to_one');
  });

  test('YAML parse failure cascades to skipped on dependent checks', async () => {
    const result = await runChecks({
      skill: 'verdict-yaml-qa',
      target: 'opp',
      capture_path: 'foo_verdict.yaml',
      artifact: 'not: [valid yaml',
      checks: CHECKS,
    });
    // yaml_parses fails; everything else passes-as-skipped, so verdict is 'fail' (only 1 failure)
    expect(result.verdict).toBe('fail');
    expect(result.stats.checks_failed).toBe(1);
    expect(result.failures[0].check).toBe('yaml_parses');
  });

  test('CHECKS array shape is what the SKILL.md table claims', () => {
    expect(CHECKS).toHaveLength(7);
    const ids = CHECKS.map((c) => c.id);
    expect(ids).toEqual([
      'yaml_parses',
      'schema_validates',
      'dimension_weights_sum_to_one',
      'overall_score_consistent_with_dimensions',
      'verdict_tier_matches_score',
      'live_state_verified_consistency',
      'gate_disposition_consistent',
    ]);
    for (const c of CHECKS) {
      expect(c.type).toBe('static');
      expect(c.description.length).toBeGreaterThan(10);
      expect(typeof c.run).toBe('function');
    }
  });
});
