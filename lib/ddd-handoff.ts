/**
 * Phase 7's DDD hand-off: where a run is between "Phase 7 built its products"
 * and "the canopy DDD loop has ended and Phase 7 has written it back".
 *
 * ## Why the orchestrator owns the DDD loop
 *
 * Phase 7 used to dispatch `Agent(canopy:ddd)` itself and then wait on it. A
 * subagent cannot simply idle, so it kept itself alive with foreground sleeps
 * past the 5-minute prompt-cache window — `perl -e 'select(undef,undef,undef,540..595)'`
 * seven times on `noora-health/20261015-1129` (22:33 → 01:12, a 2.7 h loop), then
 * twice more (300 s, 420 s) on a preview-capture child — each wake re-writing the
 * phase agent's whole context into a cold cache. The
 * phase's own products (registry, data, dashboards, coach, narrative) were
 * finished before the loop started; only the loop's ending and the
 * post-render steps (3.9 promote, 3.95 previews, 4 write-back, 4.5 previews)
 * depend on it.
 *
 * So `/ace:run` splits Phase 7 into two dispatches of the same agent with the
 * loop between them, run by the orchestrator (the top-level session, which a
 * background task's completion notification DOES resume — no polling at all):
 *
 *   1. `Agent(synthetic-data-and-workflows)` — build. Steps 0 → 3.1, then writes
 *      `products.synthetic.ddd_handoff` (the prepared canopy:ddd dispatch) and
 *      returns with `status: in_progress`.
 *   2. `Agent(canopy:ddd)` — dispatched by the orchestrator from the hand-off;
 *      it waits on the completion notification, then records the loop's ending
 *      (`products.synthetic.ddd_run_id` + `ddd_terminal_status`) so a session
 *      that dies here resumes at finalize, not at a second loop.
 *   3. `Agent(synthetic-data-and-workflows)` with `mode: finalize` — reads the
 *      DDD run's ending and runs Steps 3.9 → 4.5, flipping `status: done`.
 *
 * `in_progress` is exactly what `classifyPhaseWriteBack` calls a silent failure
 * (it deliberately has no new return value — see its docstring), so the
 * orchestrator MUST ask this module first: an `in_progress` Phase 7 carrying a
 * hand-off is waiting on the loop, not broken, and re-dispatching the build
 * half would redo data generation for nothing.
 *
 * Pure: takes the parsed `phases.synthetic-data-and-workflows` block.
 */

import { dddDirForRunsDir } from './ddd-loop-config.js';

export interface DddHandoff {
  /** Drive file id of `7-synthetic/ddd-dispatch-prompt.md` — the full canopy:ddd prompt. */
  prompt_file_id: string;
  /** `CANOPY_DDD_RUNS_DIR` for this run (`~/.canopy/ddd/runs/ace-<opp>-<run-id>`). */
  runs_dir: string;
  /**
   * `DDD_DIR` for this run (`~/.canopy/ddd/ace-<opp>-<run-id>`) — where canopy reads
   * `config.yaml` (`lib/ddd-loop-config.ts`). Optional in the recorded hand-off:
   * one written before this field existed gets it derived from `runs_dir` by
   * `phase7DddStep`, so an in-flight run is never re-built for lacking it.
   */
  ddd_dir?: string;
  /** The narrative slug the loop renders. */
  narrative_slug: string;
  /** Step 3.1's adoption outcome: a run id to `--resume`, or null for a fresh run. */
  resume_run_id: string | null;
  /** canopy-web workspace every DDD write goes through (ace#2805). */
  workspace: string;
  prepared_at: string;
}

export type Phase7DddStep =
  /** No hand-off recorded: the ordinary phase-dispatch rules apply. */
  | { step: 'build' }
  /** Hand-off recorded, loop not yet ended: dispatch (or resume) `Agent(canopy:ddd)`. */
  | { step: 'dispatch-ddd'; handoff: DddHandoff }
  /** The loop's ending is recorded but the phase is not closed: dispatch finalize. */
  | { step: 'finalize'; handoff: DddHandoff | null }
  /** Terminal phase status — nothing to do. */
  | { step: 'done' }
  /** A hand-off is present but unusable — say which field, never guess. */
  | { step: 'malformed'; reason: string };

const TERMINAL = new Set(['done', 'complete', 'partial', 'skipped', 'error', 'blocked']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Validate a raw `ddd_handoff` value; returns the reason it is unusable, or null. */
export function handoffProblem(raw: unknown): string | null {
  if (!isObject(raw)) return 'ddd_handoff is not a mapping';
  for (const k of ['prompt_file_id', 'runs_dir', 'narrative_slug', 'workspace'] as const) {
    if (!nonEmpty(raw[k])) return `ddd_handoff.${k} is missing or empty`;
  }
  if (raw.ddd_dir !== undefined && raw.ddd_dir !== null && !nonEmpty(raw.ddd_dir)) {
    return 'ddd_handoff.ddd_dir must be a path when present';
  }
  const r = raw.resume_run_id;
  if (r !== null && r !== undefined && !nonEmpty(r)) {
    return 'ddd_handoff.resume_run_id must be a run id or null';
  }
  return null;
}

/**
 * What the orchestrator does next for Phase 7. `block` is
 * `run_state.phases['synthetic-data-and-workflows']` (or undefined).
 */
export function phase7DddStep(block: unknown): Phase7DddStep {
  if (!isObject(block)) return { step: 'build' };
  const status = block.status;
  if (typeof status === 'string' && TERMINAL.has(status)) return { step: 'done' };

  const products = isObject(block.products) ? block.products : {};
  const synthetic = isObject(products.synthetic) ? products.synthetic : {};
  const raw = synthetic.ddd_handoff;
  const ended = nonEmpty(synthetic.ddd_terminal_status);

  if (raw === undefined || raw === null) {
    return ended ? { step: 'finalize', handoff: null } : { step: 'build' };
  }
  const problem = handoffProblem(raw);
  if (problem) return { step: 'malformed', reason: problem };
  const handoff = { resume_run_id: null, ...(raw as object) } as DddHandoff;
  if (!nonEmpty(handoff.ddd_dir)) {
    // Pre-DDD_DIR hand-off: derive it. An unexpected runs_dir shape leaves it
    // unset (the loop then resolves its dir as it did before) rather than
    // failing a hand-off that is otherwise usable — `malformed` re-runs the
    // build half, which regenerates the run's data.
    try {
      handoff.ddd_dir = dddDirForRunsDir(handoff.runs_dir);
    } catch {
      delete handoff.ddd_dir;
    }
  }
  return ended ? { step: 'finalize', handoff } : { step: 'dispatch-ddd', handoff };
}
