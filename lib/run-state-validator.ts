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
  'complete', // legacy synonym for `done` — accepted at BOTH levels since 0.13.7xx
              // (ace#992). Was step-only, which made the same literal string
              // simultaneously accepted (verify_phase_products), accepted
              // (step level) and rejected (phase level) — one run got
              // `ok: true` from two fences and `malformed` from the third.
              // Canonical remains `done`; writing `complete` emits a warning.
  'partial',  // TERMINAL: the phase finished and its downstream-facing typed
              // handoff (`products`) is final, but at least one declared
              // producer or `-eval` step did not ship. The gap is named in
              // `verdict` (e.g. `partial-producer-deferred`) and the parked
              // step carries `incomplete` / `partial` / `deferred`. This is the
              // value the phase docs' verdict-gate rule mandates (ace#1139);
              // it is NOT a retry trigger — see `classifyPhaseWriteBack`.
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
  'partial',  // synonym of `incomplete` at step level. A phase agent told to
              // write `status: partial` on the phase reaches for the same word
              // on the parked step; both mean "shipped some of its declared
              // artifacts, not all". Canonical at step level is `incomplete`.
  'skipped',
  'deferred',
]);

/**
 * Statuses that mean "this phase is finished — do not re-dispatch it".
 * `done` is canonical; `complete` is the accepted legacy synonym; `partial`
 * is finished-with-a-declared-gap. `error` / `blocked` / `skipped` are also
 * terminal but carry their own classifications (halt / surface / step over).
 */
const TERMINAL_OK_STATUSES = new Set(['done', 'complete', 'partial']);

/**
 * Non-canonical status spellings that are accepted for compatibility. Writing
 * one is valid but earns a warning naming the canonical value, so runs
 * converge on one vocabulary instead of accumulating synonyms silently.
 */
const LEGACY_STATUS_SYNONYMS: Record<string, string> = {
  complete: 'done',
};

/** The legal `phases.<phase>.status` values, in declaration order. */
export const PHASE_STATUS_VALUES: readonly string[] = Array.from(PHASE_STATUSES);

/** The legal `phases.<phase>.steps.<step>.status` values, in declaration order. */
export const STEP_STATUS_VALUES: readonly string[] = Array.from(STEP_STATUSES);

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
  if (typeof status === 'string' && LEGACY_STATUS_SYNONYMS[status]) {
    pushWarning(
      warnings,
      `${path}.status`,
      `\`${status}\` is a legacy synonym — write \`${LEGACY_STATUS_SYNONYMS[status]}\` (accepted so an older run does not classify as malformed)`,
      LEGACY_STATUS_SYNONYMS[status],
      status,
    );
  }
  if (
    typeof status === 'string' &&
    TERMINAL_OK_STATUSES.has(status) &&
    block.completed_at === undefined
  ) {
    pushWarning(
      warnings,
      `${path}.completed_at`,
      `\`status: ${status}\` phase has no \`completed_at\` timestamp`,
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
      // `file_id` is collected and reported ONCE PER PHASE. It is a real ask —
      // ace-web needs a Drive id to link, the per-step verifier needs
      // something to check, and it is nearly free at the source (every skill
      // already holds the `drive_create_doc_from_markdown` response, which
      // returns exactly that id, and discards it). But 18 identical warnings
      // train a reader to skip the list, and a validator whose warning list is
      // always that long leaves a genuinely new warning nowhere to be seen
      // (ace#1293).
      const missingFileId: string[] = [];
      for (const [stepName, stepBlock] of Object.entries(block.steps)) {
        validateStepBlock(
          phaseName,
          stepName,
          stepBlock,
          errors,
          warnings,
          missingFileId,
        );
      }
      if (missingFileId.length > 0) {
        pushWarning(
          warnings,
          `${path}.steps.file_id`,
          `${missingFileId.length} \`status: done\` step(s) carry no \`file_id\` (${missingFileId.join(', ')}) — ` +
            'Drive lookup unavailable, so ace-web cannot link the artifact. The id is free at the ' +
            'source: it is the `id` the create call already returned',
          'Drive file ID string per step',
        );
      }
    }
  }
}

/**
 * Does this step point at an artifact under ANY of the names the contract
 * models? `artifact` is the canonical key; `summary_artifact`,
 * `verdict_artifact` and `catalog_artifact` are what producers actually write,
 * and the suffix rule covers the next sibling without another patch here
 * (ace#1293).
 */
function hasArtifactPointer(block: Record<string, unknown>): boolean {
  return Object.entries(block).some(
    ([k, v]) => (k === 'artifact' || k.endsWith('_artifact')) && typeof v === 'string' && v.length > 0,
  );
}

function validateStepBlock(
  phaseName: string,
  stepName: string,
  block: unknown,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  missingFileId: string[] = [],
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
  if (typeof status === 'string' && LEGACY_STATUS_SYNONYMS[status]) {
    pushWarning(
      warnings,
      `${path}.status`,
      `\`${status}\` is a legacy synonym — write \`${LEGACY_STATUS_SYNONYMS[status]}\` (accepted so an older run does not classify as malformed)`,
      LEGACY_STATUS_SYNONYMS[status],
      status,
    );
  }
  // `partial` / `incomplete` steps shipped only some of their declared
  // artifacts, so the `artifact`/`file_id` requirement does not apply to them —
  // the phase's `verdict` names the gap instead.
  const isDone = status === 'done' || status === 'complete';
  if (isDone && !hasArtifactPointer(block)) {
    // ANY `*_artifact` key counts (dimagi-internal/ace#1293). What skills and
    // agent docs consistently write is `summary_artifact` / `verdict_artifact`
    // / `catalog_artifact` — the shape every SKILL.md Products section and
    // every write-back example in `agents/orchestrator-reference.md` models.
    // Demanding a differently-named bare `artifact` was the validator
    // inventing a shape nothing was told to produce, which is why the miss was
    // 100% uniform (18 of 18 steps on a run with zero errors) rather than
    // sporadic.
    pushWarning(
      warnings,
      `${path}.artifact`,
      '`status: done` step points at no artifact — set `artifact`, or any `*_artifact` key ' +
        '(summary_artifact / verdict_artifact / catalog_artifact). ace-web renders an unfilled ' +
        'circle and the Producer Artifact Verifier cannot check',
      'relative artifact path',
    );
  }
  if (isDone && block.file_id === undefined) missingFileId.push(stepName);
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
 *   - 'ok'              — block exists, well-formed, and TERMINAL-COMPLETE:
 *                          status is `done`, the legacy synonym `complete`, or
 *                          `partial` (finished with a declared, named gap).
 *                          Nothing to re-dispatch.
 *   - 'missing'         — no `phases.<name>` block at all
 *   - 'in_progress'     — block exists but status is in_progress/pending
 *   - 'error'           — block exists with status: error
 *   - 'blocked'         — block exists with status: blocked (operator-actionable halt)
 *   - 'skipped'         — block exists with status: skipped (run-shape decision —
 *                          phase intentionally not run this run; terminal, never retried)
 *   - 'malformed'       — block exists but validateRunState found errors
 *
 * This classifier answers "did the phase write its block correctly, or do I
 * re-dispatch it?" — NOT "was the phase any good". A `done` phase with
 * `verdict: fail` has always returned 'ok'; a `partial` phase (ace#1139)
 * returns 'ok' for the same reason: the write-back is correct and the phase
 * is finished, and re-running it would not un-park the parked producer.
 * Quality lives in `verdict`; the parked ARTIFACTS surface through
 * `verify_phase_artifacts`, and the typed handoff through
 * `verify_phase_products` (which still runs its STRICT completeness check on a
 * `partial` phase — `partial` may park artifacts, never the `products` handoff).
 * Deliberately NOT a new return value: the atom description in
 * `mcp/google-drive-server.ts`, `agents/ace-orchestrator.md`'s boundary-fence
 * branch table, and `agents/iterate-loop.md` all enumerate this return set, so
 * a new member would silently become the next contract that disagrees with
 * itself — the exact class ace#1139/#992 are about.
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
  if (typeof status === 'string' && TERMINAL_OK_STATUSES.has(status)) return 'ok';
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
  /**
   * Informational only. Recorded so a run can be attributed to a version; it is
   * NOT a gate. The old loop counted a streak "against" this field and zeroed
   * the streak whenever it changed — see `lib/iterate-health.ts` for why that
   * made the exit condition unreachable.
   */
  plugin_version?: string;
  /** Rolling window size (default 10). Health is read over the last N runs. */
  window?: number;
  /** Rolling pass-rate target in (0,1] (default 0.8). */
  pass_target?: number;
  /**
   * LEGACY, optional. Streak is now DERIVED from `iterations[]` by
   * `computeIterateHealth` and must not be trusted from the file — a stored
   * counter is exactly what the merge path used to zero. Retained so existing
   * state files still load.
   */
  streak?: number;
  /** LEGACY, optional. Superseded by `window` + `pass_target`. */
  required_streak?: number;
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
  // `streak` / `required_streak` are LEGACY and optional. Health is derived
  // from `iterations[]` (lib/iterate-health.ts); a stored streak is the field
  // the autofix path used to zero, which made the old exit condition
  // unreachable. Still type-checked when present so a malformed legacy file is
  // caught, and warned on so the loop knows to ignore it.
  if (parsed.streak !== undefined) {
    if (!isInt(parsed.streak) || (parsed.streak as number) < 0) {
      pushError(errors, 'streak', 'streak must be a non-negative integer', 'integer', parsed.streak);
    } else {
      pushWarning(
        warnings,
        'streak',
        'streak is legacy and ignored — health is derived from iterations[] by computeIterateHealth',
        'absent',
        parsed.streak,
      );
    }
  }
  if (parsed.required_streak !== undefined) {
    if (!isInt(parsed.required_streak) || (parsed.required_streak as number) < 1) {
      pushError(
        errors,
        'required_streak',
        'required_streak must be a positive integer',
        'integer',
        parsed.required_streak,
      );
    } else {
      pushWarning(
        warnings,
        'required_streak',
        'required_streak is legacy — use window + pass_target (rolling window)',
        'absent',
        parsed.required_streak,
      );
    }
  }
  if (parsed.window !== undefined && (!isInt(parsed.window) || (parsed.window as number) < 2)) {
    pushError(errors, 'window', 'window must be an integer >= 2', 'integer', parsed.window);
  }
  if (
    parsed.pass_target !== undefined &&
    (typeof parsed.pass_target !== 'number' ||
      !Number.isFinite(parsed.pass_target) ||
      parsed.pass_target <= 0 ||
      parsed.pass_target > 1)
  ) {
    pushError(
      errors,
      'pass_target',
      'pass_target must be a number in (0, 1]',
      'number',
      parsed.pass_target,
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

/**
 * How is this status string spelled, relative to the closed enum?
 *
 * Extracted for the WRITE-TIME guard (dimagi-internal/ace#992). The read-time
 * fences already classify a whole `run_state.yaml`; this answers the narrower
 * question a single patch needs, so `mcp/google-drive-server.ts` holds no
 * vocabulary of its own — the enum lives here and nowhere else.
 *
 * - `canonical`      — in the enum, and the preferred spelling
 * - `legacy-synonym` — tolerated, warned about, MUST NOT be rejected. #1151
 *   deliberately made `complete` legal; rejecting it would re-open ace#992
 *   from the opposite side.
 * - `unknown`        — not in the enum at all. The enum is closed.
 */
export function classifyStatusSpelling(
  level: 'phase' | 'step',
  value: string,
): 'canonical' | 'legacy-synonym' | 'unknown' {
  const values = level === 'phase' ? PHASE_STATUS_VALUES : STEP_STATUS_VALUES;
  if (!(values as readonly string[]).includes(value)) return 'unknown';
  return Object.prototype.hasOwnProperty.call(LEGACY_STATUS_SYNONYMS, value)
    ? 'legacy-synonym'
    : 'canonical';
}
