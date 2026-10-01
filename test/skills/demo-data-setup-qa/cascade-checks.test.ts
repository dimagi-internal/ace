import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cascadeDashboards,
  checkCascadeHandoff,
  checkParUrlScope,
  checkRealizedFlat,
  checksForProvider,
  periodsFromHistoryRuns,
  type SyntheticProducts,
} from '../../../skills/demo-data-setup-qa/checks';

// The shape spark-facilitator/20260926-1800 recorded (ace-run provider).
const spark: SyntheticProducts = {
  provider: 'ace-run',
  cascade: {
    registry: { registry_id: 6369, indicators: ['SF_P1', 'SF_S1'] },
    program_id: 10082,
    partners: [
      { label: 'Partner A', opportunity_id: 10082 },
      { label: 'Partner B', opportunity_id: 10083 },
      { label: 'Partner C', opportunity_id: 10084 },
    ],
    programme_report: { workflow_id: 6371, run_id: 6394, url: 'https://labs.connect.dimagi.com/labs/workflow/6371/run/?run_id=6394&program_id=10082' },
    opp_reports: [
      { partner: 'Partner A', opportunity_id: 10082, workflow_id: 6376, run_id: 6431, url: 'https://labs.connect.dimagi.com/labs/workflow/6376/run/?run_id=6431&opportunity_id=10082' },
      { partner: 'Partner B', opportunity_id: 10083, workflow_id: 6378, run_id: 6432, url: 'https://labs.connect.dimagi.com/labs/workflow/6378/run/?run_id=6432&opportunity_id=10083' },
      { partner: 'Partner C', opportunity_id: 10084, workflow_id: 6380, run_id: 6433, url: 'https://labs.connect.dimagi.com/labs/workflow/6380/run/?run_id=6433&opportunity_id=10084' },
    ],
    history: { run_ids: [6382, 6393, 6394] },
  },
  workflows: {
    programme_report: { workflow_id: 6371 },
    partner_a_opp_report: { workflow_id: 6376 },
    partner_b_opp_report: { workflow_id: 6378 },
    partner_c_opp_report: { workflow_id: 6380 },
  },
};

// ace#2510 (the ace-run cascade provider). Real artifacts of spark-facilitator/20260926-1800, read from Drive 2026-10-01.
const FIX = join(__dirname, '../../fixtures/qa-gaps');
const realSynthetic = JSON.parse(readFileSync(join(FIX, 'spark-20260926-1800-synthetic.json'), 'utf8')).synthetic as SyntheticProducts;
const realRealized = JSON.parse(readFileSync(join(FIX, 'spark-20260926-1800-realized.json'), 'utf8')).realized as Record<string, unknown>;

describe('ace-run provider checks — on the real Spark handoff', () => {
  it('passes the real cascade handoff and fails it once a partner report is dropped', () => {
    expect(checkCascadeHandoff(realSynthetic).pass).toBe(true);
    const dropped = JSON.parse(readFileSync(join(FIX, 'spark-20260926-1800-synthetic.json'), 'utf8')).synthetic as SyntheticProducts;
    dropped.cascade!.opp_reports = dropped.cascade!.opp_reports!.slice(0, 2);
    const r = checkCascadeHandoff(dropped);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/Partner C has no opp report/);
  });

  it('accepts the real flat realized map and rejects it once a value is nested', () => {
    expect(checkRealizedFlat(realRealized).pass).toBe(true);
    const nested = JSON.parse(readFileSync(join(FIX, 'spark-20260926-1800-realized.json'), 'utf8')).realized as Record<string, unknown>;
    nested.primary_par_url = { url: nested.primary_par_url };
    expect(checkRealizedFlat(nested).pass).toBe(false);
  });
});

describe('ace-run provider checks', () => {
  it('names a non-empty check set per provider and none for an unknown one', () => {
    expect(checksForProvider('ace-run')).toContain('cascade_story_landed');
    expect(checksForProvider('denovo').length).toBeGreaterThan(5);
    expect(checksForProvider(undefined)).toEqual([]);
  });

  it('scopes the programme report by program and the opp reports by opportunity', () => {
    const d = cascadeDashboards(spark);
    expect(d.map((x) => x.template)).toEqual(['indicator_programme_report', 'indicator_opp_report', 'indicator_opp_report', 'indicator_opp_report']);
    expect(checkParUrlScope(d).pass).toBe(true);
  });

  it('passes a complete cascade and names each gap in an incomplete one', () => {
    expect(checkCascadeHandoff(spark).pass).toBe(true);
    const broken: SyntheticProducts = {
      ...spark,
      cascade: { ...spark.cascade, partners: spark.cascade!.partners!.slice(0, 2), programme_report: { ...spark.cascade!.programme_report, run_id: 6382 } },
      workflows: { programme_report: { workflow_id: 6371 } },
    };
    const r = checkCascadeHandoff(broken);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/2 partner/);
    expect(r.detail).toMatch(/not the latest history run 6394/);
    expect(r.detail).toMatch(/not mirrored/);
    expect(checkCascadeHandoff({ provider: 'ace-run' }).pass).toBe(false);
  });

  it('maps saved runs to graded periods, skipping the in-progress run', () => {
    const snap = (v: number) => ({ snapshot: { state: { snapshot: { byLLO: [{ llo: 'Partner A', ind: { SF_P1: { value: v } } }], byFLW: [], programInd: {} } } } });
    const periods = periodsFromHistoryRuns({
      runs: [
        { status: 'completed', period_end: '2026-07-05', data: snap(0.5) },
        { status: 'completed', period_end: '2026-06-28', data: snap(0.4) },
        { status: 'in_progress', period_end: '2026-09-20', data: { snapshot: { state: {} } } },
      ],
    });
    expect(periods.map((p) => p.period_end)).toEqual(['2026-06-28', '2026-07-05']);
    expect(periods[1].byLLO[0].ind.SF_P1?.value).toBe(0.5);
  });

  it('requires a flat realized map', () => {
    expect(checkRealizedFlat({ a: 'x' }).pass).toBe(true);
    expect(checkRealizedFlat({ a: { b: 1 } }).pass).toBe(false);
    expect(checkRealizedFlat(null).pass).toBe(false);
  });
});
