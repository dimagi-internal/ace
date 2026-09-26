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
const PLAN: CascadeStoryPlan = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-story.json'), 'utf8'),
);
const PERIODS: GradedPeriod[] = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/cascade/spark-facilitator-graded-periods.json'), 'utf8'),
).periods;
const IDS = ['SF_P1', 'SF_P3', 'SF_S1', 'SF_S2', 'SF_S3', 'SF_S4', 'SF_S5', 'SF_S6', 'SF_D1', 'SF_D2'];

const clone = (): CascadeStoryPlan => JSON.parse(JSON.stringify(PLAN));

describe('checkCascadeStoryPlan', () => {
  it('passes the Spark plan', () => {
    const r = checkCascadeStoryPlan(PLAN, IDS);
    expect(r.verdict).toBe('pass');
    expect(r.findings).toEqual([]);
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
