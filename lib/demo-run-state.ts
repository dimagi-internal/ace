/**
 * Builder for the minimal, structural `run_state.yaml` a standalone
 * `/ace:demo` run needs.
 *
 * A demo is just a run with ONE live phase — `synthetic-data-and-workflows`
 * — and every other pipeline phase marked `skipped` (a run-shape decision,
 * per `docs/learnings/2026-06-01-seeded-run-structural-not-flags.md`: the run
 * shape lives in `run_state.yaml.phases.*.status`, never in a `/ace:demo` flag
 * the model might drop). Reusing the Phase Write-Back Contract this way means
 * `/ace:status`, the `-eval` rubrics, and `opp-eval` all keep working on a demo
 * with zero new plumbing.
 *
 * The emitted object is validated by `lib/run-state-validator.ts`:
 *   - phase `status` must be one of pending|in_progress|done|error|blocked|skipped
 *   - `steps` must be a MAPPING (not an array)
 *   - `verdict` / `summary_artifact` must be omitted (not null) when absent
 *
 * Pure — no I/O. Callers serialize the result to `run_state.yaml`.
 */

import { PHASE_DEFS } from './artifact-manifest.js';

export type DemoProvider = 'denovo' | 'clone' | 'ace-run';

export interface DemoPhaseBlock {
  status: 'in_progress' | 'skipped';
  /** Mapping (never an array) per the Phase Write-Back Contract. */
  steps?: Record<string, unknown>;
  products?: Record<string, unknown>;
}

export interface DemoRunState {
  run_type: 'demo';
  run_id: string;
  demo_name: string;
  created_at: string;
  source: DemoProvider;
  phases: Record<string, DemoPhaseBlock>;
}

/** The one phase a demo run executes. */
export const DEMO_LIVE_PHASE = 'synthetic-data-and-workflows';

/**
 * Build the structural demo run-state. The `phases` map is keyed by the
 * phase-agent name (e.g. `connect-setup`) — the same key-space the
 * orchestrator writes and `/ace:status` reads — derived from PHASE_DEFS so
 * the demo never drifts from the canonical ACE-opp pipeline (ordinals 1–10;
 * the partnership-video phases 11–16 are excluded).
 */
export function buildDemoRunState(opts: {
  demoName: string;
  runId: string;
  source: DemoProvider;
  createdAt: string;
}): DemoRunState {
  const { demoName, runId, source, createdAt } = opts;

  const phases: Record<string, DemoPhaseBlock> = {};
  for (const def of PHASE_DEFS) {
    if (def.ordinal > 10) continue; // ACE-opp pipeline only
    const name = def.agentName;
    if (name === DEMO_LIVE_PHASE) {
      phases[name] = {
        status: 'in_progress',
        steps: {},
        products: { synthetic: { source: { provider: source } } },
      };
    } else {
      phases[name] = { status: 'skipped' };
    }
  }

  return {
    run_type: 'demo',
    run_id: runId,
    demo_name: demoName,
    created_at: createdAt,
    source,
    phases,
  };
}
