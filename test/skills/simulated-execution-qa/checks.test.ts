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
const CTX = JSON.parse(readFileSync(new URL('./fixtures/labs-context-program-10100.json', import.meta.url), 'utf-8')) as {
  organization: { slug: string; name: string; programs: Array<{ opportunities: Array<{ id: number }> }> };
};
/** The captured labs-only org, as the synthetic opportunity's record. */
const LIVE_OPP = {
  id: CTX.organization.programs[0].opportunities[0].id,
  org_slug: CTX.organization.slug,
  org_name: CTX.organization.name,
};

function good(): SimulationDoc {
  return {
    calendar: computeSimCalendar('2026-10-06T09:00:00Z', 4),
    enabled: { supply_chain: true, simulate_weeks: 4 },
    week0: { procure_qa: 'pass', fulfil_qa: 'pass' },
    weeks: [1, 2, 3, 4].map((w) => ({ w, operate_qa: 'pass', review_file_id: `rev-${w}` })),
    history: { definition_id: LIVE.definition_id, runs: LIVE.runs },
    synthetic_opportunity: LIVE_OPP,
    winner_org_name: LIVE_OPP.org_name,
    selected_llo: { source: 'solicitation', org_slug: 'ace-test-llo-synthetic', synthetic_winner: true, response_id: 1000050 },
    phase9_sends: 0,
    summary_review_ids: ['rev-1', 'rev-2', 'rev-3', 'rev-4'],
  };
}

describe('positive control: a complete simulation over the live history', () => {
  it('passes every check', () => {
    const a = JSON.stringify(good());
    expect(checkCalendarBackdated(a).pass).toBe(true);
    expect(checkWeek0SupplyChain(a).pass).toBe(true);
    expect(checkEveryWeekOperated(a).pass).toBe(true);
    expect(checkHistoryOneRunPerWeek(a).pass).toBe(true);
    expect(checkSyntheticOpportunityIsolated(a).pass).toBe(true);
    expect(checkReviewPerWeek(a).pass).toBe(true);
    expect(checkNoRealLloContact(a).pass).toBe(true);
    expect(checkSummaryLinksEveryWeek(a).pass).toBe(true);
    expect(CHECKS).toHaveLength(8);
  });

  it('the live periods are exactly weeks 1-4 of a 2026-10-06 calendar', () => {
    const cal = computeSimCalendar('2026-10-06', 4);
    expect(cal.weeks.slice(1).map((w) => w.end)).toEqual(LIVE.runs.slice(1).map((r) => r.period_end));
  });
});

describe('negative controls', () => {
  it('calendar_backdated: a calendar laid on labs\' real weekly periods passes; one reaching the run day fails', () => {
    const d = good();
    d.calendar.weeks.slice(1).forEach((wk, i) => {
      expect([wk.start, wk.end]).toEqual([LIVE.runs[i + 1].period_start, LIVE.runs[i + 1].period_end]);
    });
    expect(checkCalendarBackdated(JSON.stringify(d)).pass).toBe(true);
    d.calendar.run_started_on = d.calendar.weeks[4].end;
    expect(checkCalendarBackdated(JSON.stringify(d)).pass).toBe(false);
  });

  it('calendar_backdated: N disagrees with simulate_weeks', () => {
    const d = good();
    d.enabled.simulate_weeks = 6;
    expect(checkCalendarBackdated(JSON.stringify(d)).pass).toBe(false);
  });

  it('week0_supply_chain: fulfilment not passed', () => {
    const d = good();
    d.week0.fulfil_qa = 'fail';
    expect(checkWeek0SupplyChain(JSON.stringify(d)).pass).toBe(false);
  });

  it('week0_supply_chain / every_week_operated: not required without supply_chain', () => {
    const d = good();
    d.enabled.supply_chain = false;
    d.week0 = { procure_qa: null, fulfil_qa: null };
    d.weeks.forEach((w) => (w.operate_qa = null));
    expect(checkWeek0SupplyChain(JSON.stringify(d)).pass).toBe(true);
    expect(checkEveryWeekOperated(JSON.stringify(d)).pass).toBe(true);
  });

  it('every_week_operated: a week with no stock QA', () => {
    const d = good();
    d.weeks[2].operate_qa = null;
    expect(checkEveryWeekOperated(JSON.stringify(d)).pass).toBe(false);
  });

  it('history_one_run_per_week: a missing week (history cut short)', () => {
    const d = good();
    d.history.runs = LIVE.runs.slice(0, 4);
    const r = checkHistoryOneRunPerWeek(JSON.stringify(d));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/week 4/);
  });

  it('history_one_run_per_week: a duplicated period', () => {
    const d = good();
    d.history.runs = [...LIVE.runs, { ...LIVE.runs[2], run_id: 9999 }];
    expect(checkHistoryOneRunPerWeek(JSON.stringify(d)).pass).toBe(false);
  });

  it('history_one_run_per_week: no workflow', () => {
    const d = good();
    d.history.definition_id = null;
    expect(checkHistoryOneRunPerWeek(JSON.stringify(d)).pass).toBe(false);
  });

  it('synthetic_opportunity_isolated: the captured labs-only org passes; a real Connect org and opp fail', () => {
    const d = good();
    d.synthetic_opportunity = { id: CTX.organization.programs[0].opportunities[1].id, org_slug: CTX.organization.slug, org_name: CTX.organization.name };
    d.winner_org_name = CTX.organization.name;
    expect(checkSyntheticOpportunityIsolated(JSON.stringify(d)).pass).toBe(true);
    // The real Phase 4 shape: a Connect org slug and a sub-10000 opportunity id.
    d.synthetic_opportunity = { id: 2166, org_slug: 'ace-nm-org', org_name: CTX.organization.name };
    expect(checkSyntheticOpportunityIsolated(JSON.stringify(d)).pass).toBe(false);
  });

  it('synthetic_opportunity_isolated: the captured labs-only org under a name other than the winner\'s', () => {
    const d = good();
    d.synthetic_opportunity = { id: CTX.organization.programs[0].opportunities[0].id, org_slug: CTX.organization.slug, org_name: CTX.organization.name };
    d.winner_org_name = 'ACE Test LLO (Synthetic)';
    expect(checkSyntheticOpportunityIsolated(JSON.stringify(d)).pass).toBe(false);
  });

  it('review_per_week: a week with no review', () => {
    const d = good();
    d.weeks[0].review_file_id = null;
    expect(checkReviewPerWeek(JSON.stringify(d)).pass).toBe(false);
  });

  it('no_real_llo_contact: a Connect invite was captured', () => {
    const d = good();
    d.selected_llo.program_application_id = '3f2a…';
    expect(checkNoRealLloContact(JSON.stringify(d)).pass).toBe(false);
  });

  it('no_real_llo_contact: the winner is not marked synthetic', () => {
    const d = good();
    delete d.selected_llo.synthetic_winner;
    expect(checkNoRealLloContact(JSON.stringify(d)).pass).toBe(false);
  });

  it('no_real_llo_contact: an email went out', () => {
    const d = good();
    d.phase9_sends = 1;
    expect(checkNoRealLloContact(JSON.stringify(d)).pass).toBe(false);
  });

  it('summary_links_every_week: a review left out of the summary', () => {
    const d = good();
    d.summary_review_ids = ['rev-1', 'rev-2', 'rev-3'];
    expect(checkSummaryLinksEveryWeek(JSON.stringify(d)).pass).toBe(false);
  });

  it('every check refuses a non-JSON artifact', () => {
    for (const c of CHECKS) expect(c.run('not json'), c.id).toMatchObject({ pass: false });
  });
});
