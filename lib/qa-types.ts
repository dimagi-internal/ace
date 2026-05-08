/**
 * Canonical schema for `-qa` skill QA result YAML files.
 *
 * Every `-qa` skill writes a result to
 * `<phase>/<producer>-qa_result.yaml` under the run's Drive folder. The
 * shape is uniform across skills so the orchestrator can consume any QA
 * result without per-skill knowledge — and so static checks can be
 * authored as importable TS functions and unit-tested directly.
 *
 * This module is the single source of truth for the QA result shape.
 * The prose contract lives at `skills/_qa-template.md` and mirrors
 * this schema.
 *
 * Companion to `lib/verdict-schema.ts` (which defines the eval verdict
 * shape). The two run on every artifact: QA gates eval. QA verdicts
 * are binary (pass/fail/incomplete); eval verdicts are scored.
 */

import { z } from 'zod';

export const QA_SCHEMA_VERSION = 1;

// ── Field schemas ──────────────────────────────────────────────────

/**
 * Verdict tiers for QA results.
 *
 * - `pass`: all checks passed; eval can proceed.
 * - `fail`: ≥1 check failed; orchestrator should attempt auto-fix or halt.
 * - `incomplete`: QA could not complete (e.g. artifact missing entirely);
 *   distinct from `fail` because there's nothing to fix in the artifact.
 *
 * **No `warn` tier.** QA is binary do-not-pass-go. Soft signals belong in eval.
 */
export const QAVerdictSchema = z.enum(['pass', 'fail', 'incomplete']);

/**
 * A failed QA check.
 *
 * Severity is always `blocker` — present for symmetry with eval verdicts'
 * `auto_surfaced` shape but always populated to the same value. QA has
 * no warning tier.
 */
export const QAFailureSchema = z.object({
  /** Stable identifier for the check; matches `## Checks` in the skill body. */
  check: z.string().min(1),
  /** Whether this check ran statically (regex/parse) or via LLM. */
  type: z.enum(['static', 'llm']),
  /** One-line description of what's wrong. */
  detail: z.string().min(1),
  /** Instruction the orchestrator passes to the producer on regeneration. */
  auto_fix_hint: z.string().min(1),
  /** Always `blocker`. QA has no `warn` or `info` tier. */
  severity: z.literal('blocker'),
});

/**
 * A passing QA check (audit trail; optional in the YAML).
 *
 * Most QA results omit this entirely — the absence of failures is
 * sufficient evidence of pass. Include only when audit-trail value
 * outweighs YAML noise.
 */
export const QAPassedSchema = z.object({
  check: z.string().min(1),
  detail: z.string().optional(),
});

export const QAStatsSchema = z.object({
  checks_run: z.number().int().min(0),
  checks_passed: z.number().int().min(0),
  checks_failed: z.number().int().min(0),
});

/**
 * The QA result file shape.
 *
 * Filename: `<phase>/<producer>-qa_result.yaml`
 *   (e.g. `1-design/idea-to-pdd-qa_result.yaml`)
 *
 * The orchestrator reads this; if `verdict: fail`, it attempts auto-fix
 * using `failures[].auto_fix_hint` and re-runs the QA. After bounded
 * retries, halts with the unresolved failures.
 */
export const QAResultSchema = z.object({
  /** This skill's name (e.g. `idea-to-pdd-qa`). */
  skill: z.string().min(1),
  /** Identifier for what was checked (opp name, artifact id, etc.). */
  target: z.string().min(1),
  /** ISO timestamp when the QA ran. */
  ran_at: z.string(),
  /** Path to the artifact under review (relative to runs/<run-id>/). */
  capture_path: z.string().min(1),

  /** Schema version. Bump on breaking shape changes; add migration. */
  schema_version: z.literal(QA_SCHEMA_VERSION).optional(),

  /** Binary verdict. */
  verdict: QAVerdictSchema,

  /** Aggregate counts. */
  stats: QAStatsSchema,

  /** Failed checks. Empty array when verdict: pass. */
  failures: z.array(QAFailureSchema),

  /** Optional list of passed checks (audit). Usually omitted. */
  passed: z.array(QAPassedSchema).optional(),

  /** Optional metadata: how many auto-fix attempts the orchestrator made. */
  auto_fix: z
    .object({
      attempted: z.boolean(),
      attempts: z.number().int().min(0),
      succeeded: z.boolean().nullable(),
    })
    .optional(),
});

export type QAVerdict = z.infer<typeof QAVerdictSchema>;
export type QAFailure = z.infer<typeof QAFailureSchema>;
export type QAStats = z.infer<typeof QAStatsSchema>;
export type QAResult = z.infer<typeof QAResultSchema>;

// ── Check primitives ───────────────────────────────────────────────

/**
 * The shape returned by an individual static or LLM check.
 *
 * Static checks live in `skills/<producer>-qa/checks.ts` as exported
 * functions. They take the artifact text (and optional context) and
 * return a single `QACheckResult`.
 *
 * If the check fails, `auto_fix_hint` MUST be populated — it's the
 * instruction the orchestrator passes to the producer for regeneration.
 */
export const QACheckResultSchema = z.object({
  pass: z.boolean(),
  detail: z.string().optional(),
  auto_fix_hint: z.string().optional(),
});

export type QACheckResult = z.infer<typeof QACheckResultSchema>;

/**
 * A check definition. The skill's `checks.ts` exports a `CHECKS`
 * array of these so the runner can iterate uniformly.
 */
export interface QACheck {
  /** Stable identifier; matches the skill body's `## Checks` table. */
  id: string;
  /** Static (regex/parse) or LLM (semantic). */
  type: 'static' | 'llm';
  /** One-line description for skill body docs and logs. */
  description: string;
  /** Run the check against the artifact. May be sync or async. */
  run: (artifact: string, ctx?: QACheckContext) => Promise<QACheckResult> | QACheckResult;
}

/**
 * Optional context passed to checks (e.g. inputs-manifest, upstream
 * verdicts, run metadata). Each check declares which keys it expects
 * via TypeScript types in its checks.ts file.
 */
export type QACheckContext = Record<string, unknown>;

// ── Validation helper ──────────────────────────────────────────────

/**
 * Validate a parsed YAML document against the QA result schema.
 *
 * Returns the parsed value on success; throws a `ZodError` on failure.
 * Use in tests + the canopy improve-lens dispatcher to catch malformed
 * QA results early.
 */
export function validateQAResult(value: unknown): QAResult {
  return QAResultSchema.parse(value);
}
