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
 *   - 'malformed'       — block exists but validateRunState found errors
 *
 * The orchestrator silent-retry triggers on 'missing', 'in_progress',
 * and 'malformed' (the agent claimed success but didn't write properly).
 * 'error' and 'blocked' are real phase halts that should surface, not retry —
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
  return 'in_progress';
}
