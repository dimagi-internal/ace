/**
 * dimagi-internal/ace#1160 — Phase 7's review dashboard was analytically DEAD
 * while looking fine: every worker row showed `VISITS 0` beside a chip reading
 * `visits: 835`, and the sibling scorecard credited the same 8 people with
 * 31–125 visits each.
 *
 * hh-poverty-targeting/20260730-2210, opp 10039, workflows 5066/5069.
 * Downstream the canopy DDD render+judge scored concept 2.0/5, user 1.0/5,
 * arc 1.0/5, no convergence, 21 findings.
 *
 * THREE INDEPENDENT BINDING DEFECTS, none of which is a data problem:
 *
 * 1. Pipeline 5068's schema was never re-pointed at the synthetic fixtures'
 *    form paths. It carries the STOCK performance_review template schema —
 *    `form.meta.instanceID`, `form.meta.timeEnd`, `form.meta.appVersion` —
 *    while the generator writes the run's REAL Deliver-app paths
 *    (`form.visit_summary.*`, `form.ppi_indicators.*`). So `visit_count`
 *    counts 0 for all 8 workers. Phase 7 did this CORRECTLY for the other
 *    dashboard (5065 → 31–125 visits); only the template-instantiated one was
 *    left stock.
 * 2. The render binds its only Visits column to `worker.visit_count` — a
 *    denormalized counter the synthetic generator never back-fills — and never
 *    reads the `performance_data` pipeline at all (0 references).
 * 3. Workflow 5069 declares `snapshot_inputs.pipelines: []` while
 *    `pipeline_sources` contains `performance_data -> 5068`, so the completed
 *    run snapshots no pipeline data. Workflow 5066 got this right.
 *
 * All three numbers on screen are TRUTHFUL reads of three different stores —
 * `total_visits` in 5068 still sums to exactly 835. The data is fine; the
 * bindings are wrong. That is why nothing downstream noticed.
 */
import { describe, it, expect } from 'vitest';
import { checkDashboardBindings, normalizePipelineSources } from '../../lib/dashboard-bindings.js';

const GOOD = {
  pipeline_sources: { flw_kpis: 5065 },
  snapshot_inputs: { pipelines: ['flw_kpis'] },
  render_code: 'rows.map(r => r.flw_kpis.completed_visits)',
  pipelines: [
    { id: 5065, alias: 'flw_kpis', schema: [{ name: 'completed_visits', path: 'form.visit_summary.completed' }] },
  ],
};

describe('checkDashboardBindings (#1160)', () => {
  it('passes the dashboard Phase 7 got right (workflow 5066 / pipeline 5065)', () => {
    const r = checkDashboardBindings(GOOD);
    expect(r.ok).toBe(true);
  });

  it('catches the stock template schema left pointing at form.meta.*', () => {
    const r = checkDashboardBindings({
      ...GOOD,
      pipelines: [
        {
          id: 5068,
          alias: 'performance_data',
          schema: [
            { name: 'visit_count', path: 'form.meta.instanceID', aggregation: 'count' },
            { name: 'app_version', path: 'form.meta.appVersion', aggregation: 'last' },
          ],
        },
      ],
      pipeline_sources: { performance_data: 5068 },
      snapshot_inputs: { pipelines: ['performance_data'] },
      render_code: 'rows.map(r => r.performance_data.visit_count)',
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('stock-template-path');
    expect(r.findings.find((f) => f.kind === 'stock-template-path')!.detail).toMatch(/form\.meta/);
  });

  it('catches an alias declared as a source but missing from snapshot_inputs', () => {
    const r = checkDashboardBindings({ ...GOOD, snapshot_inputs: { pipelines: [] } });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('snapshot-missing-alias');
  });

  it('catches render code that never reads a pipeline it declares', () => {
    const r = checkDashboardBindings({
      ...GOOD,
      render_code: 'rows.map(r => r.worker.visit_count)',
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('pipeline-declared-but-unread');
  });

  it('catches the denormalized counter the synthetic generator never back-fills', () => {
    const r = checkDashboardBindings({
      ...GOOD,
      render_code: 'rows.map(r => r.worker.visit_count)',
    });
    expect(r.findings.map((f) => f.kind)).toContain('unbackfilled-counter');
    expect(r.findings.find((f) => f.kind === 'unbackfilled-counter')!.detail).toMatch(/visit_count/);
  });

  it('does not flag a counter reference that ALSO reads the pipeline', () => {
    const r = checkDashboardBindings({
      ...GOOD,
      render_code: 'const v = r.flw_kpis.completed_visits ?? r.worker.visit_count;',
    });
    expect(r.findings.map((f) => f.kind)).not.toContain('pipeline-declared-but-unread');
  });

  it('is inert on a dashboard that declares no pipelines at all', () => {
    expect(
      checkDashboardBindings({ pipeline_sources: {}, snapshot_inputs: { pipelines: [] }, render_code: 'x', pipelines: [] }).ok,
    ).toBe(true);
  });

  it('names all three defects at once on the live 5069 shape', () => {
    const r = checkDashboardBindings({
      pipeline_sources: { performance_data: 5068 },
      snapshot_inputs: { pipelines: [] },
      render_code: 'worker.visit_count; worker.visit_count; worker.visit_count;',
      pipelines: [
        { id: 5068, alias: 'performance_data', schema: [{ name: 'visit_count', path: 'form.meta.instanceID' }] },
      ],
    });
    const kinds = r.findings.map((f) => f.kind);
    expect(kinds).toContain('stock-template-path');
    expect(kinds).toContain('snapshot-missing-alias');
    expect(kinds).toContain('pipeline-declared-but-unread');
  });
});

/**
 * dimagi-internal/ace#1894 — `workflow_clone` across opportunities yields
 * unresolvable `pipeline_sources`; the cloned dashboard renders empty with no
 * error.
 *
 * Every fixture below is VERBATIM from a live probe run 2026-09-06 against
 * `labs.connect.dimagi.com`. I cloned workflow 5321 (opp 10051) into opp 10055
 * as workflow **5459**, read it back in both scopes, and deleted it:
 *
 *   workflow_get(5321, opportunity_id=10051).pipeline_sources
 *     [{pipeline_id: 5320, alias: 'flw_kpis',
 *       name: 'FLW KPI Aggregates', schema_summary: {field_count: 8}}]
 *
 *   workflow_get(5459, opportunity_id=10055).pipeline_sources    <- the clone
 *     [{pipeline_id: 5320, alias: 'flw_kpis',
 *       name: null,        schema_summary: {field_count: 0}}]
 *
 *   pipeline_get(5320, opportunity_id=10055)     -> "No pipeline with id 5320"
 *   pipeline_preview(5320, opportunity_id=10055) -> "No pipeline with id 5320"
 *   pipeline_list(opportunity_id=10055)          -> 5439, 5442, 5447 (not 5320)
 *
 * The clone reported success and `workflow_get` returned a definition that
 * looks right. `name: null` + `field_count: 0` is the server telling you it
 * had no row to read — and it is already in the response the producer fetches,
 * so the check costs no extra call.
 */

/** The clone, exactly as `workflow_get(5459, opportunity_id=10055)` returned it. */
const CROSS_OPP_CLONE = {
  pipeline_sources: [
    { pipeline_id: 5320, alias: 'flw_kpis', name: null, schema_summary: { field_count: 0 } },
  ],
  snapshot_inputs: { pipelines: ['flw_kpis'] },
  render_code: 'view.pipelines.flw_kpis.map(r => r.completed)',
  pipelines: [],
};

/** Its source, as `workflow_get(5321, opportunity_id=10051)` returned it. */
const RESOLVES_IN_SCOPE = {
  ...CROSS_OPP_CLONE,
  pipeline_sources: [
    {
      pipeline_id: 5320,
      alias: 'flw_kpis',
      name: 'FLW KPI Aggregates',
      schema_summary: { field_count: 8 },
    },
  ],
};

describe('checkDashboardBindings — pipeline-unresolvable-in-scope (#1894)', () => {
  it('catches the cross-opp clone whose declared pipeline does not resolve', () => {
    const r = checkDashboardBindings(CROSS_OPP_CLONE);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('pipeline-unresolvable-in-scope');
  });

  it('names the alias and the id the render will silently fail to read', () => {
    const f = checkDashboardBindings(CROSS_OPP_CLONE).findings.find(
      (x) => x.kind === 'pipeline-unresolvable-in-scope',
    )!;
    expect(f.detail).toMatch(/flw_kpis/);
    expect(f.detail).toMatch(/5320/);
    expect(f.detail).toMatch(/workflow_clone/);
  });

  it('passes the SAME workflow read in the scope that owns its pipeline', () => {
    // The positive control is not a hand-built "good" object — it is the same
    // definition, same alias, same pipeline id, read one scope over. Only the
    // resolution metadata differs, which is the whole claim.
    const r = checkDashboardBindings(RESOLVES_IN_SCOPE);
    expect(r.findings).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it('does NOT fire on a resolvable pipeline with an empty schema (the #1160 ADAPT case)', () => {
    // A freshly template-instantiated pipeline is resolvable and has 0 fields.
    // Flagging it here would block the legitimate ADAPT flow; `stock-template-path`
    // and the re-point step already own that case.
    const r = checkDashboardBindings({
      ...CROSS_OPP_CLONE,
      pipeline_sources: [
        { pipeline_id: 5320, alias: 'flw_kpis', name: 'Stock template pipeline', schema_summary: { field_count: 0 } },
      ],
    });
    expect(r.findings.map((f) => f.kind)).not.toContain('pipeline-unresolvable-in-scope');
  });

  it('does NOT fire on a payload with no schema_summary at all', () => {
    // Absence is not evidence: a response shape that predates the field must
    // not be read as an unresolvable pipeline.
    const r = checkDashboardBindings({
      ...CROSS_OPP_CLONE,
      pipeline_sources: [{ pipeline_id: 5320, alias: 'flw_kpis' }],
    });
    expect(r.findings.map((f) => f.kind)).not.toContain('pipeline-unresolvable-in-scope');
  });

  it('cannot answer the question from the dict shape, and does not guess', () => {
    // The stored definition carries no resolution metadata. Silence here is
    // correct; the producer reads the array form from workflow_get.
    const r = checkDashboardBindings({
      ...CROSS_OPP_CLONE,
      pipeline_sources: { flw_kpis: 5320 },
    });
    expect(r.findings.map((f) => f.kind)).not.toContain('pipeline-unresolvable-in-scope');
  });
});

/**
 * The shape bug found while fixing #1894. `Object.keys()` over the ARRAY form
 * yields the array INDICES, so every alias-keyed check judged `'0'`, `'1'`, …
 * Fed the real `workflow_get(5440, opportunity_id=10055)` payload — a HEALTHY
 * two-pipeline dashboard from the repaired run — the pre-fix function returned
 * 4 findings, none of them real.
 */
const LIVE_HEALTHY_ARRAY_SHAPE = {
  pipeline_sources: [
    { pipeline_id: 5439, alias: 'flw_kpis', name: 'FLW KPI Aggregates', schema_summary: { field_count: 8 } },
    { pipeline_id: 5447, alias: 'weekly_sweep', name: 'Weekly Sweep Series', schema_summary: { field_count: 1 } },
  ],
  snapshot_inputs: { pipelines: ['flw_kpis', 'weekly_sweep'] },
  render_code:
    'view.pipelines.flw_kpis.map(r => r.completed) + view.pipelines.weekly_sweep.length',
  pipelines: [],
};

describe('checkDashboardBindings — pipeline_sources shape normalization (#1894)', () => {
  it('reads the ARRAY shape workflow_get returns, and reports nothing on a healthy one', () => {
    const r = checkDashboardBindings(LIVE_HEALTHY_ARRAY_SHAPE);
    expect(r.findings).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it('still catches a real defect in the array shape (the aliases are real, not indices)', () => {
    const r = checkDashboardBindings({
      ...LIVE_HEALTHY_ARRAY_SHAPE,
      snapshot_inputs: { pipelines: ['flw_kpis'] },
    });
    expect(r.findings.map((f) => f.kind)).toContain('snapshot-missing-alias');
    expect(r.findings.find((f) => f.kind === 'snapshot-missing-alias')!.detail).toMatch(
      /weekly_sweep/,
    );
  });

  it('normalizes both shapes to the same alias list', () => {
    expect(normalizePipelineSources({ flw_kpis: 5320 })).toEqual([
      { alias: 'flw_kpis', pipeline_id: 5320 },
    ]);
    expect(normalizePipelineSources(LIVE_HEALTHY_ARRAY_SHAPE.pipeline_sources).map((e) => e.alias)).toEqual([
      'flw_kpis',
      'weekly_sweep',
    ]);
    expect(normalizePipelineSources(undefined)).toEqual([]);
  });

  it('drops array entries with no usable alias rather than inventing one', () => {
    expect(normalizePipelineSources([{ pipeline_id: 1, alias: '' } as any])).toEqual([]);
    expect(normalizePipelineSources([null as any, undefined as any])).toEqual([]);
  });
});
