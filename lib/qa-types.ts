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
/**
 * A check that was deliberately NOT evaluated this time (its input does not
 * exist yet, e.g. a spec the next skill writes). Reported, never counted as a
 * pass — it is neither in `checks_run` nor in `checks_passed`.
 */
export const QANotJudgedSchema = z.object({
  check: z.string().min(1),
  detail: z.string().min(1),
});

/** The failure id `aggregateQAResult` emits when nothing was checked. */
export const NO_CHECKS_RAN = 'no-checks-ran';

const QAResultObjectSchema = z.object({
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

  /** Checks deliberately not evaluated this time, each with why. */
  not_judged: z.array(QANotJudgedSchema).optional(),

  /** Optional metadata: how many auto-fix attempts the orchestrator made. */
  auto_fix: z
    .object({
      attempted: z.boolean(),
      attempts: z.number().int().min(0),
      succeeded: z.boolean().nullable(),
    })
    .optional(),
});

/**
 * The result shape, with the invariants a reader relies on:
 *
 * - **"Nothing was checked" is never a pass.** `verdict: pass` with
 *   `stats.checks_run: 0` reads, on ace-web, as "Passed (0/0 checks)" — the
 *   exact display `bednet-check-2-visit/20260908-1544`'s demo-data-setup-qa
 *   produced, because the skill hand-wrote a different shape (`checks_total`,
 *   `checks[]`) whose counts no reader looks for. A pass now needs ≥ 1 check
 *   run.
 * - The counts add up, and `failures` lists exactly the failed checks.
 */
export const QAResultSchema = QAResultObjectSchema.superRefine((r, ctx) => {
  const { checks_run, checks_passed, checks_failed } = r.stats;
  if (checks_passed + checks_failed !== checks_run) {
    ctx.addIssue({ code: 'custom', path: ['stats'], message: `checks_passed (${checks_passed}) + checks_failed (${checks_failed}) must equal checks_run (${checks_run})` });
  }
  if (r.verdict === 'pass' && checks_run === 0) {
    ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'verdict pass with 0 checks run — nothing was checked, which is not a pass' });
  }
  if (r.verdict === 'pass' && (checks_failed > 0 || r.failures.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'verdict pass with failed checks' });
  }
  if (r.verdict === 'fail' && r.failures.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['failures'], message: 'verdict fail must list at least one failure' });
  }
});

export type QAVerdict = z.infer<typeof QAVerdictSchema>;
export type QANotJudged = z.infer<typeof QANotJudgedSchema>;
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

// ── Aggregation ────────────────────────────────────────────────────

/** One check's outcome as a QA skill holds it before writing the result. */
export interface QACheckOutcome {
  /** Stable id from the skill's `## Checks` table. */
  check: string;
  type?: 'static' | 'llm';
  /** The check's result; omit and set `not_judged` when it was not evaluated. */
  result?: QACheckResult;
  /** Why the check was not evaluated this time (input not there yet). */
  not_judged?: string;
}

export interface AggregateQAInput {
  skill: string;
  target: string;
  capture_path: string;
  ran_at?: string;
  outcomes: readonly QACheckOutcome[];
  /** Include passing checks in `passed[]` (default true — the audit trail is what a reader opens). */
  include_passed?: boolean;
}

/**
 * The ONE way to turn check outcomes into a result file: counts derived, never
 * typed; a failed check without a hint gets a generic one; and when NOTHING was
 * checked the verdict is `fail` with a `no-checks-ran` failure — a gate that
 * ran zero checks has not passed anything. Output always satisfies
 * `QAResultSchema`.
 */
export function aggregateQAResult(input: AggregateQAInput): QAResult {
  const failures: QAFailure[] = [];
  const passed: Array<z.infer<typeof QAPassedSchema>> = [];
  const notJudged: QANotJudged[] = [];
  for (const o of input.outcomes) {
    if (!o.result) {
      notJudged.push({ check: o.check, detail: o.not_judged?.trim() || 'not evaluated this time (no reason given)' });
      continue;
    }
    if (o.result.pass) {
      passed.push(o.result.detail ? { check: o.check, detail: o.result.detail } : { check: o.check });
    } else {
      failures.push({
        check: o.check,
        type: o.type ?? 'static',
        detail: o.result.detail || `check '${o.check}' failed`,
        auto_fix_hint: o.result.auto_fix_hint || `re-run the producer and address: ${o.result.detail || o.check}`,
        severity: 'blocker',
      });
    }
  }
  const run = passed.length + failures.length;
  if (run === 0) {
    failures.push({
      check: NO_CHECKS_RAN,
      type: 'static',
      detail:
        `no check was evaluated (${notJudged.length} not judged) — nothing was checked, which is not a pass`,
      auto_fix_hint:
        'run the checks that apply to this artifact (see the skill\'s check table for which apply to which provider/shape); ' +
        'a missing input is a failure of the check that needs it, not a reason to skip the gate',
      severity: 'blocker',
    });
  }
  const result: QAResult = {
    skill: input.skill,
    target: input.target,
    ran_at: input.ran_at ?? new Date().toISOString(),
    capture_path: input.capture_path,
    schema_version: QA_SCHEMA_VERSION,
    verdict: failures.length === 0 ? 'pass' : 'fail',
    stats: { checks_run: run === 0 ? 1 : run, checks_passed: passed.length, checks_failed: failures.length },
    failures,
  };
  if (input.include_passed !== false && passed.length) result.passed = passed;
  if (notJudged.length) result.not_judged = notJudged;
  return QAResultSchema.parse(result);
}
