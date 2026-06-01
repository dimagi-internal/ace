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
 *   - skipped      — phase explicitly skipped (e.g. --no-evals, no template)
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

export type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

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
