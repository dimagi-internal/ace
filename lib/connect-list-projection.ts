/**
 * Pure projection + aggregation helpers for the two org-wide Connect list
 * atoms (`connect_list_programs`, `connect_list_opportunities`).
 *
 * WHY (dimagi-internal/ace#1799): both atoms are MANDATED by
 * `connect-program-setup` — Step 2 calls `connect_list_programs` with no
 * `name` filter, Step 4a calls `connect_list_opportunities({hydrate:true})` —
 * and in a mature org both now exceed the harness tool-result cap, so
 * neither returns usable data inline. Measured on `ai-demo-space`
 * 2026-09-01 against live Connect:
 *
 *   connect_list_programs                → 42 rows,  57,425 chars (56.1 KB)
 *                                          43,239 of those chars (75.3%) are
 *                                          the per-row `description` prose
 *   connect_list_opportunities(hydrate)  → 71 rows,  81,175 chars (79.3 KB)
 *
 * The fix is PROJECTION FIRST, path-handle second. A `write_to_path` handle
 * alone converts a hard error into a mandatory out-of-band parse — which is
 * precisely the improvised workaround ace#1799 was filed about. These helpers
 * make the DEFAULT response usable in context; `write_to_path` stays as the
 * escape hatch for a caller that genuinely wants every field of every row.
 *
 * Pure by design: the MCP subprocess binds its code at spawn, so atom
 * behaviour cannot be live-validated from a running session. Keeping the
 * decision logic here means it is unit-testable without MCP plumbing.
 */

/**
 * How much of an unhydrated program `description` survives the default
 * projection. The reuse scan (`connect-program-setup` Step 2) matches on
 * DOMAIN + delivery type + archetype, and a program's domain signal is in
 * its opening sentences; the remaining paragraphs are the single largest
 * line item in the payload and no consumer reads them off a LIST row.
 * Step 3a's content reconcile reads the full description from
 * `connect_get_program`, not from here, so nothing that compares
 * descriptions is fed a truncated one.
 */
export const PROGRAM_LIST_DESCRIPTION_SNIPPET_CHARS = 400;

export interface ProgramDescriptionProjectionResult<T> {
  programs: Array<T & { description_truncated?: true }>;
  /** How many rows were actually shortened. */
  truncated_rows: number;
  /** Characters removed from the payload. Reported so the saving is visible. */
  chars_removed: number;
  /** The ceiling applied, so a reader knows what "truncated" means here. */
  snippet_chars: number;
}

/**
 * Cap `description` on program LIST rows.
 *
 * Only ever called for UNHYDRATED rows — a `name`-filtered `listPrograms`
 * call hydrates every match through `getProgram` (ace#1089), and those rows
 * are the targeted-lookup path whose full description Step 3a reconciles
 * against the PDD. Truncating them would silently corrupt that comparison,
 * so the caller decides and this helper never guesses.
 *
 * A shortened row is MARKED (`description_truncated: true`) rather than
 * quietly shortened: a consumer that needs the whole prose can see that it
 * is not looking at it, and go get it from `connect_get_program`.
 */
export function projectProgramDescriptions<T extends { description?: string | null }>(
  programs: readonly T[],
  opts: { snippetChars?: number } = {},
): ProgramDescriptionProjectionResult<T> {
  const snippet = opts.snippetChars ?? PROGRAM_LIST_DESCRIPTION_SNIPPET_CHARS;
  let truncated_rows = 0;
  let chars_removed = 0;
  const out = programs.map((p) => {
    const d = p.description;
    if (typeof d !== 'string' || d.length <= snippet) return { ...p };
    truncated_rows++;
    chars_removed += d.length - snippet;
    return { ...p, description: d.slice(0, snippet), description_truncated: true as const };
  });
  return { programs: out, truncated_rows, chars_removed, snippet_chars: snippet };
}

/** The shape `connect-program-setup` Step 4a actually consumes. */
export interface OpportunityProgramSummary {
  program_name: string;
  /** Σ(total_budget) over the rows definitively inside this program. */
  sigma_total_budget: number;
  /**
   * Whether that Σ may be trusted. Step 4a's four UNKNOWN conditions,
   * evaluated ONCE here rather than re-derived by each caller.
   */
  sigma_known: boolean;
  /** Verbatim reasons Σ is unknown; empty iff `sigma_known`. */
  sigma_unknown_reasons: string[];
  /** Rows with `dashboard_read: 'ok'` whose `program_name` matches. */
  matched_rows: number;
  matched_opportunity_ids: string[];
  /**
   * Rows with `dashboard_read: 'ok'` that are definitively OUTSIDE this
   * program (a different program, or none at all). ace#1637: these do NOT
   * make Σ unknown.
   */
  excluded_outside_program: number;
  /**
   * Rows whose dashboard half did not answer, so `program_name` /
   * `total_budget` were never read. Each one makes Σ unknown — an unread
   * field is never an absent one (ace#1637).
   */
  unreadable_rows: number;
  /** Matched rows carrying no `total_budget`; each makes Σ unknown. */
  rows_missing_total_budget: number;
  /** The ace#1637 split, first-class rather than re-derived per agent. */
  dashboard_read_counts: Record<string, number>;
  /** Total rows the walk returned, before any classification. */
  total_rows: number;
}

interface SummarizableOpportunity {
  id: string;
  program_name?: string;
  total_budget?: number;
  dashboard_read?: string;
}

/**
 * Collapse a hydrated org-wide opportunity listing into the handful of
 * numbers `connect-program-setup` Step 4a needs to size program headroom.
 *
 * Encodes Step 4a's classification EXACTLY, including the ace#1637 rule that
 * a `dashboard_read: 'ok'` row with no `program_name` is a FACT (outside the
 * program → excluded) while any other `dashboard_read` is an unread field
 * (→ Σ unknown), and ace#1590's rule that an incomplete listing makes Σ a
 * number about a different set rather than a smaller valid total.
 *
 * `duplicateProgramName` is Step 4a's fourth UNKNOWN condition. It cannot be
 * observed from the opportunity listing (no opportunity read surface carries
 * a program UUID), so the caller — which holds the Step 2 program list —
 * passes it in.
 */
export function summarizeOpportunitiesByProgram(
  opportunities: readonly SummarizableOpportunity[],
  args: {
    programName: string;
    listingComplete: boolean;
    listingTruncatedReason?: string;
    duplicateProgramName?: boolean;
  },
): OpportunityProgramSummary {
  const { programName, listingComplete, listingTruncatedReason, duplicateProgramName } = args;
  const dashboard_read_counts: Record<string, number> = {};
  const matched_opportunity_ids: string[] = [];
  let sigma = 0;
  let excluded_outside_program = 0;
  let unreadable_rows = 0;
  let rows_missing_total_budget = 0;

  for (const o of opportunities) {
    const read = o.dashboard_read ?? 'not_fetched';
    dashboard_read_counts[read] = (dashboard_read_counts[read] ?? 0) + 1;
    if (read !== 'ok') {
      unreadable_rows++;
      continue;
    }
    if (o.program_name !== programName) {
      excluded_outside_program++;
      continue;
    }
    matched_opportunity_ids.push(o.id);
    if (typeof o.total_budget !== 'number') {
      rows_missing_total_budget++;
      continue;
    }
    sigma += o.total_budget;
  }

  const sigma_unknown_reasons: string[] = [];
  if (!listingComplete) {
    sigma_unknown_reasons.push(
      `listing_incomplete: rows exist that the walk did not see, so Σ is a number about a ` +
        `different set, not a smaller valid total (ace#1590)` +
        (listingTruncatedReason ? ` — ${listingTruncatedReason}` : ''),
    );
  }
  if (unreadable_rows > 0) {
    sigma_unknown_reasons.push(
      `unreadable_rows: ${unreadable_rows} row(s) had dashboard_read other than 'ok', so their ` +
        `program_name and total_budget were never read and they can be neither assigned to nor ` +
        `excluded from this program (ace#1637)`,
    );
  }
  if (rows_missing_total_budget > 0) {
    sigma_unknown_reasons.push(
      `rows_missing_total_budget: ${rows_missing_total_budget} matched row(s) carry no ` +
        `total_budget — the dashboard's "Max Budget" card did not parse`,
    );
  }
  if (duplicateProgramName) {
    sigma_unknown_reasons.push(
      `duplicate_program_name: more than one program in the org is named "${programName}", and ` +
        `the scoping is by NAME (no opportunity read surface carries the program UUID)`,
    );
  }

  return {
    program_name: programName,
    sigma_total_budget: sigma,
    sigma_known: sigma_unknown_reasons.length === 0,
    sigma_unknown_reasons,
    matched_rows: matched_opportunity_ids.length,
    matched_opportunity_ids,
    excluded_outside_program,
    unreadable_rows,
    rows_missing_total_budget,
    dashboard_read_counts,
    total_rows: opportunities.length,
  };
}
