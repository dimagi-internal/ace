/**
 * Does every field an authored labs pipeline DECLARES actually extract
 * anything? (dimagi-internal/ace#1864)
 *
 * Phase 7 of `spark-facilitator/20260828-0703` authored pipeline 5414 with
 *
 *   {"name": "records", "path": "form.meeting_date.date_of_meeting",
 *    "aggregation": "count"}
 *
 * on a fixture that carried no such path. An unmatched path is not an error in
 * labs — it aggregates to `0`. So `records` came back `0` for all 12
 * facilitators, the render's `verifiedPct = pct(community, records)` produced
 * `—` on every row, `judged = records >= MIN_RECORDS` was false everywhere, and
 * the below-floor filter matched 0 of 12. The demo's entire payoff — narrow to
 * the three under the floor, record a decision on one — was dead. Two sibling
 * fields (`avg_attendance`, `avg_participation_pct`) were null the same way.
 *
 * Nothing caught it, and four separate surfaces each had a structural reason:
 *
 * 1. **labs' own `fields_all_null` is null-only.** Verified live 2026-09-06
 *    against pipeline 5411 / opp 10054 with a `schema_override` pointing three
 *    fields at `form.no_such_group.no_such_field`:
 *
 *      rows            : records_bad_count 0, steps_bad_distinct 0, avg_bad null
 *      fields_all_null : ["avg_bad"]
 *
 *    `count` and `count_distinct` of nothing are `0`, not `null` — so the
 *    upstream detector misses precisely the field TYPE that gates a demo's
 *    filter. That is not a bug to route upstream and wait on; it is a coverage
 *    boundary ACE can close from the rows it already receives.
 *
 * 2. **`demo-data-setup-qa` check 7 enumerates from the RETURNED ROW COLUMNS**
 *    (`for (const field of columns)` over `Object.keys(row)`), so a declared
 *    field the engine never emitted as a column is invisible to it.
 *
 * 3. **Check 7 reads a run's FROZEN SNAPSHOT** for every completed dashboard.
 *    A snapshot minted while the values were good keeps rendering them after
 *    the binding rots — which is the issue's title in one line: the demo loses
 *    its payoff on the NEXT render, not this one. Live today: pipeline 5411
 *    still declares `records` on the broken `form.meeting_date.date_of_meeting`
 *    and its dashboard still renders, because it renders a snapshot.
 *
 * 4. **A warm cache is not evidence about a path.** #1864's first render read
 *    one and looked perfect; the same run id recomputed 40 minutes later
 *    (`from_cache: false`) and returned zeros. A preview that reports
 *    `from_cache: true` proves nothing about the schema now saved, so this
 *    check refuses it rather than passing on it.
 *
 * So the judgement here is deliberately: over the DECLARED field list, from a
 * FRESH extraction, with zero counted as dead. Pure over already-fetched
 * `pipeline_preview` responses — the fetch belongs to the caller, the rule is
 * testable.
 *
 * Sibling of `lib/dashboard-bindings.ts` (#1160), which asks the same question
 * of the DEFINITION and cannot see data, and of `demo-data-setup-qa` check 7,
 * which asks it of a rendered payload and cannot see the declaration.
 */

import type { QACheckResult } from './qa-types';

/** A field as authored in `schema.fields[]` — the DECLARED list. */
export interface DeclaredPipelineField {
  name: string;
  path: string;
  aggregation?: string;
  /** A filtered count may legitimately match nothing; an unfiltered one may not. */
  filter_path?: string;
  filter_value?: unknown;
}

/** One authored pipeline plus a `pipeline_preview` response for it. */
export interface PipelinePreview {
  pipeline_id: number;
  name?: string;
  /** `pipeline_get(...).schema.fields` — NOT the columns that came back. */
  declared: DeclaredPipelineField[];
  /** `pipeline_preview(...).rows`. */
  rows: Record<string, unknown>[];
  /** `pipeline_preview(...).per_opp_metadata[<opp>].from_cache`. */
  from_cache?: boolean;
  /** `pipeline_preview(...).fields_all_null` — folded in so we never regress below it. */
  fields_all_null?: string[];
}

export type ExtractionFindingKind =
  | 'cached-preview'
  | 'no-declared-fields'
  | 'no-rows'
  | 'field-missing-from-rows'
  | 'field-dead'
  | 'filtered-field-all-zero';

export interface ExtractionFinding {
  kind: ExtractionFindingKind;
  pipeline_id: number;
  field?: string;
  path?: string;
  /** Blocking findings fail the check; reported ones are surfaced, never silent. */
  blocking: boolean;
  detail: string;
}

export interface ExtractionReport extends QACheckResult {
  findings: ExtractionFinding[];
  /** Declared fields actually judged against rows — so "0 problems" is measured, not assumed. */
  fields_judged: number;
}

const COUNTING_AGGREGATIONS = new Set(['count', 'count_distinct', 'count_unique']);
const NUMERIC_AGGREGATIONS = new Set(['avg', 'sum', 'min', 'max']);

/**
 * Is this value the shape an unmatched path produces?
 *
 * `0` counts, because that is the whole point: `count` over zero matched
 * records is `0` and `count_distinct` is `0`, which is exactly what labs'
 * null-only `fields_all_null` cannot see. A field that is zero for SOME rows is
 * data and is never flagged — only uniformity across every row is evidence.
 */
export function isDeadExtraction(value: unknown, aggregation?: string): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  const agg = (aggregation ?? '').trim().toLowerCase();
  if (COUNTING_AGGREGATIONS.has(agg) || NUMERIC_AGGREGATIONS.has(agg) || agg === '') {
    return value === 0;
  }
  // first / last / list: an extracted value that happens to be 0 is legitimate content.
  return false;
}

function isFiltered(f: DeclaredPipelineField): boolean {
  return Boolean(f.filter_path) || f.filter_value !== undefined;
}

/**
 * Every declared field of every authored pipeline extracts something, judged
 * from a fresh preview.
 *
 * @param previews One entry per pipeline the run AUTHORED — not per dashboard.
 *   A pipeline whose dashboard renders a frozen snapshot still has to be
 *   previewed, because the snapshot is what hides the rot (#1864's closing note
 *   on pipeline 5411).
 */
export function checkPipelineFieldsExtract(previews: PipelinePreview[]): ExtractionReport {
  const findings: ExtractionFinding[] = [];
  let fieldsJudged = 0;

  for (const p of previews) {
    const declared = p.declared ?? [];
    const rows = p.rows ?? [];

    if (p.from_cache === true) {
      findings.push({
        kind: 'cached-preview',
        pipeline_id: p.pipeline_id,
        blocking: true,
        detail:
          `pipeline ${p.pipeline_id}${p.name ? ` (${p.name})` : ''} previewed from_cache=true — ` +
          `these rows were not computed against the schema now saved, so they are not evidence ` +
          `about any field's path. #1864's first render read a warm cache and looked perfect; the ` +
          `same run recomputed 40 minutes later and returned zeros.`,
      });
      continue;
    }

    if (declared.length === 0) {
      findings.push({
        kind: 'no-declared-fields',
        pipeline_id: p.pipeline_id,
        blocking: false,
        detail:
          `pipeline ${p.pipeline_id} declares no custom fields, so no path was judged here ` +
          `(a stock template left un-repointed is lib/dashboard-bindings.ts' check, not this one)`,
      });
      continue;
    }

    if (rows.length === 0) {
      findings.push({
        kind: 'no-rows',
        pipeline_id: p.pipeline_id,
        blocking: false,
        detail:
          `pipeline ${p.pipeline_id} returned 0 rows, so its ${declared.length} declared ` +
          `field(s) could not be judged — reported, not passed`,
      });
      continue;
    }

    const flagged = new Set<string>();
    for (const f of declared) {
      const present = rows.some((r) => Object.prototype.hasOwnProperty.call(r, f.name));
      if (!present) {
        flagged.add(f.name);
        findings.push({
          kind: 'field-missing-from-rows',
          pipeline_id: p.pipeline_id,
          field: f.name,
          path: f.path,
          blocking: true,
          detail:
            `pipeline ${p.pipeline_id}.${f.name} is declared (path '${f.path}') but no returned row ` +
            `carries that column — the field is not being computed at all`,
        });
        continue;
      }

      fieldsJudged += 1;
      const allDead = rows.every((r) => isDeadExtraction(r[f.name], f.aggregation));
      if (!allDead) continue;

      flagged.add(f.name);
      if (isFiltered(f)) {
        findings.push({
          kind: 'filtered-field-all-zero',
          pipeline_id: p.pipeline_id,
          field: f.name,
          path: f.path,
          blocking: false,
          detail:
            `pipeline ${p.pipeline_id}.${f.name} ('${f.aggregation ?? 'unset'}' on '${f.path}' ` +
            `filtered to ${String(f.filter_value)}) is dead for all ${rows.length} row(s) — a filter ` +
            `that matches nothing is possible data, so this is reported. Confirm the filter value is ` +
            `one the fixture actually writes, and check for the shared-path collision (ace#595)`,
        });
      } else {
        findings.push({
          kind: 'field-dead',
          pipeline_id: p.pipeline_id,
          field: f.name,
          path: f.path,
          blocking: true,
          detail:
            `pipeline ${p.pipeline_id}.${f.name} ('${f.aggregation ?? 'unset'}' on '${f.path}') is ` +
            `null/zero for all ${rows.length} row(s) with no filter to explain it — the path does not ` +
            `match what the fixture writes`,
        });
      }
    }

    // Never fall below labs' own detector, whatever our rules decide.
    for (const name of p.fields_all_null ?? []) {
      if (flagged.has(name)) continue;
      findings.push({
        kind: 'field-dead',
        pipeline_id: p.pipeline_id,
        field: name,
        blocking: true,
        detail:
          `pipeline ${p.pipeline_id}.${name} is named in the preview's own fields_all_null and was ` +
          `not otherwise flagged — labs extracted null for it on every row`,
      });
    }
  }

  const blocking = findings.filter((f) => f.blocking);
  const reported = findings.filter((f) => !f.blocking);
  const reportedNote = reported.length
    ? ` (reported, not blocking: ${reported.map((f) => `[${f.kind}] ${f.detail}`).join('; ')})`
    : '';

  if (blocking.length === 0) {
    return {
      pass: true,
      findings,
      fields_judged: fieldsJudged,
      detail:
        `${fieldsJudged} declared field(s) across ${previews.length} authored pipeline(s) each ` +
        `extracted a value on at least one row${reportedNote}`,
    };
  }

  return {
    pass: false,
    findings,
    fields_judged: fieldsJudged,
    detail: blocking.map((f) => `[${f.kind}] ${f.detail}`).join('; ') + reportedNote,
    auto_fix_hint:
      'Re-point each named field at a path the fixture actually writes, then prove it: ' +
      'mcp__connect-labs__synthetic_reload_fixtures(<labs_opp_id>) to drop the caches, ' +
      'pipeline_update_schema with the corrected path, then pipeline_preview again and confirm ' +
      'from_cache is false AND the column is non-dead on at least one row. Do NOT accept the ' +
      "preview's own fields_all_null as the answer — it is null-only, so a count over zero matched " +
      'records reads as a healthy 0 (verified live on opp 10054, 2026-09-06). And do not delete the ' +
      'field to clear the check: the render binds it, so a removed column is the same dead demo ' +
      '(dimagi-internal/ace#1864).',
  };
}
