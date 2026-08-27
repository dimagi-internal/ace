/**
 * The connect-labs PIPELINE `aggregation` allow-list, and the drift detector
 * that keeps ACE's documentation of it honest.
 *
 * Why this is code rather than prose (dimagi-internal/ace#1675): ACE has now
 * documented this enum wrongly TWICE, in two different files, from the same
 * root cause.
 *
 *  - ace#749 (closed 2026-06-12) fixed it in
 *    `skills/synthetic-workflow-seed/SKILL.md`.
 *  - ace#1675 fixed it in `playbook/integrations/connect-labs.md`, which was
 *    not in #749's scope and carried the stale vocabulary for another two and
 *    a half months.
 *
 * The stale vocabulary was `count | mean | validated_rate | non_null_rate`, of
 * which only `count` is a real pipeline aggregation. The confusion is
 * structural, not careless: the synthetic MANIFEST has its own
 * `kpi_config[].aggregation` vocabulary (`validated_rate`, `non_null_rate`,
 * `distinct_count`) which is generator-side and legal there. Two enums, two
 * layers, similar names — so a third drift is likely unless something checks.
 *
 * This module is the offline half of that check: the live allow-list pinned as
 * data, plus a parser that reads what the playbook currently CLAIMS. The test
 * (`test/lib/labs-aggregations.test.ts`) diffs the two and runs in CI with no
 * network. `scripts/probe-labs-pipeline-aggregations.ts` is the online half —
 * it re-derives the allow-list from the live server and reports drift against
 * the pin below.
 */

/**
 * The pipeline aggregation allow-list, verbatim from the live server.
 *
 * Observed 2026-08-26 against `labs.connect.dimagi.com` (opp 10047, pipeline
 * 5242) by sending a deliberately-invalid aggregation to `pipeline_preview`
 * and reading the list the server echoes back:
 *
 *   Unknown aggregation '__ace_probe_invalid__' on field 'ace_probe_bogus'.
 *   Valid: ['avg', 'count', 'count_distinct', 'count_unique', 'first',
 *           'last', 'list', 'max', 'min', 'sum']
 *
 * Refresh this by running the probe, never by guessing.
 */
export const LIVE_PIPELINE_AGGREGATIONS: readonly string[] = [
  'avg',
  'count',
  'count_distinct',
  'count_unique',
  'first',
  'last',
  'list',
  'max',
  'min',
  'sum',
];

/**
 * Aggregations whose SQL performs a NUMERIC operation, and which therefore
 * need `transform: "float"` on the field. The pipeline extracts form values
 * with the JSONB text operator (`form_json->'form'->>'x'`), so without a
 * transform the column is `text`.
 *
 * Split by how they fail, because the two halves need very different care:
 *
 *  - `avg` / `sum` raise `function avg(text) does not exist` — LOUD, and
 *    unshippable, so an author finds out immediately.
 *  - `min` / `max` SUCCEED and return the lexicographic text extreme. Measured
 *    on `form.ppi_score`: worker `aisha_lawal` read `max: "9"` untransformed
 *    versus `max: 75` with the cast, because `"9" > "75"` as strings. Nothing
 *    errors and nothing is null, so `fields_all_null` cannot catch it.
 *
 * Both are gated on the schema actually aggregating: with no `grouping_key`
 * the preview emits no `AVG(...)`/`MAX(...)`, extracts raw text per row, and
 * returns `isError: false`. An ungrouped smoke preview is therefore not
 * evidence a numeric field is correct.
 */
export const NUMERIC_AGGREGATIONS_REQUIRING_FLOAT_TRANSFORM = {
  /** Raise a Postgres error without `transform: "float"`. */
  failLoud: ['avg', 'sum'] as readonly string[],
  /** Return a silently wrong lexicographic answer without `transform: "float"`. */
  failSilent: ['min', 'max'] as readonly string[],
} as const;

/**
 * Parse the server's rejection message and return the allow-list it echoes.
 *
 * The server is helpful here — it names the valid set on every rejection —
 * which is what makes the live probe a single deliberately-bad call rather
 * than a scrape of upstream source.
 *
 * Matches, e.g.:
 *   Unknown aggregation 'mean' on field 'avg_ppi_score'.
 *   Valid: ['avg', 'count', ..., 'sum']
 *
 * Returns null when the message carries no `Valid: [...]` list, which is the
 * signal that the error was something OTHER than an unknown aggregation (a
 * dead pipeline id, an auth failure) and must not be read as "the allow-list
 * is empty".
 */
export function parseValidAggregationsFromError(message: string): string[] | null {
  const m = message.match(/Valid:\s*\[([^\]]*)\]/);
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
}

/**
 * Extract the aggregation allow-list the playbook currently DOCUMENTS.
 *
 * Deliberately anchored on the sentence that states the allow-list, not on a
 * line number — ace#1675's own report cited "~line 283", and line numbers move
 * every time the file is edited.
 *
 * The documented form is a bolded lead-in naming the count, followed by
 * backticked tokens:
 *
 *   - **The PIPELINE `aggregation` allow-list is exactly these ten:**
 *     `avg`, `count`, ... `sum`.
 *
 * Returns null when the anchor sentence is absent, which the test treats as a
 * failure rather than as an empty list — a doc that no longer states the
 * allow-list at all is exactly as broken as one that states it wrongly.
 */
export function parseDocumentedAggregations(markdown: string): string[] | null {
  const anchor = markdown.match(
    /\*\*The PIPELINE `aggregation` allow-list is exactly these ten:\*\*([\s\S]{0,400}?)\.\s/,
  );
  if (!anchor) return null;
  const tokens = anchor[1].match(/`([a-z_]+)`/g);
  if (!tokens) return null;
  return tokens.map((t) => t.replace(/`/g, ''));
}

export interface AggregationDrift {
  /** In the live server's list but missing from the docs. */
  undocumented: string[];
  /** Documented by ACE but rejected by the live server. */
  invented: string[];
}

/** Diff a documented allow-list against the authoritative live one. */
export function diffAggregations(
  documented: readonly string[],
  live: readonly string[],
): AggregationDrift {
  const docSet = new Set(documented);
  const liveSet = new Set(live);
  return {
    undocumented: [...liveSet].filter((a) => !docSet.has(a)).sort(),
    invented: [...docSet].filter((a) => !liveSet.has(a)).sort(),
  };
}

/** True when the documented list matches the live list exactly. */
export function isAggregationDriftFree(drift: AggregationDrift): boolean {
  return drift.undocumented.length === 0 && drift.invented.length === 0;
}
