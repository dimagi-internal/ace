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
  'open-questions.md',
  'eval-calibration/known-issues.md',
]);

/**
 * Maps phase-agent-file names (the public key-space used by the
 * `render_run_readme` MCP atom's docs and by `ace-orchestrator.md`) to
 * the internal short `Phase` keys used by `ARTIFACT_MANIFEST`. Only the
 * entries that DIFFER are listed; identity keys
 * (`scenarios-and-acceptance`, `qa-and-training`,
 * `synthetic-data-and-workflows`, `solicitation-management`, `closeout`)
 * resolve via the is-already-a-Phase branch in `normalizePhaseKey`.
 *
 * Without this map, a caller passing the documented long key (e.g.
 * `idea-to-design`) silently no-ops because `generateRunReadme` looks up
 * by short `Phase` key (`design`) — the row stays `pending`. Exactly the
 * four mismatched pairs below (plus `execution-manager`) were the
 * half-pending-render bug (jjackson/ace#637).
 */
const AGENT_NAME_TO_PHASE: Record<string, Phase> = {
  'idea-to-design': 'design',
  'commcare-setup': 'commcare',
  'connect-setup': 'connect',
  'ocs-setup': 'ocs',
  'execution-manager': 'execution-management',
};

const PHASE_KEY_SET = new Set<string>(PHASES);

/**
 * Resolve an incoming phaseStatus key (either an internal short `Phase`
 * key or a long phase-agent-file name) to its short `Phase` key.
 * Returns `undefined` for keys that match neither space.
 */
function normalizePhaseKey(key: string): Phase | undefined {
  if (PHASE_KEY_SET.has(key)) return key as Phase;
  return AGENT_NAME_TO_PHASE[key];
}

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
