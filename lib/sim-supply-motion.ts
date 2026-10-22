/**
 * The two halves of a simulated supply chain that has to LOOK like it is
 * working, not just pass its ledger checks (connect-fi/20261018-1440).
 *
 * That run's ledger balanced every week and every QA passed, yet nothing a
 * viewer opens looked alive: 44 of 814 phones left the central store in four
 * weeks, every worker held 0 at every week end (resupply was exactly that
 * week's handovers and no worker kept a float), and the visits sat on a
 * different labs programme from the stock, so labs never read a handover off
 * a visit (ace#3265). Both helpers are pure; the skills call them.
 *
 * - {@link planWorkerTopUps}: what each worker is issued each week so they
 *   hold a float between visits. A worker hands over from stock they already
 *   hold, and is topped back up to the float.
 * - {@link assessSupplyMotion}: the "in motion" verdict over labs' own reads
 *   (`supply_chain_stock_flow`, `supply_chain_worker_stock`), which
 *   `simulated-execution-qa` gates on.
 */

/** Per worker, issue events (handovers) per delivery week: `{username: {week: n}}`. */
export type IssuesByWorker = Record<string, Record<number, number>>;

export interface TopUpPlan {
  /** The float each worker is topped up to, in issue units. */
  float: Record<string, number>;
  /** `{username: {week: quantity issued at the start of that week}}`. */
  issued: Record<string, Record<number, number>>;
  /** `{username: {week: on hand at the end of that week}}` if every planned issue is handed over. */
  on_hand_end: Record<string, Record<number, number>>;
}

/**
 * Plan each worker's weekly issues so they carry a float.
 *
 * A worker's float is `float_weeks` times their AVERAGE weekly handovers,
 * rounded up, and at least `min_float`. At the start of each week the LLO
 * issues that week's handovers plus whatever brings the worker back to the
 * float, so they end every week holding it and a planned handover never
 * draws them below zero. Two shapes this replaces, both seen on connect-fi:
 * - sizing by the BUSIEST week front-loads every phone into week 1 when one
 *   week spikes (the card-collection round: floats of 8-18 handsets, then
 *   almost nothing moved for three weeks);
 * - topping up only to the larger of float and handovers empties every
 *   worker in the spike week.
 *
 * There is no "withhold a top-up" option: labs' dispensing rule takes every
 * handover off the worker's stock from the visits whatever was issued, so a
 * withheld top-up drives the ledger negative rather than making a stockout.
 * The planted stockout is a worker's self-reported zero count instead
 * (`supply-chain-operate` Step 5), which labs reads as variance.
 */
export function planWorkerTopUps(input: {
  issues: IssuesByWorker;
  weeks: number;
  float_weeks?: number;
  min_float?: number;
}): TopUpPlan {
  const floatWeeks = input.float_weeks ?? 2;
  const minFloat = input.min_float ?? 1;
  if (!Number.isInteger(input.weeks) || input.weeks < 1) throw new Error(`weeks must be a positive integer, got ${input.weeks}`);
  if (!(floatWeeks > 0)) throw new Error(`float_weeks must be positive, got ${floatWeeks}`);
  const plan: TopUpPlan = { float: {}, issued: {}, on_hand_end: {} };
  for (const [username, byWeek] of Object.entries(input.issues)) {
    const counts = Array.from({ length: input.weeks }, (_, i) => byWeek[i + 1] ?? 0);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const float = Math.max(minFloat, Math.ceil(mean * floatWeeks));
    plan.float[username] = float;
    plan.issued[username] = {};
    plan.on_hand_end[username] = {};
    let held = 0;
    for (let w = 1; w <= input.weeks; w++) {
      const handovers = counts[w - 1];
      const issue = Math.max(0, handovers + float - held);
      plan.issued[username][w] = issue;
      held = held + issue - handovers;
      plan.on_hand_end[username][w] = held;
    }
  }
  return plan;
}

/** The subset of `supply_chain_stock_flow` this reads. */
export interface FlowRead {
  nodes: Array<{ id: string; kind: string; name?: string }>;
  links: Array<{ source: string; target: string; series: number[] }>;
}

/** The subset of one `supply_chain_worker_stock` row this reads. */
export interface WorkerStockRead {
  connect_username: string | null;
  opportunity_id: number | null;
  dispensed: { amount: string } | null;
}

export interface MotionInput {
  flow: FlowRead;
  /** `supply_chain_worker_stock` rows `as_of` the last day, read WITH `opportunity_id` = the visit opportunity. */
  workers_on_opportunity: WorkerStockRead[];
  /** `supply_chain_worker_stock` `on_hand` per worker per week end: `{username: {week: amount}}`. */
  on_hand_by_week: Record<string, Record<number, number>>;
  /** Stores (central, regional) and whether labs holds coordinates for them. */
  stores: Array<{ id: number; has_coordinates: boolean }>;
  /** The visit opportunity. */
  opportunity_id: number;
  /** The smallest share of received stock that must have left the central store by the last week. */
  min_share_out?: number;
}

export interface MotionVerdict {
  pass: boolean;
  problems: string[];
  figures: { received: number; left_central: number; given_at_visits: number; workers: number; workers_ever_holding: number };
}

const last = (s: number[]) => (s.length ? s[s.length - 1] : 0);

/**
 * Whether labs' own reads show a supply chain in motion, in the five ways a
 * viewer of Overview / Workers / Where it went / Map would notice it is not.
 */
export function assessSupplyMotion(input: MotionInput): MotionVerdict {
  const minShare = input.min_share_out ?? 0.25;
  const problems: string[] = [];
  const sources = new Set(input.flow.nodes.filter((n) => n.kind === 'source').map((n) => n.id));
  const workerNodes = new Set(input.flow.nodes.filter((n) => n.kind === 'worker').map((n) => n.id));
  const stores = input.flow.nodes.filter((n) => n.kind === 'store').map((n) => n.id);

  const received = input.flow.links.filter((l) => sources.has(l.source)).reduce((a, l) => a + last(l.series), 0);
  const central = new Set(input.flow.links.filter((l) => sources.has(l.source)).map((l) => l.target));
  const leftCentral = input.flow.links
    .filter((l) => central.has(l.source) && !central.has(l.target))
    .reduce((a, l) => a + last(l.series), 0);
  const given = input.flow.links.filter((l) => l.target === 'given').reduce((a, l) => a + last(l.series), 0);
  const givenByWorker = new Map<string, number>();
  for (const l of input.flow.links) if (l.target === 'given' && workerNodes.has(l.source)) givenByWorker.set(l.source, last(l.series));

  if (received <= 0) problems.push('nothing was received into the network (no order arrived)');
  if (received > 0 && leftCentral / received < minShare) {
    problems.push(`only ${leftCentral} of ${received} received left the central store (${Math.round((100 * leftCentral) / received)}%, need ≥ ${Math.round(minShare * 100)}%)`);
  }
  if (stores.length < 2) problems.push(`the flow shows ${stores.length} store(s); a distribution network needs a central and a field store`);
  const idle = [...workerNodes].filter((id) => !(givenByWorker.get(id) ?? 0));
  if (workerNodes.size === 0) problems.push('no field worker appears in the flow');
  else if (idle.length) problems.push(`${idle.length} of ${workerNodes.size} workers gave nothing out at visits`);

  const dispensedFromVisits = input.workers_on_opportunity.filter((r) => Number(r.dispensed?.amount ?? 0) > 0).length;
  if (input.workers_on_opportunity.length === 0) {
    problems.push(`worker_stock filtered to opportunity ${input.opportunity_id} returns no workers: the worker points are not tied to the visit opportunity`);
  } else if (dispensedFromVisits === 0) {
    problems.push('no worker shows stock dispensed at visits: labs has not read a handover off a visit (no dispensing rule, or it has not run yet)');
  }

  const usernames = Object.keys(input.on_hand_by_week);
  const everHolding = usernames.filter((u) => Object.values(input.on_hand_by_week[u]).some((q) => q > 0)).length;
  if (usernames.length && everHolding < Math.ceil(usernames.length / 2)) {
    problems.push(`only ${everHolding} of ${usernames.length} workers ever held stock at a week end: workers are resupplied exactly what they hand over and carry no float`);
  }

  const noCoords = input.stores.filter((s) => !s.has_coordinates).map((s) => s.id);
  if (noCoords.length) problems.push(`store(s) ${noCoords.join(', ')} have no coordinates, so Map places them by fallback`);

  return {
    pass: problems.length === 0,
    problems,
    figures: { received, left_central: leftCentral, given_at_visits: given, workers: workerNodes.size, workers_ever_holding: everHolding },
  };
}
