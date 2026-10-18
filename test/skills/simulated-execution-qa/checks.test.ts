/**
 * Controls for skills/simulated-execution-qa/checks.ts.
 *
 * The weekly-history check is grounded on a LIVE capture: labs workflow 7410
 * (program 10100), the spark-facilitator/20261004-1706 cascade's history as
 * workflow_rebuild_history wrote it on 2026-10-06, read 2026-10-18. A
 * calendar for a run started 2026-10-06 with 4 delivery weeks lands weeks
 * 1-4 exactly on its last four periods, which is the shape a simulated
 * Phase 9 must leave. The other checks read run_state and ACE's own files;
 * their controls are built from the shapes the spec declares (§ G, § H).
 *
 * Commissioned by the optional labs track spec + plan (ace#3152, § G).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeSimCalendar } from '../../../lib/sim-calendar';
import {
  CHECKS,
  checkCalendarBackdated,
  checkEveryWeekOperated,
  checkHistoryOneRunPerWeek,
  checkNoRealLloContact,
  checkReviewPerWeek,
  checkSummaryLinksEveryWeek,
  checkSyntheticOpportunityIsolated,
  checkWeek0SupplyChain,
  type SimulationDoc,
} from '../../../skills/simulated-execution-qa/checks';

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/labs-workflow-7410-history.json', import.meta.url), 'utf-8')) as {
  definition_id: number;
  runs: SimulationDoc['history']['runs'];
};

function good(): SimulationDoc {
  return {
    calendar: computeSimCalendar('2026-10-06T09:00:00Z', 4),
    enabled: { supply_chain: true, simulate_weeks: 4 },
    week0: { procure_qa: 'pass', fulfil_qa: 'pass' },
    weeks: [1, 2, 3, 4].map((w) => ({ w, operate_qa: 'pass', review_file_id: `rev-${w}` })),
    history: { definition_id: LIVE.definition_id, runs: LIVE.runs },
    synthetic_opportunity: { id: 10_731, labs_only: true, org_name: 'ACE Test LLO (Synthetic)' },
    winner_org_name: 'ACE Test LLO (Synthetic)',
    selected_llo: { source: 'solicitation', org_slug: 'ace-test-llo-synthetic', synthetic_winner: true, response_id: 1000050 },
    phase9_sends: 0,
    summary_review_ids: ['rev-1', 'rev-2', 'rev-3', 'rev-4'],
  };
}

const run = (fn: (a: string) => { pass: boolean }, doc: SimulationDoc) => fn(JSON.stringify(doc));

describe('positive control: a complete simulation over the live history', () => {
  it('passes every check', () => {
    for (const c of CHECKS) expect(c.run(JSON.stringify(good())), c.id).toMatchObject({ pass: true });
  });

  it('the live periods are exactly weeks 1-4 of a 2026-10-06 calendar', () => {
    const cal = computeSimCalendar('2026-10-06', 4);
    expect(cal.weeks.slice(1).map((w) => w.end)).toEqual(LIVE.runs.slice(1).map((r) => r.period_end));
  });
});

describe('negative controls', () => {
  it('calendar_backdated: a week ending on the run day', () => {
    const d = good();
    d.calendar.run_started_on = d.calendar.weeks[4].end;
    expect(run(checkCalendarBackdated, d).pass).toBe(false);
  });

  it('calendar_backdated: N disagrees with simulate_weeks', () => {
    const d = good();
    d.enabled.simulate_weeks = 6;
    expect(run(checkCalendarBackdated, d).pass).toBe(false);
  });

  it('week0_supply_chain: fulfilment not passed', () => {
    const d = good();
    d.week0.fulfil_qa = 'fail';
    expect(run(checkWeek0SupplyChain, d).pass).toBe(false);
  });

  it('week0_supply_chain / every_week_operated: not required without supply_chain', () => {
    const d = good();
    d.enabled.supply_chain = false;
    d.week0 = { procure_qa: null, fulfil_qa: null };
    d.weeks.forEach((w) => (w.operate_qa = null));
    expect(run(checkWeek0SupplyChain, d).pass).toBe(true);
    expect(run(checkEveryWeekOperated, d).pass).toBe(true);
  });

  it('every_week_operated: a week with no stock QA', () => {
    const d = good();
    d.weeks[2].operate_qa = null;
    expect(run(checkEveryWeekOperated, d).pass).toBe(false);
  });

  it('history_one_run_per_week: a missing week (history cut short)', () => {
    const d = good();
    d.history.runs = LIVE.runs.slice(0, 4);
    const r = run(checkHistoryOneRunPerWeek, d) as { pass: boolean; detail?: string };
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/week 4/);
  });

  it('history_one_run_per_week: a duplicated period', () => {
    const d = good();
    d.history.runs = [...LIVE.runs, { ...LIVE.runs[2], run_id: 9999 }];
    expect(run(checkHistoryOneRunPerWeek, d).pass).toBe(false);
  });

  it('history_one_run_per_week: no workflow', () => {
    const d = good();
    d.history.definition_id = null;
    expect(run(checkHistoryOneRunPerWeek, d).pass).toBe(false);
  });

  it('synthetic_opportunity_isolated: the real Phase 4 opportunity', () => {
    const d = good();
    d.synthetic_opportunity = { id: 2166, labs_only: false, org_name: 'ACE Test LLO (Synthetic)' };
    expect(run(checkSyntheticOpportunityIsolated, d).pass).toBe(false);
  });

  it('synthetic_opportunity_isolated: filed under another org', () => {
    const d = good();
    d.synthetic_opportunity.org_name = 'ace-pm-org';
    expect(run(checkSyntheticOpportunityIsolated, d).pass).toBe(false);
  });

  it('review_per_week: a week with no review', () => {
    const d = good();
    d.weeks[0].review_file_id = null;
    expect(run(checkReviewPerWeek, d).pass).toBe(false);
  });

  it('no_real_llo_contact: a Connect invite was captured', () => {
    const d = good();
    d.selected_llo.program_application_id = '3f2a…';
    expect(run(checkNoRealLloContact, d).pass).toBe(false);
  });

  it('no_real_llo_contact: the winner is not marked synthetic', () => {
    const d = good();
    delete d.selected_llo.synthetic_winner;
    expect(run(checkNoRealLloContact, d).pass).toBe(false);
  });

  it('no_real_llo_contact: an email went out', () => {
    const d = good();
    d.phase9_sends = 1;
    expect(run(checkNoRealLloContact, d).pass).toBe(false);
  });

  it('summary_links_every_week: a review left out of the summary', () => {
    const d = good();
    d.summary_review_ids = ['rev-1', 'rev-2', 'rev-3'];
    expect(run(checkSummaryLinksEveryWeek, d).pass).toBe(false);
  });

  it('every check refuses a non-JSON artifact', () => {
    for (const c of CHECKS) expect(c.run('not json'), c.id).toMatchObject({ pass: false });
  });
});
