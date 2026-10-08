/**
 * Pure helpers for the multi-run Drive layout introduced in
 * docs/superpowers/specs/2026-05-02-ace-run-multi-run-revival-design.md.
 *
 * No Drive calls; no I/O. Used by the orchestrator to compute paths and
 * by tests to verify path logic without mocking Drive.
 */

export interface OppRef {
  /**
   * ace-web workspace slug, when the argument named one (`<ws>/<opp>[/<run-id>]`).
   * Null = "the default workspace" (`ACE_WEB_WORKSPACE` from the plugin .env) —
   * the caller resolves it; this parser does no I/O.
   */
  workspace: string | null;
  /** Opp slug (folder name under the workspace's Drive root). Always non-empty. */
  opp: string;
  /** Run-id (folder name under <opp>/runs/). Null = "fresh run". */
  runId: string | null;
}

/**
 * A run id is `YYYYMMDD-HHMM`, optionally collision-suffixed (`-2`, `-3`).
 * A workspace or opp slug never has that shape, which is what lets a
 * two-segment argument be told apart: `<opp>/<run-id>` vs `<ws>/<opp>`.
 */
export const RUN_ID_RE = /^\d{8}-\d{4}(-\d+)?$/;

export function isRunId(s: string): boolean {
  return RUN_ID_RE.test(s);
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
 * Parse an `/ace:run` (and `/ace:step`, `/ace:status`, `/ace:qa-deep`,
 * `/ace:eval`) positional argument into {workspace, opp, runId}.
 *
 * Accepts:
 *   - "turmeric"                        → { workspace: null, opp: "turmeric", runId: null }
 *   - "turmeric/20260502-1830"          → { workspace: null, opp: "turmeric", runId: "20260502-1830" }
 *   - "spark/spark-facilitator"         → { workspace: "spark", opp: "spark-facilitator", runId: null }
 *   - "spark/spark-facilitator/20261004-1706"
 *                                       → { workspace: "spark", opp: "spark-facilitator", runId: "20261004-1706" }
 *
 * Two segments are disambiguated by the second one's shape: a run id
 * (`RUN_ID_RE`) makes it `<opp>/<run-id>` — the pre-workspace form, kept
 * byte-for-byte compatible — anything else makes it `<ws>/<opp>`. Three
 * segments must end in a run id. Rejects empty segments and longer paths.
 */
export function parseOppRef(arg: string): OppRef {
  if (!arg) {
    throw new Error('parseOppRef: empty argument');
  }
  const parts = arg.split('/');
  if (!parts[0]) throw new Error('parseOppRef: empty opp slug');
  if (parts.length === 1) {
    return { workspace: null, opp: parts[0], runId: null };
  }
  if (parts.length === 2) {
    if (!parts[1]) throw new Error('parseOppRef: empty run-id');
    if (isRunId(parts[1])) return { workspace: null, opp: parts[0], runId: parts[1] };
    return { workspace: parts[0], opp: parts[1], runId: null };
  }
  if (parts.length === 3) {
    if (!parts[1]) throw new Error('parseOppRef: empty opp slug');
    if (!parts[2]) throw new Error('parseOppRef: empty run-id');
    if (!isRunId(parts[2])) {
      throw new Error(
        `parseOppRef: in "<workspace>/<opp>/<run-id>" the run-id must look like YYYYMMDD-HHMM, got ${JSON.stringify(parts[2])}`,
      );
    }
    return { workspace: parts[0], opp: parts[1], runId: parts[2] };
  }
  throw new Error(
    `parseOppRef: expected "<opp>", "<opp>/<run-id>", "<workspace>/<opp>" or "<workspace>/<opp>/<run-id>", got ${JSON.stringify(arg)}`,
  );
}

/**
 * Drive path of a run folder relative to the ACE root, e.g.
 *   "turmeric/runs/20260502-1830".
 */
export function runFolderPath(opp: string, runId: string): string {
  return `${opp}/runs/${runId}`;
}
