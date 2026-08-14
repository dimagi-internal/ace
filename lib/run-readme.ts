/**
 * Generate the README.md index that lives at the root of every run folder.
 *
 * The README is auto-generated at run start (`ace-orchestrator.md`
 * "Starting a New Opportunity" step 7b) and refreshed on every phase
 * completion (§ Per-Phase Folder Lifecycle). It walks `ARTIFACT_MANIFEST`
 * filtered to non-opp-level entries (and excluding placeholder dated
 * paths like `YYYY-MM-DD.md`), groups them by phase folder, and lists
 * each artifact's producing skill plus the current phase status.
 *
 * Status vocabulary:
 *   - pending      — phase has not started
 *   - in-progress  — orchestrator dispatched the phase agent; not done
 *   - done         — phase completed cleanly
 *   - partial      — phase finished with a declared gap (run_state `partial`)
 *   - blocked      — operator-actionable halt
 *   - error        — phase returned a hard error
 *   - skipped      — phase explicitly skipped (e.g. --no-evals, no template)
 *
 * The status map is DERIVED from `run_state.yaml`, never hand-passed: see
 * `phaseStatusFromRunState` below, which `verify_phase_artifacts` calls on
 * every phase boundary so the README refresh cannot be forgotten (ace: the
 * spark-facilitator/20260813-2126 README said `pending` on all 96 rows of a
 * run where 8 phases had completed).
 *
 * See docs/superpowers/specs/2026-05-03-run-folder-readability-design.md
 * for the broader rationale.
 */

import {
  ARTIFACT_MANIFEST,
  PHASES,
  normalizePhaseKey,
  type Phase,
} from './artifact-manifest.js';

export type PhaseStatus =
  | 'pending'
  | 'in-progress'
  | 'done'
  | 'partial'
  | 'blocked'
  | 'error'
  | 'skipped';

/** Every legal README status, in declaration order (drives the atom's enum). */
export const PHASE_README_STATUSES: readonly PhaseStatus[] = [
  'pending',
  'in-progress',
  'done',
  'partial',
  'blocked',
  'error',
  'skipped',
];

/**
 * `run_state.yaml` phase status -> README status.
 *
 * `lib/run-state-validator.ts` owns the run_state vocabulary; this is the
 * projection of it onto the README's column. Unknown values fall back to
 * `pending` rather than throwing — a README is an index, not a gate.
 */
const RUN_STATE_STATUS_MAP: Record<string, PhaseStatus> = {
  pending: 'pending',
  in_progress: 'in-progress',
  'in-progress': 'in-progress',
  done: 'done',
  complete: 'done', // legacy synonym
  partial: 'partial',
  blocked: 'blocked',
  error: 'error',
  skipped: 'skipped',
  deferred: 'skipped',
};

/**
 * Derive the README's per-phase status map straight from a parsed
 * `run_state.yaml`.
 *
 * This exists so no caller has to ASSEMBLE the map — the previous contract
 * ("the boundary fence calls `render_run_readme` with the current phase status
 * map") put both the remembering and the assembling on the orchestrator's
 * prose, and on `spark-facilitator/20260813-2126` neither happened: the run
 * finished 8 phases with a README that still read `pending` on every row.
 * Keys come back as the long phase-agent names used in `run_state.phases.*`;
 * `generateRunReadme` normalizes them.
 */
export function phaseStatusFromRunState(runState: unknown): Partial<Record<string, PhaseStatus>> {
  const out: Partial<Record<string, PhaseStatus>> = {};
  const phases = (runState as any)?.phases;
  if (!phases || typeof phases !== 'object' || Array.isArray(phases)) return out;
  for (const [name, block] of Object.entries(phases as Record<string, any>)) {
    const raw = block?.status;
    if (typeof raw !== 'string') continue;
    const mapped = RUN_STATE_STATUS_MAP[raw];
    if (mapped) out[name] = mapped;
  }
  return out;
}

const OPP_LEVEL_PATHS = new Set<string>([
  'inputs/',
  'opp.yaml',
  'open-questions.md',
  'eval-calibration/known-issues.md',
]);

// Phase-key normalization (short `Phase` keys ⇄ long phase-agent-file
// names) is provided by `normalizePhaseKey` from artifact-manifest.ts —
// the single source of truth for phase identity (jjackson/ace#637). The
// per-file alias map that used to live here was folded into PHASE_DEFS.

/**
 * Render the run-folder README markdown.
 *
 * @param runId The run-id folder name (e.g. `20260503-2128`).
 * @param phaseStatus Per-phase status overrides; phases not present
 *   default to `pending`. Keys may be either internal short `Phase`
 *   keys (`design`, `commcare`, …) or the long phase-agent-file names
 *   the `render_run_readme` atom documents (`idea-to-design`,
 *   `commcare-setup`, …) — both are normalized via `normalizePhaseKey`.
 */
export function generateRunReadme(
  runId: string,
  phaseStatus: Partial<Record<string, PhaseStatus>> = {},
): string {
  // Normalize incoming keys (short Phase keys OR long agent-file names)
  // to short Phase keys so both key-spaces flip their rows. Unknown
  // keys are dropped. (jjackson/ace#637)
  const normalizedStatus: Partial<Record<Phase, PhaseStatus>> = {};
  for (const [key, value] of Object.entries(phaseStatus)) {
    if (value === undefined) continue;
    const phase = normalizePhaseKey(key);
    if (phase) normalizedStatus[phase] = value;
  }
  const rows = ARTIFACT_MANIFEST
    .filter((a) => !OPP_LEVEL_PATHS.has(a.path))
    .filter((a) => !a.path.includes('YYYY-MM-DD'))
    .slice()
    .sort((a, b) => {
      const pi = PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase);
      if (pi !== 0) return pi;
      return a.path.localeCompare(b.path);
    });

  let body = `# Run ${runId}\n\nAuto-generated index of artifacts in this run. The orchestrator updates the Status column as phases complete.\n\n| Phase | Artifact | Producing skill | Status |\n|---|---|---|---|\n`;

  for (const a of rows) {
    const segs = a.path.split('/');
    const phaseFolder = segs[0];
    const filename = segs.slice(1).join('/');
    const status = normalizedStatus[a.phase] ?? 'pending';
    body += `| ${phaseFolder} | ${filename} | ${a.producedBy} | ${status} |\n`;
  }

  body += `\n---\n\n**Run state:** \`run_state.yaml\` (in this folder)\n**Latest cross-run truth:** \`../current/\` (shortcuts under the opp root)\n`;
  return body;
}
