import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkConstantDisplayedColumns,
  checkDrillLevels,
  checkPlannedWorkerRates,
  checkReviewRouting,
  checkWorkerRateDenominators,
  drillLevelChildCounts,
  entityCountRateIndicators,
  isFlagRaised,
  latestSnapshotFromHistoryRuns,
  visitSampleScope,
  type CascadeSnapshot,
} from '../../lib/cascade-build-qa';
import { checkCascadeStoryPlan, type CascadeStoryPlan } from '../../lib/cascade-story';
import { cascadeBuildOutcomes, checksForProvider } from '../../skills/demo-data-setup-qa/checks';

// ace#2735. The fixtures are the REAL build output of spark-facilitator/20261004-1706,
// read 2026-10-06 while its Phase 7 DDD run (spark-facilitator-programme-cascade-
// 2026-10-06-002) was finding these defects AFTER render:
//  - the programme report's latest saved run (workflow 7410, program 10100), trimmed
//    to the fields the checks read;
//  - Tiyende Community Trust (example)'s visit rows (pipeline 7409, opp 10100, all 153).
// Each check is pinned to fail on that output and to pass a control repaired the way
// its fix hint says — a rule that cannot fail on the run that motivated it is no rule.
// Each binding reads its captured artifact directly, so every control below is
// fed from disk (the negative-control ratchet's grounding rule).
const SNAP = latestSnapshotFromHistoryRuns(
  JSON.parse(readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-20261004-1706-latest-run.json'), 'utf8')),
) as CascadeSnapshot;
const VISITS: Array<Record<string, unknown>> = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-20261004-1706-visits-tiyende.json'), 'utf8'),
).rows;
const PLAN: CascadeStoryPlan = JSON.parse(readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-story-named.json'), 'utf8'));
const REGISTRY = JSON.parse(readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-registry.json'), 'utf8'));
const IDS = ['SF_P1', 'SF_P3', 'SF_S1', 'SF_S2', 'SF_S3', 'SF_S4', 'SF_S5', 'SF_S6', 'SF_D1', 'SF_D2'];
const VISIT_FLAGS = (
  latestSnapshotFromHistoryRuns(
    JSON.parse(readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-20261004-1706-latest-run.json'), 'utf8')),
  )?.display?.visit_flags ?? []
).map((f) => f.column);
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('the Spark saved run is read as labs wrote it', () => {
  it('takes the latest completed run and its declared visit flags', () => {
    expect(SNAP.byFLW).toHaveLength(60);
    expect(VISIT_FLAGS).toEqual(['repeat_counts_flag', 'gps_missing_flag', 'far_from_enrolment_flag']);
    expect(latestSnapshotFromHistoryRuns({ runs: [{ status: 'in_progress', period_end: '2026-12-01', data: {} }] })).toBeNull();
  });

  it('reads a raised flag in every shape labs returns it', () => {
    expect(['yes', 'Yes', true, 1, '1.0'].every(isFlagRaised)).toBe(true);
    expect(['no', false, 0, '', null, undefined].some(isFlagRaised)).toBe(false);
  });
});

describe('1. review routing follows the PDD (ace#2735: "11 of 12 ... approved with Sent to review blank")', () => {
  it('fails Spark: 11 of the 12 repeat-count-flagged records are not sent to review', () => {
    const r = checkReviewRouting(VISITS, VISIT_FLAGS, PLAN.review_routing ?? []);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/11 of 12 record\(s\) raising `repeat_counts_flag` do not follow PDD §7\.2 S-1/);
    expect(r.detail).toMatch(/flagged=false/);
  });

  it('fails a raised flag the plan gives no route — the generator default is what shipped', () => {
    const r = checkReviewRouting(VISITS, VISIT_FLAGS, PLAN.review_routing ?? []);
    expect(r.detail).toMatch(/4 record\(s\) raise `gps_missing_flag` but the plan declares no review route/);
  });

  it('passes once flagged records carry the route and the location flags are declared report-only', () => {
    const rows = copy(VISITS).map((v) => (isFlagRaised(v.repeat_counts_flag) ? { ...v, flagged: true } : v));
    const routes = [
      ...(PLAN.review_routing ?? []),
      { flag: 'gps_missing_flag', pdd_ref: 'PDD §5.6', report_only: 'location flags are reviewed, never a payment condition' },
      { flag: 'far_from_enrolment_flag', pdd_ref: 'PDD §5.6', report_only: 'location flags are reviewed, never a payment condition' },
    ];
    const r = checkReviewRouting(rows, VISIT_FLAGS, routes);
    expect(r.pass, r.detail).toBe(true);
    expect(r.detail).toMatch(/12 flagged record\(s\) all routed per PDD §7\.2 S-1/);
  });

  it('never passes on no rows', () => {
    expect(checkReviewRouting([], VISIT_FLAGS, PLAN.review_routing ?? []).pass).toBe(false);
  });
});

describe('2. worker-level rates are not binary (ace#2735: "can only be 0% or 100% ... false precision")', () => {
  it('fails Spark: Step 7 on time has a per-worker denominator of 1 for all 60 facilitators', () => {
    const r = checkWorkerRateDenominators(SNAP);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/SF_P3 "Step 7 on time": per-worker denominator ≤ 1 for 60 of 60 workers/);
    // SF_S5 is also n=1 everywhere but is not shown at worker level (scorecard: false).
    expect(r.detail).not.toMatch(/SF_S5/);
  });

  it('passes once the rate is not shown at worker level', () => {
    const s = copy(SNAP);
    s.display!.indicators!.SF_P3!.scorecard = false;
    expect(checkWorkerRateDenominators(s).pass).toBe(true);
  });

  it('passes once each worker has a real denominator', () => {
    const s = copy(SNAP);
    for (const w of s.byFLW!) w.ind!.SF_P3!.n = 3;
    expect(checkWorkerRateDenominators(s).pass).toBe(true);
  });

  it('is decidable before generation from the registry and the roster', () => {
    const ids = entityCountRateIndicators(REGISTRY);
    expect(ids).toEqual(['SF_P3']); // SF_S5 is flw_applicable: false
    const r = checkPlannedWorkerRates(PLAN, ids);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/60 of 60 workers own ≤ 1 entity/);
    const roomy = copy(PLAN);
    roomy.entities = roomy.workers!.flatMap((w, i) => [0, 1, 2].map((k) => ({ id: `e${i}_${k}`, name: `Place${i}x${k}`, worker: w.username })));
    expect(checkPlannedWorkerRates(roomy, ids).pass).toBe(true);
  });
});

describe('3. displayed columns vary (ace#2735: "two all-constant columns (Communities = 1, Repeat counts = 0.0%)")', () => {
  it('reports Repeat counts constant inside whole partners', () => {
    const r = checkConstantDisplayedColumns(SNAP, VISITS);
    const perPartner = r.findings.filter((f) => f.scope !== 'programme' && f.column.startsWith('SF_D1'));
    expect(perPartner.map((f) => f.scope)).toContain('Kuunika Outreach Network (example)');
  });

  // ace#2972: labs #2262 (2026-10-06) moved a uniform entity count out of the table into its
  // title ("Educators · 1 facility each", indicator_report_render.js `sameN`), so the column a
  // one-entity-per-worker PDD makes constant is never drawn. noora-health/20261015-1129 failed
  // check 26 on it with no legal fix.
  it('never fails the entity-count column: a uniform count is collapsed into the title, and noted', () => {
    const r = checkConstantDisplayedColumns(SNAP, VISITS);
    expect(r.findings.some((f) => /entity count|Communities/.test(f.column))).toBe(false);
    expect(r.detail).not.toMatch(/constant on every row: worker Communities/);
    expect(r.detail).toMatch(/Communities column not drawn: every worker has 1/);
    const three = copy(SNAP);
    three.byFLW!.forEach((w) => (w.rows = [1, 2, 3]));
    expect(checkConstantDisplayedColumns(three, VISITS).findings.some((f) => /Communities/.test(f.column))).toBe(false);
  });

  it('a varying roster is not noted as collapsed', () => {
    const s = copy(SNAP);
    s.byFLW!.forEach((w, i) => (w.rows = i % 2 ? [1, 2] : [1]));
    const r = checkConstantDisplayedColumns(s, VISITS);
    expect(r.pass).toBe(true);
    expect(r.detail).not.toMatch(/not drawn/);
  });

  it('fails a case field that is the same on every case', () => {
    const s = copy(SNAP);
    for (const c of s.cases!) c.step_number = 7;
    s.byFLW!.forEach((w, i) => (w.rows = i % 2 ? [1, 2] : [1]));
    const r = checkConstantDisplayedColumns(s);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/case step_number "FCAP step" = 7/);
  });
});

describe('4. drill levels branch (ace#2735: "a redundant single-row Opportunities level")', () => {
  it('counts children per parent from the saved run', () => {
    const c = drillLevelChildCounts(SNAP);
    expect(c['partner>opportunity']).toEqual([1, 1, 1, 1, 1]);
    expect(new Set(c['opportunity>worker'])).toEqual(new Set([12]));
    expect(new Set(c['worker>entity'])).toEqual(new Set([1]));
  });

  it('fails Spark on partner>opportunity; worker>entity passes only on its PDD-cited exemption', () => {
    const r = checkDrillLevels(SNAP, PLAN.single_child_levels);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/partner>opportunity: every one of 5 parents has exactly one child/);
    expect(r.detail).toMatch(/worker>entity.*exempted: PDD §6/);
    const unexempt = checkDrillLevels(SNAP, [{ level: 'worker>entity', reason: '' }]);
    expect(unexempt.detail).toMatch(/^partner>opportunity.*; worker>entity: every one of 60/);
  });

  it('passes when every level branches or is evidenced', () => {
    const r = checkDrillLevels(SNAP, [
      { level: 'partner>opportunity', reason: 'each example partner runs one opportunity; the template has no collapse' },
      { level: 'worker>entity', reason: 'PDD §6' },
    ]);
    expect(r.pass).toBe(true);
  });
});

describe('the story plan declares the review route and the evidenced single-child levels', () => {
  it('the named Spark plan still passes', () => {
    expect(checkCascadeStoryPlan(PLAN, IDS).verdict).toBe('pass');
  });

  it('fails an invented plan with a data-quality signal and no review route', () => {
    const p = copy(PLAN);
    delete p.review_routing;
    const r = checkCascadeStoryPlan(p, IDS);
    expect(r.verdict).toBe('fail');
    expect(r.findings.map((f) => f.detail).join(' ')).toMatch(/no `review_routing`/);
  });

  it('fails a route that is uncited, or both expect and report_only, or a blank exemption', () => {
    const p = copy(PLAN);
    p.review_routing = [{ flag: 'repeat_counts_flag', pdd_ref: 'the design', expect: { flagged: [true] }, report_only: 'x' }];
    p.single_child_levels = [{ level: 'worker>entity', reason: ' ' }];
    const msg = checkCascadeStoryPlan(p, IDS).findings.map((f) => f.detail).join(' ');
    expect(msg).toMatch(/cites no PDD section/);
    expect(msg).toMatch(/exactly one of `expect`/);
    expect(msg).toMatch(/no reason/);
  });
});

describe('wired into demo-data-setup-qa (ace-run provider)', () => {
  it('the four checks apply to the ace-run provider and are computed from the build output', () => {
    const ids = ['cascade_review_routing_follows_pdd', 'cascade_worker_rates_not_binary', 'cascade_displayed_columns_vary', 'cascade_drill_levels_branch'];
    for (const id of ids) expect(checksForProvider('ace-run')).toContain(id);
    const out = cascadeBuildOutcomes(PLAN, SNAP, VISITS);
    expect(Object.keys(out).sort()).toEqual([...ids].sort());
    // Spark's only programme-wide constant column was its entity count, which the render now
    // collapses into the title (ace#2972) — so check 26 passes on it; the other three still fail.
    expect(out.cascade_displayed_columns_vary.pass).toBe(true);
    expect(Object.entries(out).filter(([id]) => id !== 'cascade_displayed_columns_vary').every(([, r]) => r.pass === false)).toBe(true);
  });

  it('skills/demo-data-setup names the checks at § C3 and § C6', () => {
    const skill = readFileSync(join(__dirname, '../../skills/demo-data-setup/SKILL.md'), 'utf8');
    const c3 = skill.slice(skill.indexOf('**C3.'), skill.indexOf('**C4.'));
    const c6 = skill.slice(skill.indexOf('**C6.'), skill.indexOf('**C7.'));
    expect(c3).toMatch(/review_routing/);
    expect(c3).toMatch(/checkPlannedWorkerRates/);
    expect(c6).toMatch(/cascadeBuildOutcomes/);
  });
});

// ace#2973: pipeline_preview caps sample_size at 200 and, for a home-scoped visits pipeline,
// returns only the home partner (noora-health/20261015-1129, pipeline 9685: 200 rows, all opp
// 10137, row_count_before_sample 1270). The checks may judge a sample; they may not read as all.
describe('visit sample scope is stated, never implied (ace#2973)', () => {
  const homeOnly = { row_count_before_sample: 1270, rows: Array.from({ length: 200 }, () => ({ opportunity_id: 10137 })) };

  it('names a capped home-partner sample as a sample', () => {
    const scope = visitSampleScope([homeOnly])!;
    expect(scope).toMatch(/200 of 1270 \(opp 10137\)/);
    expect(scope).toMatch(/a SAMPLE, not every partner/);
  });

  it('a complete read is not called a sample; no input is null', () => {
    expect(visitSampleScope([{ row_count_before_sample: 2, rows: [{ opportunity_id: 1 }, { opportunity_id: 2 }] }])).toBe('visit rows judged: 2 of 2 (opps 1, 2)');
    expect(visitSampleScope([])).toBeNull();
  });

  it('cascadeBuildOutcomes appends the scope to the visit-reading checks only', () => {
    const scope = visitSampleScope([homeOnly]);
    const out = cascadeBuildOutcomes(PLAN, SNAP, VISITS, scope);
    expect(out.cascade_review_routing_follows_pdd.detail).toContain(scope!);
    expect(out.cascade_displayed_columns_vary.detail).toContain(scope!);
    expect(out.cascade_worker_rates_not_binary.detail).not.toContain('visit rows judged');
    expect(out.cascade_drill_levels_branch.detail).not.toContain('visit rows judged');
  });

  it('the skill contracts no longer demand sample_size ≥ row_count_before_sample', () => {
    for (const f of ['../../skills/demo-data-setup/SKILL.md', '../../skills/demo-data-setup-qa/SKILL.md']) {
      expect(readFileSync(join(__dirname, f), 'utf8')).not.toMatch(/`sample_size`\s*≥\s*`row_count_before_sample`/);
    }
  });
});
