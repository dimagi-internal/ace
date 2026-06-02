/**
 * Lightweight validator for the per-run `run_state.yaml` shape that every
 * phase agent writes via the Phase Write-Back Contract.
 *
 * Source-of-truth contract:
 *   - `agents/orchestrator-reference.md § Phase Write-Back Contract`
 *
 * This module is intentionally **pure** — no I/O, no Drive access, no
 * yaml-parsing. Callers parse the YAML themselves (via `yaml`'s `parse`
 * or whatever) and hand the resulting JS object to `validateRunState`.
 * Keeping it pure lets the orchestrator's Phase Write-Back Verifier
 * invoke it inline on already-read state without an extra round-trip,
 * and lets tests cover every shape without a fixture YAML file.
 *
 * The validator distinguishes two severities:
 *   - `errors`: structural issues that downstream consumers can't recover
 *     from (e.g. `phases` is a string, `status` is not in the allowed
 *     enum). These should halt the run.
 *   - `warnings`: schema violations that don't break parsing but signal
 *     missing audit-trail info (e.g. a `status: done` step with no
 *     `artifact` field). These should log but not halt — they're the
 *     same class as the Producer Artifact Verifier's reads.
 *
 * `valid` is true iff `errors.length === 0`. Warnings do NOT affect
 * validity.
 */

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  path: string;
  message: string;
  severity: ValidationSeverity;
  expected?: string;
  actual?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const PHASE_STATUSES = new Set([
  'pending',
  'in_progress',
  'done',
  'error',
  'blocked', // operator-actionable halt (recoverable); distinct from a hard `error`
  'skipped', // run-shape decision: this phase is intentionally not run this run
             // (a seeded mid-pipeline run marks gap/tail phases skipped so the
             // orchestrator steps over them and the run ends when no `pending`
             // phase remains). Set structurally at run-seed, never mid-phase.
]);

const STEP_STATUSES = new Set([
  'pending',
  'in_progress',
  'done',
  'complete', // legacy synonym for `done` — observed in older runs
  'error',
  'incomplete',
  'skipped',
  'deferred',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pushError(
  issues: ValidationIssue[],
  path: string,
  message: string,
  expected?: string,
  actual?: unknown,
): void {
  issues.push({ path, message, severity: 'error', expected, actual });
}

function pushWarning(
  issues: ValidationIssue[],
  path: string,
  message: string,
  expected?: string,
  actual?: unknown,
): void {
  issues.push({ path, message, severity: 'warning', expected, actual });
}

function validatePhaseBlock(
  phaseName: string,
  block: unknown,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const path = `phases.${phaseName}`;
  if (!isObject(block)) {
    pushError(
      errors,
      path,
      `phase block must be a mapping, got ${typeof block}`,
      'object',
      block,
    );
    return;
  }
  const status = block.status;
  if (status === undefined) {
    pushError(errors, `${path}.status`, 'phase block missing required `status` field', 'one of: ' + Array.from(PHASE_STATUSES).join(', '));
  } else if (typeof status !== 'string' || !PHASE_STATUSES.has(status)) {
    pushError(
      errors,
      `${path}.status`,
      `phase status is not a recognized value`,
      'one of: ' + Array.from(PHASE_STATUSES).join(', '),
      status,
    );
  }
  if (status === 'done' && block.completed_at === undefined) {
    pushWarning(
      warnings,
      `${path}.completed_at`,
      '`status: done` phase has no `completed_at` timestamp',
      'ISO timestamp string',
    );
  }
  if (block.verdict !== undefined && typeof block.verdict !== 'string') {
    pushError(
      errors,
      `${path}.verdict`,
      'verdict must be a string when present',
      'string',
      block.verdict,
    );
  }
  if (
    block.summary_artifact !== undefined &&
    typeof block.summary_artifact !== 'string'
  ) {
    pushError(
      errors,
      `${path}.summary_artifact`,
      'summary_artifact must be a string (Drive fileId) when present',
      'string',
      block.summary_artifact,
    );
  }
  if (block.steps !== undefined) {
    if (!isObject(block.steps)) {
      pushError(
        errors,
        `${path}.steps`,
        'steps must be a mapping when present',
        'object',
        block.steps,
      );
    } else {
      for (const [stepName, stepBlock] of Object.entries(block.steps)) {
        validateStepBlock(
          phaseName,
          stepName,
          stepBlock,
          errors,
          warnings,
        );
      }
    }
  }
}

function validateStepBlock(
  phaseName: string,
  stepName: string,
  block: unknown,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const path = `phases.${phaseName}.steps.${stepName}`;
  if (!isObject(block)) {
    pushError(
      errors,
      path,
      `step block must be a mapping, got ${typeof block}`,
      'object',
      block,
    );
    return;
  }
  const status = block.status;
  if (status !== undefined) {
    if (typeof status !== 'string' || !STEP_STATUSES.has(status)) {
      pushError(
        errors,
        `${path}.status`,
        `step status is not a recognized value`,
        'one of: ' + Array.from(STEP_STATUSES).join(', '),
        status,
      );
    }
  }
  const isDone = status === 'done' || status === 'complete';
  if (isDone && block.artifact === undefined) {
    // Per § Phase Write-Back Contract — "artifact is required on every
    // status: done step". Renders as an unfilled circle in ace-web and
    // breaks the Producer Artifact Verifier.
    pushWarning(
      warnings,
      `${path}.artifact`,
      '`status: done` step has no `artifact` field (ace-web renders as unfilled circle; Producer Artifact Verifier cannot check)',
      'relative artifact path',
    );
  }
  if (isDone && block.file_id === undefined) {
    pushWarning(
      warnings,
      `${path}.file_id`,
      '`status: done` step has no `file_id` field (Drive lookup unavailable)',
      'Drive file ID string',
    );
  }
  if (block.verdict !== undefined && typeof block.verdict !== 'string') {
    pushError(
      errors,
      `${path}.verdict`,
      'verdict must be a string when present',
      'string',
      block.verdict,
    );
  }
  if (block.artifact !== undefined && typeof block.artifact !== 'string') {
    pushError(
      errors,
      `${path}.artifact`,
      'artifact must be a string (relative path) when present',
      'string',
      block.artifact,
    );
  }
  if (block.file_id !== undefined && typeof block.file_id !== 'string') {
    pushError(
      errors,
      `${path}.file_id`,
      'file_id must be a string (Drive fileId) when present',
      'string',
      block.file_id,
    );
  }
}

/**
 * Validate a parsed `run_state.yaml` object against the Phase Write-Back
 * Contract.
 *
 * Callers pass the result of `YAML.parse(contents)`. Empty/null files
 * parse to `null` (valid YAML for an empty doc) — the validator treats
 * that as "no blocks present yet" and returns valid=true with no errors.
 * That matches the orchestrator's expectation at run-init (run_state.yaml
 * exists but no phase has written yet).
 */
export function validateRunState(parsed: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (parsed === null || parsed === undefined) {
    // Empty run_state.yaml — legal at run-init before any phase writes.
    return { valid: true, errors, warnings };
  }
  if (!isObject(parsed)) {
    pushError(
      errors,
      '',
      `top-level run_state.yaml must be a mapping, got ${typeof parsed}`,
      'object',
      parsed,
    );
    return { valid: false, errors, warnings };
  }

  // `phases` is optional at run-init but if present must be an object.
  if (parsed.phases !== undefined) {
    if (!isObject(parsed.phases)) {
      pushError(
        errors,
        'phases',
        'phases must be a mapping when present',
        'object',
        parsed.phases,
      );
    } else {
      for (const [phaseName, phaseBlock] of Object.entries(parsed.phases)) {
        validatePhaseBlock(phaseName, phaseBlock, errors, warnings);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Convenience: validate AND give the orchestrator a one-line answer to
 * "did this phase write its block correctly?" The orchestrator's silent-
 * dispatch retry (§ Auto-retry silent Agent dispatches) can use this to
 * decide whether to re-dispatch.
 *
 * Returns one of:
 *   - 'ok'              — block exists, status is `done`, no errors
 *   - 'missing'         — no `phases.<name>` block at all
 *   - 'in_progress'     — block exists but status is in_progress/pending
 *   - 'error'           — block exists with status: error
 *   - 'blocked'         — block exists with status: blocked (operator-actionable halt)
 *   - 'skipped'         — block exists with status: skipped (run-shape decision —
 *                          phase intentionally not run this run; terminal, never retried)
 *   - 'malformed'       — block exists but validateRunState found errors
 *
 * The orchestrator silent-retry triggers on 'missing', 'in_progress',
 * and 'malformed' (the agent claimed success but didn't write properly).
 * 'error', 'blocked', and 'skipped' are terminal and should surface/step-over,
 * not retry —
 * 'blocked' specifically means the phase stopped on an operator-actionable
 * precondition (e.g. consumed one-way state) rather than a hard crash, so the
 * orchestrator should report it (and any remediation) instead of re-dispatching.
 */
export type PhaseWriteBackStatus =
  | 'ok'
  | 'missing'
  | 'in_progress'
  | 'error'
  | 'blocked'
  | 'skipped'
  | 'malformed';

export function classifyPhaseWriteBack(
  parsed: unknown,
  phaseName: string,
): PhaseWriteBackStatus {
  if (!isObject(parsed)) return 'missing';
  const phases = parsed.phases;
  if (!isObject(phases)) return 'missing';
  const block = phases[phaseName];
  if (block === undefined) return 'missing';
  const result = validateRunState({ phases: { [phaseName]: block } });
  if (!result.valid) return 'malformed';
  if (!isObject(block)) return 'malformed';
  const status = block.status;
  if (status === 'done' || status === 'complete') return 'ok';
  if (status === 'error') return 'error';
  if (status === 'blocked') return 'blocked';
  if (status === 'skipped') return 'skipped';
  return 'in_progress';
}

// ── iterate-state.yaml (CLIENT-ONLY loop log) ──────────────────────────────
// Read by /ace:iterate --resume. The server-side first-class run NEVER reads
// or writes this file (see docs/superpowers/specs/2026-06-01-ace-iterate-loop-design.md).

const ITERATE_RUNNERS = new Set(['web', 'local']);
const ITERATE_VERDICTS = new Set(['clean', 'dirty']);

export interface IterateIteration {
  run_id: string;
  verdict: 'clean' | 'dirty';
  failure_class?: string;
  fix_pr?: string;
  version_at_run?: string;
  started_at?: string;
}

export interface IterateState {
  opp: string;
  target_phases: number[];
  golden_run_id: string;
  runner: 'web' | 'local';
  plugin_version?: string;
  streak: number;
  required_streak: number;
  caps?: { per_failure_class_fix?: number; max_iterations?: number };
  kill?: boolean;
  iterations: IterateIteration[];
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Validate `iterate-state.yaml` — the CLIENT-ONLY loop log read by
 * `/ace:iterate --resume`. Null/undefined is valid (fresh state before the
 * first write). The server-side run never reads or writes this file.
 */
export function validateIterateState(parsed: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (parsed === null || parsed === undefined) {
    return { valid: true, errors, warnings };
  }
  if (!isObject(parsed)) {
    pushError(
      errors,
      '',
      `iterate-state.yaml must be a mapping, got ${typeof parsed}`,
      'object',
      parsed,
    );
    return { valid: false, errors, warnings };
  }

  if (typeof parsed.opp !== 'string' || parsed.opp.length === 0) {
    pushError(errors, 'opp', 'opp must be a non-empty string', 'string', parsed.opp);
  }
  if (typeof parsed.golden_run_id !== 'string' || parsed.golden_run_id.length === 0) {
    pushError(
      errors,
      'golden_run_id',
      'golden_run_id must be a non-empty string',
      'string',
      parsed.golden_run_id,
    );
  }
  if (typeof parsed.runner !== 'string' || !ITERATE_RUNNERS.has(parsed.runner)) {
    pushError(
      errors,
      'runner',
      `runner must be one of ${[...ITERATE_RUNNERS].join(', ')}`,
      'enum',
      parsed.runner,
    );
  }
  if (!isInt(parsed.streak) || (parsed.streak as number) < 0) {
    pushError(errors, 'streak', 'streak must be a non-negative integer', 'integer', parsed.streak);
  }
  if (!isInt(parsed.required_streak) || (parsed.required_streak as number) < 1) {
    pushError(
      errors,
      'required_streak',
      'required_streak must be a positive integer',
      'integer',
      parsed.required_streak,
    );
  }
  if (
    !Array.isArray(parsed.target_phases) ||
    parsed.target_phases.length === 0 ||
    !parsed.target_phases.every(isInt)
  ) {
    pushError(
      errors,
      'target_phases',
      'target_phases must be a non-empty array of integers',
      'array',
      parsed.target_phases,
    );
  }

  if (parsed.iterations !== undefined) {
    if (!Array.isArray(parsed.iterations)) {
      pushError(errors, 'iterations', 'iterations must be an array when present', 'array', parsed.iterations);
    } else {
      parsed.iterations.forEach((it, i) => {
        const p = `iterations[${i}]`;
        if (!isObject(it)) {
          pushError(errors, p, 'iteration entry must be a mapping', 'object', it);
          return;
        }
        if (typeof it.run_id !== 'string' || it.run_id.length === 0) {
          pushError(errors, `${p}.run_id`, 'run_id must be a non-empty string', 'string', it.run_id);
        }
        if (typeof it.verdict !== 'string' || !ITERATE_VERDICTS.has(it.verdict)) {
          pushError(
            errors,
            `${p}.verdict`,
            `verdict must be one of ${[...ITERATE_VERDICTS].join(', ')}`,
            'enum',
            it.verdict,
          );
        }
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
