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

export const SCHEMA_VERSION = 1;

// ── Field schemas ──────────────────────────────────────────────────

export const VerdictDispositionSchema = z.enum(['pass', 'warn', 'fail']);
export type VerdictDisposition = z.infer<typeof VerdictDispositionSchema>;

export const ModeSchema = z.enum(['quick', 'deep', 'monitor']);
export type Mode = z.infer<typeof ModeSchema>;

export const SeveritySchema = z.enum(['BLOCKER', 'WARN', 'INFO']);
export type Severity = z.infer<typeof SeveritySchema>;

export const DimensionSchema = z.object({
  score: z.number().min(0).max(10),
  weight: z.number().min(0).max(1),
});
export type Dimension = z.infer<typeof DimensionSchema>;

export const PerItemSchema = z.object({
  ref: z.string().min(1),
  score: z.number().min(0).max(10),
  verdict: VerdictDispositionSchema,
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
  target: z.string().min(1),
  mode: ModeSchema.optional(),
  ran_at: z.string().min(1), // ISO timestamp; not strict — Drive YAML is hand-edited
  capture_path: z.string().min(1),

  overall_score: z.number().min(0).max(10),
  verdict: VerdictDispositionSchema,

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
