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

import { ARTIFACT_MANIFEST, PHASES, type Phase } from './artifact-manifest.js';

export type PhaseStatus = 'pending' | 'in-progress' | 'done' | 'skipped';

const OPP_LEVEL_PATHS = new Set<string>([
  'inputs/',
  'opp.yaml',
  'connect-state.yaml',
  'open-questions.md',
  'eval-calibration/known-issues.md',
]);

/**
 * Render the run-folder README markdown.
 *
 * @param runId The run-id folder name (e.g. `20260503-2128`).
 * @param phaseStatus Per-phase status overrides; phases not present
 *   default to `pending`.
 */
export function generateRunReadme(
  runId: string,
  phaseStatus: Partial<Record<Phase, PhaseStatus>> = {},
): string {
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
    const status = phaseStatus[a.phase] ?? 'pending';
    body += `| ${phaseFolder} | ${filename} | ${a.producedBy} | ${status} |\n`;
  }

  body += `\n---\n\n**Run state:** \`run_state.yaml\` (in this folder)\n**Latest cross-run truth:** \`../current/\` (shortcuts under the opp root)\n`;
  return body;
}
