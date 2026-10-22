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
  checkOneProgramme,
  checkSupplyInMotion,
  checkDownstreamReports,
  type SimulationDoc,
} from '../../../skills/simulated-execution-qa/checks';

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/labs-workflow-7410-history.json', import.meta.url), 'utf-8')) as {
  definition_id: number;
  runs: SimulationDoc['history']['runs'];
};
const CTX = JSON.parse(readFileSync(new URL('./fixtures/labs-context-program-10100.json', import.meta.url), 'utf-8')) as {
  organization: { slug: string; name: string; programs: Array<{ opportunities: Array<{ id: number }> }> };
};
/**
 * connect-fi/20261018-1440's live supply reads (labs programme 361, read 2026-10-21): every
 * per-week QA passed, and the network barely moved (ace#3265). The shared fixture of
 * test/lib/sim-supply-motion.test.ts.
 */
const CONNECT_FI = JSON.parse(
  readFileSync(new URL('../../lib/fixtures/connect-fi-20261018-1440-supply-motion.json', import.meta.url), 'utf-8'),
) as NonNullable<SimulationDoc['supply_motion']>;
/** connect-fi/20261018-1440's Phase 9 products and the live workflow list on its synthetic opportunity. */
const FI9 = JSON.parse(readFileSync(new URL('./fixtures/connect-fi-20261018-1440-phase9.json', import.meta.url), 'utf-8')) as {
  run_state: { supply_chain: { program_id: number }; simulation: { synthetic_opportunity_id: number; workflow_id: number } };
  visit_program_id: number;
  workflow_list_opportunity_10168: { workflows: Array<{ id: number; template_type: string }> };
  history_runs_11926: number[];
};
/** How simulated-execution-qa § Process maps a workflow_list row to a report role. */
const ROLE_OF: Record<string, 'programme' | 'partner' | 'worker'> = {
  indicator_programme_report: 'programme',
  indicator_opp_report: 'partner',
  indicator_worker_review: 'worker',
};
/** The same network, moving: what a correct simulated Phase 9 leaves. */
const MOVING: NonNullable<SimulationDoc['supply_motion']> = {
  ...CONNECT_FI,
  flow: {
    nodes: CONNECT_FI.flow.nodes,
    links: CONNECT_FI.flow.links.map((l) => ({ ...l, series: l.source === 'c323' ? l.series : l.series.map((x) => x * 8) })),
  },
  workers_on_opportunity: [{ connect_username: 'moroto_w01', opportunity_id: 10168, dispensed: { amount: '24' } }],
  on_hand_by_week: Object.fromEntries(Object.keys(CONNECT_FI.on_hand_by_week).map((u) => [u, { 1: 6, 2: 4, 3: 5, 4: 3 }])),
  stores: CONNECT_FI.stores.map((st) => ({ ...st, has_coordinates: true })),
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
    supply_program_id: LIVE_OPP.id,
    visit_program_id: LIVE_OPP.id,
    supply_motion: MOVING,
    reports: {
      programme: { workflow_id: 1, opportunity_ids: [LIVE_OPP.id], runs: 4 },
      partner: { workflow_id: 2, opportunity_ids: [LIVE_OPP.id], runs: 4 },
      worker: { workflow_id: 3, opportunity_ids: [LIVE_OPP.id], runs: 1 },
    },
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
    expect(checkOneProgramme(a).pass).toBe(true);
    expect(checkSupplyInMotion(a).pass).toBe(true);
    expect(checkDownstreamReports(a).pass).toBe(true);
    expect(CHECKS).toHaveLength(11);
  });

  it('the live periods are exactly weeks 1-4 of a 2026-10-06 calendar', () => {
    const cal = computeSimCalendar('2026-10-06', 4);
    expect(cal.weeks.slice(1).map((w) => w.end)).toEqual(LIVE.runs.slice(1).map((r) => r.period_end));
  });
});

describe('negative controls: connect-fi/20261018-1440 as it was left (ace#3265, live reads 2026-10-21)', () => {
  it('one_programme: supply chain on Connect programme 361, visits on labs-only programme 10168', () => {
    const r = checkOneProgramme(
      JSON.stringify({ ...good(), supply_program_id: FI9.run_state.supply_chain.program_id, visit_program_id: FI9.visit_program_id }),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/programme 361 and the visits on programme 10168/);
  });

  it('supply_in_motion: every worker at 0, workers not on the opportunity, no handover read off a visit', () => {
    const r = checkSupplyInMotion(JSON.stringify({ ...good(), supply_motion: CONNECT_FI }));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/not tied to the visit opportunity/);
    expect(r.detail).toMatch(/carry no float/);
  });

  it('downstream_reports: only the programme report 11926 read opportunity 10168', () => {
    const opp = FI9.run_state.simulation.synthetic_opportunity_id;
    const reports = Object.fromEntries(
      FI9.workflow_list_opportunity_10168.workflows.map((w) => [
        ROLE_OF[w.template_type],
        { workflow_id: w.id, opportunity_ids: [opp], runs: w.id === FI9.run_state.simulation.workflow_id ? FI9.history_runs_11926.length : 0 },
      ]),
    );
    const r = checkDownstreamReports(JSON.stringify({ ...good(), synthetic_opportunity: { ...LIVE_OPP, id: opp }, reports }));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/no partner report; no worker report/);
  });

  it('the three new checks pass trivially only when supply_chain is off (reports still required)', () => {
    const off = JSON.stringify({ ...good(), enabled: { supply_chain: false, simulate_weeks: 4 }, supply_motion: null, supply_program_id: null });
    expect(checkOneProgramme(off).pass).toBe(true);
    expect(checkSupplyInMotion(off).pass).toBe(true);
    expect(checkDownstreamReports(JSON.stringify({ ...good(), reports: {} })).pass).toBe(false);
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
