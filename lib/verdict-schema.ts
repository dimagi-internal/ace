/**
 * Canonical schema for `-eval` skill verdict YAML files.
 *
 * Every `-eval` skill writes a verdict to `verdicts/<skill>-<mode>.yaml` under
 * the opportunity's Drive folder. The shape is uniform across skills so the
 * umbrella `opp-eval` aggregator can consume any verdict without per-skill
 * knowledge.
 *
 * This module is the single source of truth for the verdict shape — the prose
 * contract in `skills/README.md § Verdict YAML shape` mirrors it. Skills are
 * SKILL.md prompt files and cannot import this module at runtime, but tests,
 * `opp-eval`, and future tooling validate against it.
 *
 * Shape changes are breaking for downstream consumers (notably `opp-eval`).
 * Bump `SCHEMA_VERSION` and add a migration when extending in a non-additive
 * way.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = 2;

// ── Field schemas ──────────────────────────────────────────────────

/**
 * Top-level verdict tiers.
 *
 * v1 (`pass` / `warn` / `fail`): graded artifact, defects (or absence) sized
 * by the rubric's deductions.
 *
 * v2 additions:
 * - `incomplete` — structural gap in the artifact prevents grading
 *   (degraded-mode `TBD-MANUAL` ids, missing PDD, etc.). Counts as
 *   "not gradable" in `opp-eval`'s coverage cap, not as a defect. Several
 *   rubric SKILL.md files referenced this value before v2 — schema now
 *   matches the prose.
 * - `partial` — artifact looks correct on paper but live verification
 *   probes failed at grading time (network, auth, transient 5xx). Records
 *   the text-only score; downstream consumers should re-grade when MCP is
 *   reachable. Caps overall at 8.5.
 *
 * Per-item verdicts (inside `per_item[]`) stay restricted to pass/warn/fail
 * — the top-level tier covers gradability, but per-item entries are by
 * definition graded.
 */
export const VerdictDispositionSchema = z.enum(['pass', 'warn', 'fail', 'incomplete', 'partial']);
export type VerdictDisposition = z.infer<typeof VerdictDispositionSchema>;

export const PerItemVerdictSchema = z.enum(['pass', 'warn', 'fail']);
export type PerItemVerdict = z.infer<typeof PerItemVerdictSchema>;

export const ModeSchema = z.enum(['quick', 'deep', 'monitor', 'shallow']);
export type Mode = z.infer<typeof ModeSchema>;
// `shallow` was added 2026-05-04 with the shallow/deep QA split — Phase 5
// `app-screenshot-capture` writes a shallow smoke verdict that's distinct
// from the OCS quick/deep/monitor cadence. Spec:
// docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md.

/**
 * `auto_surfaced` severity tiers.
 *
 * v1 (`BLOCKER` / `WARN` / `INFO`): rubric-deducting tiers; WARN counts
 * toward inflation guards.
 *
 * v2 additions:
 * - `PLATFORM` — defect originates in the upstream service (Connect,
 *   OCS), not in the skill's output. Documents the gap without penalizing
 *   skill quality. Does NOT count toward inflation guards. Without this
 *   tier, rubrics would deduct from skills for things the operator
 *   cannot fix.
 * - `DRIFT` — discrepancy between artifact text and live state probe.
 *   Diagnostic-only; the dimension consuming either source already
 *   deducts if either is wrong, so DRIFT does NOT count toward inflation
 *   guards (counting would double-penalize).
 * - `INFO-SKIPPED` — sub-check intentionally skipped because input data
 *   is absent (e.g., payment-rate sanity when no PDD day-rate). Documents
 *   coverage gap without penalizing.
 */
export const SeveritySchema = z.enum(['BLOCKER', 'WARN', 'INFO', 'PLATFORM', 'DRIFT', 'INFO-SKIPPED']);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * `score` is nullable to support the umbrella `opp-eval` partial-coverage
 * case: when no per-skill verdict exists in a category, the dimension's
 * score is `null` and its weight is renormalized away from the overall at
 * aggregation time. Per-skill `-eval` rubrics never emit null scores —
 * they grade or emit `verdict: incomplete` at the top level.
 */
export const DimensionSchema = z.object({
  score: z.number().min(0).max(10).nullable(),
  weight: z.number().min(0).max(1),
});
export type Dimension = z.infer<typeof DimensionSchema>;

export const PerItemSchema = z.object({
  ref: z.string().min(1),
  score: z.number().min(0).max(10),
  verdict: PerItemVerdictSchema,
  note: z.string().optional(),
}).passthrough(); // domain-specific extras (e.g., `prompt:` for chatbot evals)
export type PerItem = z.infer<typeof PerItemSchema>;

export const AutoSurfacedSchema = z.object({
  severity: SeveritySchema,
  message: z.string().min(1),
});
export type AutoSurfaced = z.infer<typeof AutoSurfacedSchema>;

export const GateSchema = z.object({
  threshold: z.number().min(0).max(10),
  disposition: z.enum(['approve', 'reject', 'iterate']),
});
export type Gate = z.infer<typeof GateSchema>;

// ── Top-level verdict ──────────────────────────────────────────────

/**
 * Canonical verdict shape. Mirrors `skills/README.md § Verdict YAML shape`.
 *
 * `dimensions` weights SHOULD sum to 1.0 (renormalized at aggregation time
 * if a dimension is null). `per_item`, `auto_surfaced`, and `gate` are
 * optional. Skills MAY add extra top-level fields; the aggregator reads
 * positionally and ignores extras.
 */
export const VerdictSchema = z.object({
  skill: z.string().min(1),
  /**
   * `target` accepts either a string or a number — many real targets are
   * numeric IDs (experiment_id, opportunity_id, nova_app_id) and YAML
   * parses unquoted integers as numbers. Coerce both shapes; downstream
   * consumers should treat target as a stringified identifier.
   */
  target: z.union([z.string().min(1), z.number()]),
  mode: ModeSchema.optional(),
  ran_at: z.string().min(1), // ISO timestamp; not strict — Drive YAML is hand-edited
  capture_path: z.string().min(1),

  overall_score: z.number().min(0).max(10),
  /**
   * `overall_score_pre_cap` — what the dimensional weighted mean was before
   * any inflation guard / verdict-tier cap bound. Records what the rubric's
   * raw judgment was; `overall_score` is what the user sees post-cap. Both
   * tracked so variance protocols can measure the rubric, not the cap. See
   * `docs/eval-calibration-learnings.md § Cap collapses variance`.
   */
  overall_score_pre_cap: z.number().min(0).max(10).optional(),
  verdict: VerdictDispositionSchema,

  /**
   * `live_state_verified` — `true` if the rubric ran live MCP probes and
   * cross-checked the artifact against current upstream state. `false` if
   * probes were skipped (degraded mode), failed at grading time, or the
   * rubric simply didn't have any. When `false` *and* the artifact is
   * non-degraded, the verdict tier should be capped at `partial` (≤8.5).
   */
  live_state_verified: z.boolean().optional(),

  dimensions: z.record(z.string(), DimensionSchema),

  per_item: z.array(PerItemSchema).optional(),
  auto_surfaced: z.array(AutoSurfacedSchema).optional(),
  gate: GateSchema.optional(),
}).passthrough();

export type Verdict = z.infer<typeof VerdictSchema>;

// ── Validation helpers ─────────────────────────────────────────────

export interface VerdictValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a parsed verdict object (e.g., from `js-yaml.load`) against the
 * schema. Returns a structured result instead of throwing — `opp-eval` and
 * `-eval` skills want to surface specific malformations rather than crash.
 */
export function validateVerdict(input: unknown): VerdictValidationResult {
  const parsed = VerdictSchema.safeParse(input);
  if (parsed.success) {
    // Soft check: dimension weights should sum to ~1.0.
    const weightSum = Object.values(parsed.data.dimensions)
      .reduce((acc, d) => acc + d.weight, 0);
    const errors: string[] = [];
    if (Math.abs(weightSum - 1.0) > 0.01) {
      errors.push(
        `dimensions weights sum to ${weightSum.toFixed(3)}, expected 1.0 ` +
          `(opp-eval renormalizes at aggregation, but a verdict that already ` +
          `sums to 1.0 makes the per-skill score legible standalone)`,
      );
    }
    return { ok: errors.length === 0, errors };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
