/**
 * Write-time guard for the one claim a phase block makes that nothing could
 * check: `phases.<phase>.status: done`.
 *
 * ## Why this exists — ace#2174, the regression of ace#892
 *
 * ace#892 ("commcare-setup reports done/pass while deferring app-test-cases")
 * was closed COMPLETED on 2026-07-25 by commit `039c0bdd`. That commit shipped
 * exactly two things:
 *
 *   1. a paragraph in `agents/commcare-setup.md` telling the phase agent not to
 *      write `status: done` / `verdict: pass` over a skipped producer, and
 *   2. two `required: true` rows in `lib/artifact-manifest.ts`
 *      (`3-commcare/recipes/journey-learn.yaml` + `journey-deliver.yaml`).
 *
 * Neither is executable. The only test it landed added `'recipes'` to
 * `STRUCTURAL_SUB_FOLDERS` in `test/lib/artifact-manifest-lint.test.ts` — that
 * exists so the NEW manifest rows pass lint, and it asserts nothing whatsoever
 * about enforcement. So the class was documented, never ratcheted, and on
 * `poverty-graduation/20260905-1345` Phase 3 wrote `status: done` /
 * `verdict: pass` with 9 of its 10 required artifacts absent from Drive. The
 * run then burned Phases 4 and 5 — including a one-way Connect opportunity —
 * before Phase 6's pre-flight halted on the missing Learn smoke recipe, which
 * is the exact failure ace#892's own manifest row says must not happen:
 *
 *   > "Phase 6's pre-flight hard-halts without it — Learn capture is the floor
 *   > — so its absence must fail the Phase 3 fence, not surface first at
 *   > Phase 6 (ace#892)."
 *
 * ## Why the guard is here and not in the boundary fence
 *
 * The READ-side checks were never the gap. `verify_phase_artifacts` reported
 * `ok: false, present_count: 1, expected_count: 10` on that very run — it was
 * right, and nothing acted on it, because acting on it is prose in
 * `agents/ace-orchestrator.md` that an orchestrator executes or does not. A
 * second read-side report would have the same failure mode as the first.
 *
 * So the check moves to the WRITE. The lie cannot be recorded in the first
 * place: `update_yaml_file` refuses a patch that flips a phase to a
 * terminal-complete status while that phase's manifest-required artifacts are
 * missing from the run folder. Same shape, and same reasoning, as the
 * unconditional status-enum guard that already sits beside it (ace#992):
 *
 *   > "UNCONDITIONAL, not opt-in via validateAs. An opt-in guard cannot fix
 *   > this class: the agent that does not know the enum is exactly the agent
 *   > that will not pass the flag."
 *
 * ## It is a rail, not a halt
 *
 * The refusal is typed and it names both legal ways forward, so an autonomous
 * run self-corrects in the same turn with no human in the loop:
 *
 *   - ship the missing artifacts (each `missing[]` entry carries the
 *     `producedBy` skill to dispatch), or
 *   - write `status: partial` with a verdict naming the gap
 *     (`agents/orchestrator-reference.md § `partial`: a phase that shipped but
 *     parked something`). `partial` is TERMINAL and does not halt downstream
 *     phases — it is the honest write-back the Phase Write-Back Contract has
 *     mandated all along, and it is deliberately NOT guarded here.
 *
 * Only `done` and `complete` are guarded. `partial`, `in_progress`, `pending`,
 * `error`, `blocked` and `skipped` all write unimpeded.
 *
 * This module is PURE — no I/O. The Drive enumeration lives at the call site in
 * `mcp/google-drive-server.ts`, which reuses the very same
 * `verifyPhaseArtifacts` the boundary fence uses, so the write-time gate and
 * the read-time fence can never disagree about what "required" means.
 */

import type { Phase } from './artifact-manifest.js';
import { normalizePhaseKey } from './artifact-manifest.js';
import type { PhaseCloseoutReport } from './phase-closeout.js';

/**
 * Phase statuses that assert the phase FINISHED AND SHIPPED EVERYTHING.
 *
 * `complete` is here because it is an accepted legacy synonym for `done` at
 * phase level (ace#992/#1151) — a guard that covered only `done` would be
 * bypassed by the spelling the validator already tolerates.
 *
 * `partial` is deliberately ABSENT: it is the escape hatch this guard points
 * at, and guarding it would leave a phase with a parked producer no legal
 * terminal status at all.
 */
export const TERMINAL_COMPLETE_PHASE_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'complete',
]);

export interface TerminalPhaseWrite {
  /** The run_state key as written, e.g. `commcare-setup`. */
  phaseName: string;
  /** The manifest short key the artifact fence speaks, e.g. `commcare`. */
  phaseKey: Phase;
  /** The terminal-complete status this patch writes (`done` | `complete`). */
  status: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Which phases does this patch flip to a terminal-complete status?
 *
 * Reads the PATCH, so it is merge-mode agnostic — `shallow`, `two-level` and
 * `deep` all carry `status` at `phases.<name>.status`. A patch with no
 * `phases` key (opp.yaml, decisions.yaml, iterate state) returns `[]`, which
 * is what makes the guard free on every write that is not a phase write-back.
 *
 * A phase name in neither key-space (`normalizePhaseKey` returns undefined) is
 * skipped rather than rejected: naming the phase is not this guard's contract,
 * and the status-enum guard beside it already owns malformed write-backs.
 */
export function terminalPhaseWritesIn(patch: unknown): TerminalPhaseWrite[] {
  if (!isPlainObject(patch)) return [];
  const phases = patch.phases;
  if (!isPlainObject(phases)) return [];

  const out: TerminalPhaseWrite[] = [];
  for (const [phaseName, block] of Object.entries(phases)) {
    if (!isPlainObject(block)) continue;
    const status = block.status;
    if (typeof status !== 'string') continue;
    if (!TERMINAL_COMPLETE_PHASE_STATUSES.has(status)) continue;
    const phaseKey = normalizePhaseKey(phaseName);
    if (!phaseKey) continue;
    out.push({ phaseName, phaseKey, status });
  }
  return out;
}

/**
 * The phase run MODE to evaluate the required set against, taken from the
 * MERGED document rather than the patch alone.
 *
 * A patch that writes `{status: done}` and nothing else still has to honour a
 * `mode` written by an earlier patch — Phase 6's `app-QA-only` drops eleven
 * training artifacts from the required set (ace#1069), and reading only the
 * patch would re-require every one of them and refuse a legitimate write.
 */
export function phaseModeFromMerged(
  merged: unknown,
  phaseName: string,
): string | undefined {
  if (!isPlainObject(merged)) return undefined;
  const phases = merged.phases;
  if (!isPlainObject(phases)) return undefined;
  const block = phases[phaseName];
  if (!isPlainObject(block)) return undefined;
  return typeof block.mode === 'string' ? block.mode : undefined;
}

/** How many `missing[]` entries the refusal spells out before it truncates. */
const MAX_LISTED_MISSING = 12;

/**
 * The typed refusal. It names the phase, the count, every missing path with the
 * skill that produces it, and BOTH legal ways forward — because an agent that
 * reads only "refused" retries the identical write, and an agent that reads
 * only "ship the artifacts" has no move when the artifact genuinely cannot be
 * produced this run.
 */
export function formatIncompleteTerminalWriteBack(
  write: TerminalPhaseWrite,
  report: PhaseCloseoutReport,
): string {
  const shown = report.missing.slice(0, MAX_LISTED_MISSING);
  const rest = report.missing.length - shown.length;
  const list =
    shown.map((m) => `${m.path} (producedBy: ${m.producedBy})`).join('; ') +
    (rest > 0 ? `; +${rest} more` : '');

  return (
    `PHASE_ARTIFACTS_INCOMPLETE: phases.${write.phaseName}.status = "${write.status}" claims the phase ` +
    `finished, but ${report.missing.length} of its ${report.expected_count} manifest-required artifacts ` +
    `are absent from the run folder — missing: ${list}. NO DRIVE WRITE HAPPENED. ` +
    `Two legal ways forward: (1) ship them — dispatch each producedBy skill, then retry this write; or ` +
    `(2) write \`status: partial\` with a verdict naming the gap (e.g. partial-producer-deferred) plus a ` +
    `status_note, which is TERMINAL and does not halt downstream phases ` +
    `(agents/orchestrator-reference.md § \`partial\`). ` +
    `Required-ness is declared in lib/artifact-manifest.ts and is the same set the boundary fence's ` +
    `verify_phase_artifacts reports. ace#2174 (regression of ace#892).`
  );
}
