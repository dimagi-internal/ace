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

/**
 * The LLO handover record, as the README renders it.
 *
 * Exists because the handover was previously readable only by opening
 * `run_state.yaml` and knowing where to look. On
 * turmeric-market-study/20260914-1742 it was not even there — the fields had no
 * typed home, so they landed in an invented top-level `llo_handover` key that
 * no consumer read. Surfacing them in the README keeps them as usable as that
 * ad-hoc block was, now that they live nested under `selected_llo`.
 */
export interface LloHandover {
  org_slug?: string;
  org_display_name?: string;
  contact_email?: string;
  contact_name?: string;
  source?: string;
  program_application_id?: string;
  opportunity_id?: string;
  opportunity_url?: string;
  email_thread_id?: string;
  email_message_ids?: string[];
}

/**
 * Pull the `selected_llo` block out of a parsed `run_state.yaml`, or `null`
 * when the run has not selected an LLO. Tolerates the whole block being absent,
 * which is the normal state for every run before Phase 8/9.
 */
export function lloHandoverFromRunState(runState: unknown): LloHandover | null {
  const block = (runState as any)?.phases?.['solicitation-management']?.products?.selected_llo;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  // An empty object, or one carrying only nulls, is not a handover.
  const hasValue = Object.values(block).some(
    (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
  );
  return hasValue ? (block as LloHandover) : null;
}

/** Render the § LLO handover section, or '' when there is nothing to show. */
function renderLloHandover(llo: LloHandover | null): string {
  if (!llo) return '';
  const rows: Array<[string, string | undefined]> = [
    ['Organisation', llo.org_display_name ?? llo.org_slug],
    ['Connect slug', llo.org_slug],
    ['Selected via', llo.source ?? 'solicitation'],
    ['Contact', [llo.contact_name, llo.contact_email].filter(Boolean).join(' — ') || undefined],
    ['Program application', llo.program_application_id],
    ['Opportunity', llo.opportunity_url ?? llo.opportunity_id],
    ['Email thread', llo.email_thread_id],
    [
      'Messages sent',
      llo.email_message_ids?.length ? String(llo.email_message_ids.length) : undefined,
    ],
  ];
  const present = rows.filter(([, v]) => v !== undefined && v !== '');
  if (present.length === 0) return '';
  let out = `\n---\n\n## LLO handover\n\n| Field | Value |\n|---|---|\n`;
  for (const [label, value] of present) out += `| ${label} | ${value} |\n`;
  // `program_application_id` is the one that cannot be re-derived:
  // `connect_list_invites` returns `[]` even for an accepted invite.
  out += `\nFull record: \`run_state.yaml\` → \`phases.solicitation-management.products.selected_llo\`.\n`;
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
  opts: { lloHandover?: LloHandover | null } = {},
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

  body += renderLloHandover(opts.lloHandover ?? null);
  body += `\n---\n\n**Run state:** \`run_state.yaml\` (in this folder)\n**Latest cross-run truth:** \`../current/\` (shortcuts under the opp root)\n`;
  return body;
}
