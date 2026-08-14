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
 */

export interface PipelineDef {
  id?: number;
  alias: string;
  schema: Array<{ name: string; path: string; aggregation?: string }>;
}

export interface DashboardDef {
  /** alias → pipeline id. */
  pipeline_sources: Record<string, number>;
  snapshot_inputs?: { pipelines?: string[] };
  render_code: string;
  pipelines: PipelineDef[];
}

export type BindingFindingKind =
  | 'stock-template-path'
  | 'snapshot-missing-alias'
  | 'pipeline-declared-but-unread'
  | 'unbackfilled-counter';

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

export function checkDashboardBindings(def: DashboardDef): BindingReport {
  const findings: BindingFinding[] = [];
  const aliases = Object.keys(def.pipeline_sources ?? {});
  if (aliases.length === 0) return { ok: true, findings };

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
