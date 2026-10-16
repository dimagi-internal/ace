/**
 * Compose a `lib/verdict-schema.ts` verdict from DETERMINISTIC dimension
 * scores — the shared back half of the fact-check evals that used to be LLM
 * judges (`app-release-eval`, the fact half of `connect-opp-setup-eval`,
 * `ocs-widget-handoff-eval`).
 *
 * ## Why these evals stopped being LLM judges
 *
 * Every dimension of `app-release-eval`, and most of the other two, grades a
 * FACT that an API already states: is the build released, does the CCZ carry
 * the markers, does Connect hold the payment unit the PDD declares, does the
 * public chat URL answer 200, does a credential string appear in a document.
 * An LLM re-reading those API payloads adds latency (one Opus subagent boots at
 * ~126k tokens before its first read — ACE run-efficiency audit, 2026-10-16,
 * three runs) and run-to-run variance, and buys nothing a comparison does not
 * give exactly. The rubric prose stays in each SKILL.md as the SPEC this code
 * implements; the code is now the grader.
 *
 * Where a dimension needs real judgment (opp deployability against a regional
 * day-rate, archetype coherence, readability of operator instructions) the
 * caller passes it in as a `residue` dimension, scored by the skill's LLM pass,
 * and this module folds it in under the same tier rules — so the judgment part
 * is small and explicit rather than smeared over facts.
 *
 * ## Tier rules (identical to the rubrics they replace)
 *
 * - any dimension ≤ 3, or any `BLOCKER` auto-surfaced entry → `fail`
 * - ≥ 2 `WARN` auto-surfaced entries → overall capped at 8.5 (PLATFORM / DRIFT /
 *   INFO never count)
 * - live state not verified and overall ≥ 7 → `partial`, capped at 8.5
 * - otherwise pass ≥ 7.0, warn ≥ 5.0, fail below
 */
import type { AutoSurfaced, CheckRecord, Verdict, VerdictDisposition } from './verdict-schema.js';
import { validateVerdict } from './verdict-schema.js';

export interface ScoredDimension {
  score: number;
  weight: number;
  /** Why it scored what it did — rendered into `per_item`. */
  note: string;
  /** `deterministic` (computed here) or `judgment` (the skill's LLM residue). */
  source: 'deterministic' | 'judgment';
}

export interface ComposeInput {
  skill: string;
  target: string;
  capturePath: string;
  mode?: 'quick' | 'deep' | 'monitor' | 'shallow';
  ranAt?: string;
  dimensions: Record<string, ScoredDimension>;
  autoSurfaced: AutoSurfaced[];
  checks: CheckRecord[];
  /** False when a live probe failed at grading time (not when it was N/A). */
  liveStateVerified: boolean;
  /** Extra top-level fields (passthrough in the schema). */
  extra?: Record<string, unknown>;
}

const clamp = (n: number) => Math.max(0, Math.min(10, Math.round(n * 100) / 100));

export function composeVerdict(input: ComposeInput): Verdict {
  const dims = Object.entries(input.dimensions);
  const totalWeight = dims.reduce((s, [, d]) => s + d.weight, 0) || 1;
  const pre = clamp(dims.reduce((s, [, d]) => s + clamp(d.score) * d.weight, 0) / totalWeight);
  const anyFloor = dims.some(([, d]) => clamp(d.score) <= 3);
  const warns = input.autoSurfaced.filter((a) => a.severity === 'WARN').length;

  let overall = pre;
  const capBinds = warns >= 2 && pre > 8.5;
  if (capBinds) overall = 8.5;

  // "warn — overall ≥ 5.0 < 7.0, or any inflation cap binds" (every replaced rubric).
  // A BLOCKER is "must-fix before the next phase" in every replaced rubric; a
  // weighted mean must not average one away (a Deliver CCZ with zero units
  // otherwise lands ~7.4 = pass).
  const blocker = input.autoSurfaced.some((a) => a.severity === 'BLOCKER');
  let verdict: VerdictDisposition;
  if (anyFloor || blocker || overall < 5) verdict = 'fail';
  else if (overall < 7 || capBinds) verdict = 'warn';
  else verdict = 'pass';
  if (verdict === 'pass' && !input.liveStateVerified) {
    verdict = 'partial';
    overall = Math.min(overall, 8.5);
  }

  const v = {
    skill: input.skill,
    target: input.target,
    mode: input.mode ?? 'deep',
    ran_at: input.ranAt ?? new Date().toISOString(),
    capture_path: input.capturePath,
    method: dims.some(([, d]) => d.source === 'judgment') ? 'deterministic+judgment-residue' : 'deterministic',
    overall_score: overall,
    overall_score_pre_cap: pre,
    verdict,
    live_state_verified: input.liveStateVerified,
    dimensions: Object.fromEntries(dims.map(([k, d]) => [k, { score: clamp(d.score), weight: d.weight }])),
    per_item: dims.map(([k, d]) => ({
      ref: k,
      score: clamp(d.score),
      verdict: clamp(d.score) <= 3 ? 'fail' : clamp(d.score) < 7 ? 'warn' : 'pass',
      note: `${d.source === 'judgment' ? '[judgment] ' : ''}${d.note}`,
    })),
    auto_surfaced: input.autoSurfaced,
    checks: input.checks,
    ...(input.extra ?? {}),
  } as Verdict;
  const val = validateVerdict(v);
  if (!val.ok) throw new Error(`composeVerdict produced an invalid verdict: ${val.errors.join('; ')}`);
  return v;
}

/** The `incomplete` verdict — the owned artifact is missing; nothing is gradable. */
export function incompleteVerdict(input: {
  skill: string;
  target: string;
  capturePath: string;
  reason: string;
  dimensionWeights: Record<string, number>;
  ranAt?: string;
}): Verdict {
  const v = {
    skill: input.skill,
    target: input.target,
    mode: 'deep',
    ran_at: input.ranAt ?? new Date().toISOString(),
    capture_path: input.capturePath,
    method: 'deterministic',
    overall_score: 0,
    verdict: 'incomplete',
    live_state_verified: false,
    dimensions: Object.fromEntries(
      Object.entries(input.dimensionWeights).map(([k, w]) => [k, { score: null, weight: w }]),
    ),
    auto_surfaced: [{ severity: 'INFO', message: input.reason }],
    checks: [{ name: 'owned-artifact-present', status: 'unable', reason: input.reason }],
  } as unknown as Verdict;
  return v;
}

/** Validate residue dimensions handed in by the skill's judgment pass. */
export function parseResidue(
  raw: unknown,
  expected: Record<string, number>,
): Record<string, ScoredDimension> {
  const out: Record<string, ScoredDimension> = {};
  const obj = (raw ?? {}) as Record<string, { score?: unknown; note?: unknown }>;
  for (const [name, weight] of Object.entries(expected)) {
    const r = obj[name];
    const score = typeof r?.score === 'number' ? r.score : NaN;
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      throw new Error(`residue dimension "${name}" needs a numeric score 0-10 (got ${JSON.stringify(r?.score)})`);
    }
    const note = typeof r?.note === 'string' && r.note.trim() ? r.note.trim() : '';
    if (!note) throw new Error(`residue dimension "${name}" needs a note saying why`);
    out[name] = { score, weight, note, source: 'judgment' };
  }
  return out;
}
