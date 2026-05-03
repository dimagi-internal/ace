/**
 * Pure helpers for the multi-run Drive layout introduced in
 * docs/superpowers/specs/2026-05-02-ace-run-multi-run-revival-design.md.
 *
 * No Drive calls; no I/O. Used by the orchestrator to compute paths and
 * by tests to verify path logic without mocking Drive.
 */

export interface OppRef {
  /** Opp slug (folder name under ACE/). Always non-empty. */
  opp: string;
  /** Run-id (folder name under ACE/<opp>/runs/). Null = "fresh run". */
  runId: string | null;
}

/**
 * Format a Date as `YYYYMMDD-HHMM` in local time.
 * Used as a run-id when starting a fresh run.
 *
 * On collision (already-existing folder with the same id), the caller
 * appends `-2`, `-3`, etc. — see ace-orchestrator.md § Starting a New
 * Opportunity step 5.
 */
export function generateRunId(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}`;
}

/**
 * Parse `/ace:run` positional argument into {opp, runId}.
 *
 * Accepts:
 *   - "turmeric"                  → { opp: "turmeric", runId: null }
 *   - "turmeric/20260502-1830"    → { opp: "turmeric", runId: "20260502-1830" }
 *
 * Rejects multi-segment paths and empty strings.
 */
export function parseOppRef(arg: string): OppRef {
  if (!arg || arg.length === 0) {
    throw new Error('parseOppRef: empty argument');
  }
  const parts = arg.split('/');
  if (parts.length === 1) {
    return { opp: parts[0], runId: null };
  }
  if (parts.length === 2) {
    return { opp: parts[0], runId: parts[1] };
  }
  throw new Error(
    `parseOppRef: expected "<opp>" or "<opp>/<run-id>", got ${JSON.stringify(arg)}`
  );
}

/**
 * Drive path of a run folder relative to the ACE root, e.g.
 *   "turmeric/runs/20260502-1830".
 */
export function runFolderPath(opp: string, runId: string): string {
  return `${opp}/runs/${runId}`;
}
