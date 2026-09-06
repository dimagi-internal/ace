/**
 * Is a demo dashboard's data actually WIRED, or does it merely look wired?
 *
 * Why this exists (dimagi-internal/ace#1160). Phase 7 of
 * hh-poverty-targeting/20260730-2210 built two dashboards. The review-action
 * one (workflow 5069) was analytically **dead**: every worker row showed
 * `VISITS 0` beside a chip on the same page reading `visits: 835`, while the
 * sibling scorecard credited the same 8 people with 31–125 visits each.
 * Downstream, the canopy DDD render+judge scored concept 2.0/5, user 1.0/5,
 * arc 1.0/5 — no convergence, 21 findings.
 *
 * **The data was fine.** `total_visits` in the same pipeline still summed to
 * exactly 835. Three numbers on screen were three truthful reads of three
 * different stores. What was wrong was the bindings, in three independent
 * ways:
 *
 * 1. **Stock template schema.** Pipeline 5068 carried the UNMODIFIED
 *    `performance_review` template schema — `form.meta.instanceID`,
 *    `form.meta.timeEnd`, `form.meta.appVersion` — while the synthetic
 *    generator writes the run's REAL Deliver-app paths
 *    (`form.visit_summary.*`, `form.ppi_indicators.*`). `visit_count` counted
 *    0 for all 8 workers. Phase 7 did this correctly for the OTHER dashboard
 *    (5065 → 31–125); only the template-instantiated one was left stock.
 * 2. **The render never read the pipeline it declared.** Its only Visits
 *    column bound `worker.visit_count` — a denormalized counter the synthetic
 *    generator never back-fills — with 0 references to `performance_data`.
 * 3. **The snapshot held no pipeline rows.** `snapshot_inputs.pipelines: []`
 *    while `pipeline_sources` declared `performance_data -> 5068`. Workflow
 *    5066 got this right.
 *
 * Each is cheaply decidable from the workflow definition, which is what makes
 * this a preventer rather than another judge.
 *
 * ## The fourth binding defect: a declared pipeline that isn't THERE (#1894)
 *
 * Same failure signature, one layer lower. Pipelines are **opportunity-scoped**;
 * `workflow_clone` copies `pipeline_sources` verbatim and — by its own atom
 * description — "does NOT clone linked pipelines". So a cross-opp clone is
 * structurally a dashboard whose every declared alias points at an id it
 * cannot read. It reports success, the definition looks right, and the page
 * renders EMPTY with no error.
 *
 * Cross-opp cloning is the obvious reach on any forked or repeated run — it is
 * how you carry a REPAIRED dashboard forward instead of re-instantiating a
 * stock template and re-fixing the #1160 defects above. On
 * `hh-poverty-targeting/20260901-1932` that is exactly what happened, and the
 * run then had to re-instantiate from template and re-fix them anyway.
 *
 * The first three checks are blind to it by construction: they ask whether the
 * ALIAS is snapshotted and read, never whether the ID resolves. Which it
 * cannot, from the definition alone — so this one reads the resolution
 * metadata `workflow_get` already returns beside each source. See
 * {@link isUnresolvableSource}.
 *
 * ## And a shape bug found while fixing it
 *
 * `pipeline_sources` has two real shapes, and this module only ever read one.
 * See {@link normalizePipelineSources} — fed the payload the atom actually
 * returns, every check here was judging array INDICES as aliases.
 */

export interface PipelineDef {
  id?: number;
  alias: string;
  schema: Array<{ name: string; path: string; aggregation?: string }>;
}

/**
 * One entry of the ARRAY form of `pipeline_sources` — what `workflow_get`
 * actually returns. `name` and `schema_summary` are the server's resolution of
 * the id IN THE SCOPE YOU ASKED ABOUT; see {@link isUnresolvableSource}.
 */
export interface PipelineSourceEntry {
  pipeline_id: number;
  alias: string;
  name?: string | null;
  schema_summary?: { field_count?: number } | null;
}

export interface DashboardDef {
  /**
   * Two shapes, both real:
   *
   * - `{alias: id}` — the stored definition.
   * - `[{pipeline_id, alias, name, schema_summary}]` — what `workflow_get`
   *   returns, and what the run page carries.
   *
   * Both are normalized by {@link normalizePipelineSources}. Only the array
   * form carries the resolution metadata the `pipeline-unresolvable-in-scope`
   * check reads, so a dict-shaped def is checked for the other four kinds and
   * simply cannot answer the fifth question.
   */
  pipeline_sources: Record<string, number> | PipelineSourceEntry[];
  snapshot_inputs?: { pipelines?: string[] };
  render_code: string;
  pipelines: PipelineDef[];
}

export type BindingFindingKind =
  | 'stock-template-path'
  | 'snapshot-missing-alias'
  | 'pipeline-declared-but-unread'
  | 'unbackfilled-counter'
  | 'pipeline-unresolvable-in-scope';

export interface BindingFinding {
  kind: BindingFindingKind;
  detail: string;
}

export interface BindingReport {
  ok: boolean;
  findings: BindingFinding[];
}

/**
 * Paths that only a REAL CommCare submission carries. The synthetic generator
 * writes app form paths, never `form.meta.*`, so a schema still pointing there
 * is a template that was instantiated and never re-pointed.
 */
const STOCK_PATH = /^form\.meta\./;

/**
 * Denormalized counters on the worker / OpportunityAccess record. The
 * generator writes UserVisit fixtures without back-filling these, so a render
 * that binds one shows 0 on a dashboard whose underlying data is complete.
 */
const UNBACKFILLED_COUNTERS = ['visit_count', 'visits_count', 'completed_visit_count'];

/**
 * Normalize both shapes of `pipeline_sources` to entries.
 *
 * This is a BUG FIX, not just an ergonomic widening. `Object.keys()` over the
 * array form yields `['0', '1', …]` — the array INDICES — so every check keyed
 * on the alias silently judged the wrong strings. Fed the real
 * `workflow_get(5440, opportunity_id=10055)` payload (a healthy dashboard),
 * the pre-fix function returned 4 findings: `snapshot-missing-alias` and
 * `pipeline-declared-but-unread` for aliases `'0'` and `'1'`. Since #1160 this
 * check has been able to read only the dict shape, while the atom callers
 * actually reach for returns the array. Mirrors `declaredAliases` in
 * `skills/demo-data-setup-qa/checks.ts`, which already handled both.
 */
export function normalizePipelineSources(
  sources: DashboardDef['pipeline_sources'] | undefined,
): PipelineSourceEntry[] {
  if (!sources) return [];
  if (Array.isArray(sources)) {
    return sources
      .filter((s) => s && typeof s === 'object' && typeof s.alias === 'string' && s.alias !== '')
      .map((s) => ({ ...s }));
  }
  return Object.entries(sources).map(([alias, pipeline_id]) => ({ alias, pipeline_id }));
}

/**
 * Did the server fail to resolve this pipeline id in the scope we asked about?
 *
 * `workflow_get` fills `name` and `schema_summary.field_count` by looking the
 * id up **within the requested scope**. A pipeline that resolves has both; one
 * that does not has neither, because there is no row to read them from.
 * Measured live 2026-09-06 on a fresh cross-opp clone (workflow 5459, cloned
 * from 5321/opp 10051 into opp 10055):
 *
 *   scope 10051: {pipeline_id: 5320, alias: 'flw_kpis',
 *                 name: 'FLW KPI Aggregates', schema_summary: {field_count: 8}}
 *   scope 10055: {pipeline_id: 5320, alias: 'flw_kpis',
 *                 name: null,               schema_summary: {field_count: 0}}
 *   pipeline_get(5320, opportunity_id=10055)     -> "No pipeline with id 5320"
 *   pipeline_preview(5320, opportunity_id=10055) -> "No pipeline with id 5320"
 *
 * **Both conditions are required, deliberately.** `field_count: 0` alone is
 * ambiguous: a freshly template-instantiated pipeline can be perfectly
 * resolvable with an EMPTY schema — that is the #1160 stock-template case,
 * which `stock-template-path` and the ADAPT flow already own. A missing `name`
 * alone would fire on an unnamed-but-real pipeline. Requiring both is exactly
 * "the server had no row to read", and under-claiming is the safe direction
 * here: a false positive blocks authoring a legitimate dashboard, while a
 * false negative is still caught later (less precisely) by check 7's
 * `snapshot-missing-pipelines`.
 */
export function isUnresolvableSource(entry: PipelineSourceEntry): boolean {
  const nameMissing = entry.name === null || entry.name === undefined || entry.name === '';
  // `schema_summary` absent entirely means the payload predates the field —
  // not evidence of anything. Only an explicit 0 counts.
  const fieldCount = entry.schema_summary?.field_count;
  return nameMissing && fieldCount === 0;
}

export function checkDashboardBindings(def: DashboardDef): BindingReport {
  const findings: BindingFinding[] = [];
  const entries = normalizePipelineSources(def.pipeline_sources);
  const aliases = entries.map((e) => e.alias);
  if (aliases.length === 0) return { ok: true, findings };

  for (const entry of entries) {
    if (!isUnresolvableSource(entry)) continue;
    findings.push({
      kind: 'pipeline-unresolvable-in-scope',
      detail:
        `pipeline_sources declares '${entry.alias}' -> pipeline ${entry.pipeline_id}, but that id does ` +
        'not resolve in this workflow\'s own scope (the server returned no name and no fields for it). ' +
        'Pipelines are opportunity-scoped and `workflow_clone` copies pipeline_sources VERBATIM without ' +
        'cloning the pipelines, so a cross-opp clone declares ids it cannot read — `pipeline_get` and ' +
        '`pipeline_preview` both answer "No pipeline with id ' + entry.pipeline_id + '". The dashboard ' +
        'renders EMPTY with no error. Re-point the alias at a pipeline in this scope (or author one here) ' +
        'before minting a run',
    });
  }

  const snapshot = new Set(def.snapshot_inputs?.pipelines ?? []);
  const render = def.render_code ?? '';

  for (const alias of aliases) {
    if (!snapshot.has(alias)) {
      findings.push({
        kind: 'snapshot-missing-alias',
        detail:
          `pipeline_sources declares '${alias}' but snapshot_inputs.pipelines does not include it — ` +
          'a completed run then snapshots no rows for it and the page renders nothing from it',
      });
    }
    if (!new RegExp(`\\b${alias}\\b`).test(render)) {
      findings.push({
        kind: 'pipeline-declared-but-unread',
        detail:
          `the render code never references '${alias}', so the pipeline is authored, wired and ` +
          'ignored — whatever the page displays is coming from somewhere else',
      });
    }
  }

  for (const p of def.pipelines ?? []) {
    const stock = (p.schema ?? []).filter((f) => STOCK_PATH.test(f.path));
    if (stock.length > 0) {
      findings.push({
        kind: 'stock-template-path',
        detail:
          `pipeline '${p.alias}' still extracts ${stock.map((f) => `${f.name} <- ${f.path}`).join(', ')} ` +
          '— the stock template schema. The synthetic generator writes the run\'s REAL Deliver-app form ' +
          'paths and never form.meta.*, so every one of these resolves null or zero. Re-point the schema ' +
          'at the same paths the scorecard pipeline already resolves',
      });
    }
  }

  // Only worth reporting when the render is ALSO not reading a pipeline —
  // a counter used as a fallback beside real pipeline data is fine.
  const readsAPipeline = aliases.some((a) => new RegExp(`\\b${a}\\b`).test(render));
  if (!readsAPipeline) {
    for (const counter of UNBACKFILLED_COUNTERS) {
      if (new RegExp(`\\b${counter}\\b`).test(render)) {
        findings.push({
          kind: 'unbackfilled-counter',
          detail:
            `the render binds '${counter}', a denormalized counter on the worker / OpportunityAccess ` +
            'record. The synthetic generator writes UserVisit fixtures without back-filling it, so this ' +
            'column reads 0 on a dashboard whose underlying data is complete — which is exactly how ' +
            '"VISITS 0" ended up beside "visits: 835"',
        });
        break;
      }
    }
  }

  return { ok: findings.length === 0, findings };
}
