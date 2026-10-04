import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkCascadeStoryPlan,
  verifyCascadeStoryLanded,
  type CascadeStoryPlan,
  type GradedPeriod,
} from '../../lib/cascade-story';

// Fixtures from the live proof (ace#2510, spark-facilitator/20260926-1800): the
// story plan ACE authored, and the 13 saved weekly runs labs graded for
// programme report 6371 (worker rows kept for the latest run only).
// The plan AS AUTHORED labelled its invented partners "Partner A/B/C" for a
// single-implementer pilot — the defect the illustrative-label rule exists for
// (outsider eval, spark-facilitator/20261001-2208). Every other test runs on the
// same plan relabelled the way C0 now requires ("Example partner A").
const AUTHORED_PLAN: CascadeStoryPlan = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-story.json'), 'utf8'),
);
const relabel = (text: string) => text.replace(/\bPartner ([ABC])\b/g, 'Example partner $1');
const PLAN: CascadeStoryPlan = JSON.parse(
  relabel(readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-story.json'), 'utf8')),
);
const PERIODS: GradedPeriod[] = JSON.parse(
  relabel(readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-graded-periods.json'), 'utf8')),
).periods;
const IDS = ['SF_P1', 'SF_P3', 'SF_S1', 'SF_S2', 'SF_S3', 'SF_S4', 'SF_S5', 'SF_S6', 'SF_D1', 'SF_D2'];

const clone = (): CascadeStoryPlan => JSON.parse(JSON.stringify(PLAN));

describe('checkCascadeStoryPlan', () => {
  it('passes the Spark plan', () => {
    const r = checkCascadeStoryPlan(PLAN, IDS);
    expect(r.verdict).toBe('pass');
    expect(r.findings).toEqual([]);
  });

  it('refuses invented partners labelled as if they were real implementers (the authored Spark plan)', () => {
    const r = checkCascadeStoryPlan(AUTHORED_PLAN, IDS);
    expect(r.verdict).toBe('fail');
    const msg = r.findings.map((f) => f.detail).join(' ');
    expect(msg).toMatch(/"Partner A", "Partner B", "Partner C" do not say they are illustrative/);
    expect(msg).toMatch(/names 1 implementing organisation/);
  });

  it('accepts a programme mirror only when its partner count matches the PDD', () => {
    const ok = { ...clone(), partner_source: 'programme' as const, implementing_orgs: 3 };
    expect(checkCascadeStoryPlan(ok, IDS).verdict).toBe('pass');
    const bad = { ...clone(), partner_source: 'programme' as const, implementing_orgs: 1 };
    const r = checkCascadeStoryPlan(bad, IDS);
    expect(r.verdict).toBe('fail');
    expect(r.findings.map((f) => f.detail).join()).toMatch(/PDD names 1 implementing/);
  });

  it('requires all four signal kinds', () => {
    const p = clone();
    p.signals = p.signals.filter((s) => s.kind !== 'trend');
    const r = checkCascadeStoryPlan(p, IDS);
    expect(r.verdict).toBe('fail');
    expect(r.findings.map((f) => f.signal)).toContain('trend');
  });

  it('refuses fewer than three partners', () => {
    const p = clone();
    p.partners = p.partners.slice(0, 2);
    expect(checkCascadeStoryPlan(p, IDS).verdict).toBe('fail');
  });

  it('refuses a partner on a real (non-labs-only) opportunity', () => {
    const p = clone();
    p.partners[0].opportunity_id = 2296;
    expect(checkCascadeStoryPlan(p, IDS).findings.map((f) => f.detail).join()).toMatch(/labs-only/);
  });

  it('refuses a signal with no PDD citation', () => {
    const p = clone();
    p.signals[2].pdd_ref = 'looks suspicious';
    expect(checkCascadeStoryPlan(p, IDS).verdict).toBe('fail');
  });

  it('refuses a signal on an indicator the registry lacks', () => {
    const p = clone();
    p.signals[1].indicator = 'SF_X9';
    expect(checkCascadeStoryPlan(p, IDS).verdict).toBe('fail');
  });

  it('refuses a worker carrier who is not on the roster', () => {
    const p = clone();
    p.signals[1].carrier = 'cbf_z99';
    expect(checkCascadeStoryPlan(p, IDS).verdict).toBe('fail');
  });
});

describe('verifyCascadeStoryLanded — against what labs actually graded', () => {
  it('all four authored Spark signals landed', () => {
    const r = verifyCascadeStoryLanded(PLAN, PERIODS);
    expect(r.results.map((x) => [x.kind, x.landed])).toEqual([
      ['lagging_partner', true],
      ['standout_worker', true],
      ['data_quality', true],
      ['trend', true],
    ]);
    expect(r.verdict).toBe('pass');
  });

  it('a signal pinned on the wrong carrier does not land', () => {
    const p = clone();
    p.signals[0].carrier = 'Partner A'; // A is the programme's second-best on regularity
    expect(verifyCascadeStoryLanded(p, PERIODS).results[0].landed).toBe(false);
  });

  it('a trend declared in the wrong direction does not land', () => {
    const p = clone();
    p.signals[3].trend_direction = 'down';
    expect(verifyCascadeStoryLanded(p, PERIODS).results[3].landed).toBe(false);
  });

  it('with no saved runs nothing lands', () => {
    expect(verifyCascadeStoryLanded(PLAN, []).verdict).toBe('fail');
  });
});

describe('a programme story with two real partners and no PDD', () => {
  const CHLORINE: CascadeStoryPlan = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/cascade/chlorine-story.json'), 'utf8'),
  );
  const CL_IDS = ['CL_Q1', 'CL_D1', 'CL_U1', 'CL_D2', 'CL_X1', 'CL_D3', 'CL_R1', 'CL_R2', 'CL_X2'];

  it('passes with the real partner count and app-cited signals, warning about the benchmark', () => {
    const r = checkCascadeStoryPlan(CHLORINE, CL_IDS);
    expect(r.verdict).toBe('pass');
    expect(r.findings.map((f) => f.severity)).toEqual(['warn']);
  });

  it('refuses two partners when the plan says ACE invented them', () => {
    const p: CascadeStoryPlan = JSON.parse(JSON.stringify(CHLORINE));
    p.partner_source = 'invented';
    expect(checkCascadeStoryPlan(p, CL_IDS).verdict).toBe('fail');
  });

  it('refuses one partner even for a real programme — nothing to compare', () => {
    const p: CascadeStoryPlan = JSON.parse(JSON.stringify(CHLORINE));
    p.partners = p.partners.slice(0, 1);
    expect(checkCascadeStoryPlan(p, CL_IDS).verdict).toBe('fail');
  });

  it('refuses an app-anchored signal that names no Deliver app form', () => {
    const p: CascadeStoryPlan = JSON.parse(JSON.stringify(CHLORINE));
    p.signals[0].pdd_ref = 'the obvious water-quality metric';
    expect(checkCascadeStoryPlan(p, CL_IDS).findings.map((f) => f.signal)).toContain(p.signals[0].kind);
  });
});

