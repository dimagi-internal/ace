/**
 * Static QA checks for `simulated-execution-qa`.
 *
 * The artifact is ONE JSON document, {@link SimulationDoc}: the run's
 * backdated calendar, what each week produced (by the verdicts of the
 * per-week QA and the review files), labs' saved weekly history read FRESH
 * with `workflow_history_runs`, the synthetic opportunity as labs describes
 * it, and the run's real-LLO handover fields. It judges the simulation as a
 * whole; each week's stock ledger is `supply-chain-operate-qa`'s job and each
 * review's numbers are `simulated-weekly-review-eval`'s.
 *
 * Two of the checks are the safety the simulated carve-out in
 * `agents/execution-manager.md` depends on: the data lives on a LABS-ONLY
 * opportunity filed under the ACE winner, and nothing on the run's
 * `selected_llo` handover was written (no Connect invite, no opportunity, no
 * email). Spec 2026-10-18 § G.
 *
 * The history check is grounded on a live capture of the spark-facilitator
 * cascade's rebuilt weekly history (labs workflow 7410,
 * `test/skills/simulated-execution-qa/fixtures/labs-workflow-7410-history.json`).
 */
import type { QACheck, QACheckResult } from '../../lib/qa-types';
import { assertSimCalendar, type SimCalendar } from '../../lib/sim-calendar';
import { assessSupplyMotion, type MotionInput } from '../../lib/sim-supply-motion';

export interface HistoryRun {
  run_id: number;
  period_start: string;
  period_end: string;
  status: string;
}

export interface SimulationDoc {
  calendar: SimCalendar;
  /** From run_state `optional_steps`. */
  enabled: { supply_chain: boolean; simulate_weeks: number };
  /** Week 0's QA verdicts (`supply-chain-procure-qa`, `supply-chain-fulfil-qa`), when supply_chain is on. */
  week0: { procure_qa: string | null; fulfil_qa: string | null };
  /** One entry per delivery week 1..N. */
  weeks: Array<{ w: number; operate_qa: string | null; review_file_id: string | null }>;
  /** `workflow_history_runs(..., generated_only: true)` on the weekly workflow, read fresh. */
  history: { definition_id: number | null; runs: HistoryRun[] };
  /** The opportunity the simulated visits live on, as `labs_context` describes it (its org's slug and name). */
  synthetic_opportunity: { id: number | null; org_slug: string | null; org_name: string | null };
  /** The ACE winner org's display name (run_state `selected_llo` / `connect_orgs.llo_org`). */
  winner_org_name: string;
  /** run_state `phases.solicitation-management.products.selected_llo`, verbatim. */
  selected_llo: Record<string, unknown>;
  /** Outbound sends in this run's comms-log during Phase 9 (expected 0). */
  phase9_sends: number;
  /** The review file ids the summary links. */
  summary_review_ids: string[];
  /**
   * The labs programme the supply chain was built on (run_state
   * `products.supply_chain.program_id`) and the programme labs files the
   * synthetic opportunity under (`products.simulation.program_id`). They must
   * be one id: labs reads visits into a worker's ledger only within one
   * registered synthetic programme (ace#3265).
   */
  supply_program_id?: number | null;
  visit_program_id?: number | null;
  /** `assessSupplyMotion`'s input, built from labs' reads `as_of` the last delivery day (supply_chain only). */
  supply_motion?: MotionInput | null;
  /**
   * The downstream reports on the synthetic opportunity, from `workflow_list({opportunity_id})`
   * and `workflow_history_runs` / the run ids recorded in `products.simulation.reports`.
   */
  reports?: Partial<Record<ReportRole, { workflow_id: number | null; opportunity_ids: number[]; runs: number }>>;
}

/** The three views a simulated delivery must leave a viewer: the program, the partner (LLO), and its workers. */
export const REPORT_ROLES = ['programme', 'partner', 'worker'] as const;
export type ReportRole = (typeof REPORT_ROLES)[number];

/** Every Phase 9 handover field only the REAL path writes (llo-onboarding, llo-launch). */
export const REAL_HANDOVER_FIELDS = [
  'program_application_id',
  'opportunity_id',
  'opportunity_url',
  'email_thread_id',
  'email_message_ids',
] as const;

/** Labs files labs-only opportunities from this id range (synthetic_create_labs_only; observed 10168 on connect-fi/20261018-1440). */
export const LABS_ONLY_ID_FLOOR = 10_000;

/**
 * Labs mints a labs-only org's slug as this prefix + the name
 * (`synthetic_org_slug`); `labs_context` carries no labs_only flag, so the
 * prefix and the id range are how a labs-only opportunity is recognised.
 */
export const LABS_ONLY_ORG_PREFIX = 'labs-synthetic-';

function withDoc(artifact: string, fn: (d: SimulationDoc) => QACheckResult): QACheckResult {
  let doc: SimulationDoc;
  try {
    doc = JSON.parse(artifact) as SimulationDoc;
  } catch (e) {
    return { pass: false, detail: `artifact is not JSON: ${(e as Error).message}`, auto_fix_hint: 'Rebuild the simulation document as JSON.' };
  }
  if (!doc || typeof doc !== 'object' || !doc.calendar || !Array.isArray(doc.weeks) || !doc.history || !doc.enabled) {
    return {
      pass: false,
      detail: 'artifact must carry calendar, enabled, weeks, history, synthetic_opportunity and selected_llo',
      auto_fix_hint: 'Re-read run_state and labs and rebuild the document per skills/simulated-execution-qa/SKILL.md § Process.',
    };
  }
  return fn(doc);
}

const deliveryWeeks = (doc: SimulationDoc) => doc.calendar.weeks.filter((wk) => wk.w >= 1);

export function checkCalendarBackdated(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    try {
      assertSimCalendar(doc.calendar);
    } catch (e) {
      return {
        pass: false,
        detail: (e as Error).message,
        auto_fix_hint: 'Recompute with `npx tsx scripts/sim-calendar.ts --run-started-at <run_state started_at> --weeks <N>`; never hand-edit the calendar.',
      };
    }
    if (doc.enabled.simulate_weeks && doc.calendar.delivery_weeks !== doc.enabled.simulate_weeks) {
      return {
        pass: false,
        detail: `calendar has ${doc.calendar.delivery_weeks} delivery weeks, optional_steps.simulate_weeks is ${doc.enabled.simulate_weeks}`,
        auto_fix_hint: 'Recompute the calendar with --weeks equal to optional_steps.simulate_weeks.',
      };
    }
    return { pass: true };
  });
}

export function checkWeek0SupplyChain(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    if (!doc.enabled.supply_chain) return { pass: true, detail: 'supply_chain not enabled: no week-0 procurement expected' };
    const bad: string[] = [];
    if (doc.week0.procure_qa !== 'pass') bad.push(`supply-chain-procure-qa is ${doc.week0.procure_qa ?? 'missing'}`);
    if (doc.week0.fulfil_qa !== 'pass') bad.push(`supply-chain-fulfil-qa is ${doc.week0.fulfil_qa ?? 'missing'}`);
    return bad.length === 0
      ? { pass: true }
      : { pass: false, detail: bad.join('; '), auto_fix_hint: 'Finish week 0 (procure, then fulfil) and pass their QA before any delivery week runs.' };
  });
}

export function checkEveryWeekOperated(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    if (!doc.enabled.supply_chain) return { pass: true, detail: 'supply_chain not enabled: no weekly stock operation expected' };
    const bad = deliveryWeeks(doc).flatMap((wk) => {
      const got = doc.weeks.find((x) => x.w === wk.w);
      return got?.operate_qa === 'pass' ? [] : [`week ${wk.w}: supply-chain-operate-qa is ${got?.operate_qa ?? 'missing'}`];
    });
    return bad.length === 0
      ? { pass: true }
      : { pass: false, detail: bad.join('; '), auto_fix_hint: 'Run supply-chain-operate for the week (a re-run replays by source.ref) and pass its QA.' };
  });
}

export function checkHistoryOneRunPerWeek(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    if (doc.history.definition_id === null) {
      return { pass: false, detail: 'no weekly workflow recorded', auto_fix_hint: 'Clone the Phase 7 semantic-snapshot report onto the synthetic opportunity (Step 4) and rebuild its history.' };
    }
    const bad = deliveryWeeks(doc).flatMap((wk) => {
      const hits = doc.history.runs.filter((r) => r.period_start === wk.start && r.period_end === wk.end && r.status === 'completed');
      if (hits.length === 1) return [];
      return [`week ${wk.w} (${wk.start}..${wk.end}): ${hits.length} completed runs`];
    });
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint:
            'workflow_rebuild_history({definition_id, opportunity_id, cadence: weekly, start: week1.start, end: weekN.end}); repeat with start=next_start until done. Check workflow_history_eligibility first.',
        };
  });
}

export function checkSyntheticOpportunityIsolated(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const o = doc.synthetic_opportunity;
    const bad: string[] = [];
    if (o.id === null) bad.push('no synthetic opportunity recorded');
    else if (o.id < LABS_ONLY_ID_FLOOR) bad.push(`opportunity ${o.id} is below ${LABS_ONLY_ID_FLOOR}: a real Connect opportunity, not a labs-only copy`);
    if (!(o.org_slug ?? '').startsWith(LABS_ONLY_ORG_PREFIX)) bad.push(`org ${o.org_slug} is not a labs-only org (${LABS_ONLY_ORG_PREFIX}…)`);
    if ((o.org_name ?? '').trim() !== doc.winner_org_name.trim()) {
      bad.push(`filed under "${o.org_name}", not the ACE winner "${doc.winner_org_name}"`);
    }
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint:
            'synthetic_create_labs_only({org_name: <winner org name>, ...}), generate into it with scripts/run-labs-synthetic-generate.ts, and repoint the weekly workflow at it (workflow_update_opportunity_ids); never simulate on the real Phase 4 opportunity.',
        };
  });
}

export function checkReviewPerWeek(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const missing = deliveryWeeks(doc).filter((wk) => !doc.weeks.find((x) => x.w === wk.w)?.review_file_id);
    return missing.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `no weekly review for week ${missing.map((m) => m.w).join(', ')}`,
          auto_fix_hint: 'Run simulated-weekly-review for each missing week, after that week\'s history run exists.',
        };
  });
}

export function checkNoRealLloContact(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const bad: string[] = [];
    if (doc.selected_llo.synthetic_winner !== true) bad.push('selected_llo.synthetic_winner is not true');
    for (const f of REAL_HANDOVER_FIELDS) {
      const v = doc.selected_llo[f];
      if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== '') bad.push(`selected_llo.${f} is set`);
    }
    if (doc.phase9_sends !== 0) bad.push(`${doc.phase9_sends} outbound send(s) in Phase 9's comms-log`);
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint:
            'A simulated Phase 9 sends no email and makes no Connect invite or opportunity. Stop the run and report it: a real-LLO step ran under simulated mode.',
        };
  });
}

export function checkSummaryLinksEveryWeek(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const want = doc.weeks.map((x) => x.review_file_id).filter((x): x is string => !!x);
    const missing = want.filter((id) => !doc.summary_review_ids.includes(id));
    return missing.length === 0 && want.length === doc.calendar.delivery_weeks
      ? { pass: true }
      : {
          pass: false,
          detail: missing.length ? `summary does not link review(s) ${missing.join(', ')}` : `summary links ${want.length} of ${doc.calendar.delivery_weeks} weeks`,
          auto_fix_hint: 'Rewrite simulated-execution_summary.md linking every week\'s review file.',
        };
  });
}

export function checkOneProgramme(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    if (!doc.enabled.supply_chain) return { pass: true, detail: 'supply_chain not enabled: no stock to tie to the visits' };
    const s = doc.supply_program_id ?? null;
    const v = doc.visit_program_id ?? null;
    if (s !== null && v !== null && s === v && v >= LABS_ONLY_ID_FLOOR) return { pass: true };
    return {
      pass: false,
      detail:
        s === null || v === null
          ? `supply programme ${s ?? 'unrecorded'}, visit programme ${v ?? 'unrecorded'}`
          : s !== v
            ? `the supply chain is on programme ${s} and the visits on programme ${v}: labs cannot read a handover off a visit across programmes`
            : `programme ${s} is not a labs-only synthetic programme (id < ${LABS_ONLY_ID_FLOOR})`,
      auto_fix_hint:
        'Build the supply chain on products.simulation.program_id (the labs-only programme simulated-execution Step 1 created), never on the Connect program (ace#3265). Records already on another programme cannot be moved or deleted: rebuild on a fresh synthetic programme.',
    };
  });
}

export function checkSupplyInMotion(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    if (!doc.enabled.supply_chain) return { pass: true, detail: 'supply_chain not enabled' };
    if (!doc.supply_motion) {
      return { pass: false, detail: 'no supply-motion reads recorded', auto_fix_hint: 'Read supply_chain_stock_flow and supply_chain_worker_stock (with and without opportunity_id) as of the last delivery day; see SKILL.md § Process.' };
    }
    const v = assessSupplyMotion(doc.supply_motion);
    return v.pass
      ? { pass: true, detail: `${v.figures.left_central} of ${v.figures.received} left the central store; ${v.figures.given_at_visits} given out at visits` }
      : {
          pass: false,
          detail: v.problems.join('; '),
          auto_fix_hint:
            'A ledger that balances is not a supply chain in motion. Check, in order: one programme for stock and visits; worker points carry opportunity_id; an active dispensing rule (and the hourly ingest has run); workers topped up with planWorkerTopUps; the manifest\'s handover share follows the PDD; stores carry latitude/longitude.',
        };
  });
}

export function checkDownstreamReports(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const opp = doc.synthetic_opportunity.id;
    const bad = REPORT_ROLES.flatMap((role) => {
      const r = doc.reports?.[role];
      if (!r || r.workflow_id === null) return [`no ${role} report`];
      if (opp === null || !r.opportunity_ids.includes(opp)) return [`the ${role} report ${r.workflow_id} does not read opportunity ${opp}`];
      if (r.runs < 1) return [`the ${role} report ${r.workflow_id} has no saved run`];
      return [];
    });
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint:
            'Clone Phase 7\'s cascade.programme_report, an opp report (cascade opp_report) and cascade.worker_review onto the synthetic opportunity (workflow_clone linked:true, then workflow_update_opportunity_ids), and save a run of each; see simulated-execution Step 4.',
        };
  });
}

export const CHECKS: QACheck[] = [
  { id: 'calendar_backdated', type: 'static', description: 'The calendar is Monday-aligned, contiguous, entirely before the run start, and N matches simulate_weeks', run: checkCalendarBackdated },
  { id: 'week0_supply_chain', type: 'static', description: "Week 0's procurement and fulfilment QA passed (supply_chain only)", run: checkWeek0SupplyChain },
  { id: 'every_week_operated', type: 'static', description: "Every delivery week's stock QA passed (supply_chain only)", run: checkEveryWeekOperated },
  { id: 'history_one_run_per_week', type: 'static', description: 'Labs holds exactly one completed saved run per delivery week, on its Monday-Sunday period', run: checkHistoryOneRunPerWeek },
  { id: 'synthetic_opportunity_isolated', type: 'static', description: 'The visits live on a labs-only opportunity (id ≥ 10000, labs-synthetic- org) filed under the ACE winner, never the real opportunity', run: checkSyntheticOpportunityIsolated },
  { id: 'review_per_week', type: 'static', description: 'Every delivery week has a weekly review', run: checkReviewPerWeek },
  { id: 'no_real_llo_contact', type: 'static', description: 'The winner is synthetic, no real handover field is set, and Phase 9 sent nothing', run: checkNoRealLloContact },
  { id: 'summary_links_every_week', type: 'static', description: "The summary links every week's review", run: checkSummaryLinksEveryWeek },
  { id: 'one_programme', type: 'static', description: 'The supply chain and the visits are on one labs-only synthetic programme (supply_chain only)', run: checkOneProgramme },
  { id: 'supply_in_motion', type: 'static', description: "Labs' own reads show stock moving: out of the central store, through workers who hold a float, given out at visits labs read (supply_chain only)", run: checkSupplyInMotion },
  { id: 'downstream_reports', type: 'static', description: 'A programme, a partner and a worker report read the synthetic opportunity, each with a saved run', run: checkDownstreamReports },
];
