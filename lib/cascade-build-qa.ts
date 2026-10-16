/**
 * Phase 7 BUILD QA for the semantic cascade: deterministic checks on the
 * generated data and the saved runs, run before the DDD hand-off so the demo
 * judges are not the first to find them (ace#2735).
 *
 * The operator's question that produced this module (Jonathan Jackson,
 * 2026-10-06): *"is the demo catching bad output from the program build?
 * that's really inefficient, how can we be better at the program build level
 * in terms of QA or other so DDD isn't the one catching it?"*
 *
 * DDD run `spark-facilitator-programme-cascade-2026-10-06-002` (opp run
 * spark-facilitator/20261004-1706) logged 89 findings. Four classes in it are
 * properties of the BUILD output — decidable from the story plan, the registry,
 * the visit rows and the saved runs before a frame is recorded — and each cost
 * a render plus a judge pass to discover:
 *
 *  1. **Review routing** (`checkReviewRouting`) — *"11 of 12 records flagged
 *     'Repeat count' in Lumbadzi are 'approved' with Sent to review blank, which
 *     contradicts PDD §7.2 S-1 (flagged stratum gets desk review)"*. The plan
 *     declares what the PDD does with a flagged record (`review_routing`); the
 *     generated rows are judged against it. Driven by the registry's declared
 *     `display.visit_flags` and the plan's route, never by a Spark field name.
 *  2. **Degenerate worker rates** (`checkWorkerRateDenominators`,
 *     `checkPlannedWorkerRates`) — *"with one community per facilitator Step 7
 *     on time can only be 0% or 100%, so '0.0%' reads as false precision"*. A
 *     worker-level rate whose per-worker denominator is ≤ 1 for most workers.
 *  3. **Constant displayed columns** (`checkConstantDisplayedColumns`) —
 *     *"two all-constant columns (Communities = 1, Repeat counts = 0.0%) waste
 *     width"*. A column a table shows that is the same on every row.
 *  4. **Degenerate drill level** (`checkDrillLevels`) — *"a redundant
 *     single-row Opportunities level sits between partner and facilitators"*.
 *     A level with exactly one child under every parent.
 *
 * Pure: no I/O. The source of truth is the saved-run snapshot
 * (`data.snapshot.state.snapshot`), whose cells carry `n` — the denominator labs
 * graded — so check 2 reads the real denominator rather than inferring it.
 */

import type { QACheckResult } from './qa-types';
import { DRILL_LEVELS, type CascadeStoryPlan, type DrillLevel, type ReviewRoute } from './cascade-story';

// ── Snapshot shape (the subset these checks read) ─────────────────────────

export interface SnapshotCell {
  value?: number | null;
  /** The denominator labs graded the cell on. */
  n?: number | null;
}

export interface SnapshotWorkerRow {
  key?: string;
  opp?: number;
  flw?: string;
  name?: string;
  llo?: string;
  /** Indices of the entity (case) rows this worker owns. */
  rows?: unknown[];
  ind?: Record<string, SnapshotCell | undefined>;
}

export interface CascadeSnapshot {
  byFLW?: SnapshotWorkerRow[];
  byOpp?: Array<{ opp?: number; llo?: string; rows?: unknown[] }>;
  byLLO?: Array<{ llo?: string; opps?: unknown[] }>;
  cases?: Array<Record<string, unknown>>;
  display?: {
    entity?: { name?: string; plural?: string };
    indicators?: Record<string, { label?: string; scorecard?: boolean } | undefined>;
    case_fields?: Array<{ field: string; label?: string }>;
    visit_fields?: Array<{ field: string; label?: string }>;
    visit_flags?: Array<{ column: string; label?: string }>;
  };
}

/**
 * The LATEST completed run's snapshot from a `workflow_history_runs({include_snapshot:
 * true})` response — what the programme report renders, and so what a viewer sees.
 */
export function latestSnapshotFromHistoryRuns(response: unknown): CascadeSnapshot | null {
  const runs = (response as { runs?: unknown[] } | null)?.runs ?? [];
  let best: { end: string; snap: CascadeSnapshot } | null = null;
  for (const raw of runs) {
    const run = raw as { status?: string; period_end?: string; data?: { snapshot?: { state?: { snapshot?: CascadeSnapshot } } } };
    const snap = run.data?.snapshot?.state?.snapshot;
    if (run.status !== 'completed' || !snap || !run.period_end) continue;
    if (!best || run.period_end >= best.end) best = { end: run.period_end, snap };
  }
  return best?.snap ?? null;
}

const fmt = (v: unknown) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : JSON.stringify(v));

// ── 1. Review routing ─────────────────────────────────────────────────────

/** A flag cell is raised when it reads yes / true / 1 (labs-only opps return codes as strings). */
export function isFlagRaised(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['yes', 'true', '1', '1.0', 'y'].includes(v.trim().toLowerCase());
  return false;
}

function matchesAllowed(v: unknown, allowed: Array<string | number | boolean>): boolean {
  return allowed.some((a) => {
    if (typeof a === 'boolean') return v === a || (typeof v === 'string' && v.trim().toLowerCase() === String(a));
    if (typeof a === 'number') return Number(v) === a;
    return typeof v === 'string' && v.trim().toLowerCase() === a.trim().toLowerCase();
  });
}

/**
 * Every visit row carrying a declared review flag follows the PDD's review route.
 *
 * @param rows the generated visit rows — either the home-partner sample (`pipeline_preview`
 *   of the cascade's visits pipeline under its HOME opp, `sample_size: 200`, the labs cap), or
 *   every partner's full rows built from the generator's `user_visits.json` fixtures mapped
 *   through the pipeline schema and cross-checked against that preview (ace#2742)
 * @param visitFlags the registry's `display.visit_flags[].column` — the flags a viewer sees
 * @param routes the plan's `review_routing`
 *
 * Fails on: a raised flag with no declared route (an undeclared route is the
 * generator's default, which is how flagged records came out `approved`); and a
 * flagged row whose fields fall outside the route's `expect`. A `report_only`
 * route is evidenced and passes. A flag no row raises is not judged.
 */
export function checkReviewRouting(
  rows: Array<Record<string, unknown>>,
  visitFlags: readonly string[],
  routes: readonly ReviewRoute[],
): QACheckResult {
  if (rows.length === 0) {
    return {
      pass: false,
      detail: 'no visit rows supplied — review routing was not judged',
      auto_fix_hint: 'pass the visit rows: pipeline_preview of the visits pipeline under its HOME opp at sample_size 200 (labs caps it there — a sample), or every partner\'s full rows from the generator\'s user_visits.json fixtures mapped through the pipeline schema and cross-checked against that preview (ace#2742)',
    };
  }
  const byFlag = new Map(routes.map((r) => [r.flag, r]));
  const problems: string[] = [];
  const notes: string[] = [];
  const flags = [...new Set([...visitFlags, ...routes.map((r) => r.flag)])];
  for (const flag of flags) {
    const raised = rows.filter((r) => isFlagRaised(r[flag]));
    if (raised.length === 0) continue;
    const route = byFlag.get(flag);
    if (!route) {
      problems.push(
        `${raised.length} record(s) raise \`${flag}\` but the plan declares no review route for it — what the PDD does with a flagged record is unstated, so the generator's default (approved, nothing sent to review) shipped`,
      );
      continue;
    }
    if (route.report_only?.trim()) {
      notes.push(`${flag}: report-only per ${route.pdd_ref}`);
      continue;
    }
    const expect = route.expect ?? {};
    const off = raised.filter((r) => Object.entries(expect).some(([f, allowed]) => !matchesAllowed(r[f], allowed)));
    if (off.length) {
      const sample = off[0];
      problems.push(
        `${off.length} of ${raised.length} record(s) raising \`${flag}\` do not follow ${route.pdd_ref}: expected ` +
          Object.entries(expect).map(([f, a]) => `${f} ∈ {${a.map(fmt).join(', ')}}`).join(' and ') +
          `; e.g. ${Object.keys(expect).map((f) => `${f}=${fmt(sample[f])}`).join(', ')}`,
      );
    } else notes.push(`${flag}: ${raised.length} flagged record(s) all routed per ${route.pdd_ref}`);
  }
  if (problems.length === 0) {
    return { pass: true, detail: `${rows.length} visit rows; ${notes.join('; ') || 'no declared flag is raised'}` };
  }
  return {
    pass: false,
    detail: problems.join('; ') + (notes.length ? `; ${notes.join('; ')}` : ''),
    auto_fix_hint:
      'make the flagged records follow the PDD\'s review path IN THE POOL — set the route\'s fields on every ' +
      'flagged visit (e.g. flagged: true / status pending for a desk-review flag) — regenerate that partner, ' +
      'rebuild history (demo-data-setup § C5); if the PDD only REPORTS the flag, declare `report_only` with its ' +
      'words. Never relabel the flag to match the data (ace#2735).',
  };
}

// ── 2. Degenerate worker-level rates ──────────────────────────────────────

/** Fraction of workers at or below the denominator floor that makes a rate degenerate. */
export const DEGENERATE_WORKER_SHARE = 0.5;
/** A per-worker denominator at or below this reads as a binary 0% / 100%. */
export const DEGENERATE_DENOMINATOR = 1;

/**
 * Worker-displayed rates whose per-worker denominator labs graded (`cell.n`) is
 * ≤ 1 for more than half the workers — a rate that can only read 0% or 100%.
 *
 * Judged on the indicators the worker table shows (`display.indicators[id].scorecard`);
 * an indicator not shown at worker level cannot mislead there.
 */
export function checkWorkerRateDenominators(snapshot: CascadeSnapshot | null | undefined): QACheckResult {
  const workers = snapshot?.byFLW ?? [];
  if (workers.length === 0) {
    return { pass: false, detail: 'no worker rows in the saved run — worker rates were not judged', auto_fix_hint: 'pass the programme report\'s workflow_history_runs(include_snapshot) response' };
  }
  const shown = Object.entries(snapshot?.display?.indicators ?? {})
    .filter(([, m]) => m?.scorecard)
    .map(([id]) => id);
  const problems: string[] = [];
  for (const id of shown) {
    const ns = workers.map((w) => w.ind?.[id]).filter((c): c is SnapshotCell => !!c && typeof c.value === 'number' && typeof c.n === 'number');
    if (ns.length === 0) continue;
    const low = ns.filter((c) => (c.n as number) <= DEGENERATE_DENOMINATOR).length;
    if (low / ns.length > DEGENERATE_WORKER_SHARE) {
      const label = snapshot?.display?.indicators?.[id]?.label ?? id;
      problems.push(`${id} "${label}": per-worker denominator ≤ ${DEGENERATE_DENOMINATOR} for ${low} of ${ns.length} workers, so the worker table can only read 0% or 100%`);
    }
  }
  if (problems.length === 0) return { pass: true, detail: `${shown.length} worker-level rate(s) judged over ${workers.length} workers; none binary` };
  return {
    pass: false,
    detail: problems.join('; '),
    auto_fix_hint:
      'give each worker enough entities that the rate has a real denominator (roster size: ≥ 3 entities per worker ' +
      'for an entity-count rate), or stop showing the rate at worker level (registry meta `flw_applicable: false` / ' +
      'display `scorecard: false`) and keep it at partner level — a "0.0%" over one entity reads as false precision (ace#2735)',
  };
}

/**
 * The same question asked BEFORE generation: which worker-level indicators are
 * rates over an entity-row COUNT (`<measure>_denominator` of type `count`)?
 * Their per-worker denominator is at most the worker's entity count.
 */
export function entityCountRateIndicators(registry: unknown): string[] {
  const measures = ((registry as { indicators_doc?: { measures?: unknown[] } } | null)?.indicators_doc?.measures ?? []) as Array<{
    name?: string;
    type?: string;
    meta?: { indicator?: string; flw_applicable?: boolean };
  }>;
  const byName = new Map(measures.map((m) => [m.name, m]));
  const out: string[] = [];
  for (const m of measures) {
    const id = m.meta?.indicator;
    if (!id || m.meta?.flw_applicable === false) continue;
    if (byName.get(`${m.name}_denominator`)?.type === 'count') out.push(id);
  }
  return out;
}

/** Plan-time half: entities per worker from the plan's roster against the entity-count rates. */
export function checkPlannedWorkerRates(plan: CascadeStoryPlan, entityCountIndicators: readonly string[]): QACheckResult {
  if (entityCountIndicators.length === 0) return { pass: true, detail: 'no worker-level rate over an entity count' };
  const workers = (plan.workers ?? []).map((w) => w.username);
  if (workers.length === 0 || !(plan.entities ?? []).some((e) => e.worker)) {
    return { pass: false, detail: 'the plan has no entity→worker roster, so entities per worker cannot be judged', auto_fix_hint: 'author `entities[{id, name, worker}]` (demo-data-setup § C0)' };
  }
  const per = new Map(workers.map((w) => [w, 0]));
  for (const e of plan.entities ?? []) if (e.worker && per.has(e.worker)) per.set(e.worker, (per.get(e.worker) ?? 0) + 1);
  const low = [...per.values()].filter((n) => n <= DEGENERATE_DENOMINATOR).length;
  if (low / workers.length <= DEGENERATE_WORKER_SHARE) {
    return { pass: true, detail: `${workers.length - low} of ${workers.length} workers own ≥ 2 entities` };
  }
  return {
    pass: false,
    detail:
      `${low} of ${workers.length} workers own ≤ ${DEGENERATE_DENOMINATOR} entity, so ${entityCountIndicators.join(', ')} ` +
      '(rates over an entity count) can only read 0% or 100% per worker',
    auto_fix_hint:
      'raise entities per worker, or set `flw_applicable: false` on those indicators so they show at partner level only (ace#2735)',
  };
}

// ── Visit-row sample scope (ace#2973) ──────────────────────────────────────

/**
 * What the `--visits` input actually covers, stated in words for the check detail.
 *
 * `pipeline_preview` caps `sample_size` at 200, and a home-scoped cascade visits
 * pipeline only resolves under its home opp — fanning it out with `opportunity_ids`
 * merges the home opp's rows first, so the 200-row sample is (measured on
 * noora-health/20261015-1129, pipeline 9685) all the home partner. Checks 24 and 26
 * therefore judge a SAMPLE, and the detail must say which, never read as "every
 * partner". Returns `null` when nothing was supplied.
 */
export function visitSampleScope(previews: unknown[]): string | null {
  const responses = previews.filter((p) => p && typeof p === 'object' && Array.isArray((p as { rows?: unknown }).rows)) as Array<{
    rows: Array<Record<string, unknown>>;
    row_count_before_sample?: number;
  }>;
  if (responses.length === 0) return null;
  const rows = responses.flatMap((r) => r.rows);
  const before = responses.reduce((n, r) => n + (typeof r.row_count_before_sample === 'number' ? r.row_count_before_sample : r.rows.length), 0);
  const opps = [...new Set(rows.map((r) => r.opportunity_id).filter((o) => o !== undefined && o !== null).map(String))];
  const partners = opps.length ? `opp${opps.length > 1 ? 's' : ''} ${opps.join(', ')}` : 'untagged rows';
  const full = rows.length >= before;
  return `visit rows judged: ${rows.length} of ${before} (${partners})${full ? '' : " — a SAMPLE, not every partner's visits (pipeline_preview caps at 200; ace#2973)"}`;
}

// ── 3. Constant displayed columns ─────────────────────────────────────────

export interface ConstantColumnFinding {
  table: 'worker' | 'case' | 'visit';
  column: string;
  value: string;
  /** `programme`: constant on every row (fails); otherwise the partner whose drilled table it is constant in (reported). */
  scope: string;
  /**
   * `near`: not identical, but a worker-table rate whose spread across a partner's workers is under
   * NEAR_FLAT_POINTS while another scorecard rate there spreads ≥ WIDE_SPREAD_POINTS (ace#2746).
   * Absent means exactly constant.
   */
  near?: true;
}

/**
 * Near-constant thresholds for worker-table rate columns, in percentage points (ace#2746).
 * Measured on spark-facilitator/20261004-1706 attempt 3: Women attending 35.8–36.9%, Spoke up
 * 31.4–32.5% and Women who spoke 21.1–22.5% across ten facilitators, beside Meeting regularity at
 * 55–98%. The DDD user judge read that as generated data and capped `trust` at 2, while this check
 * passed because no column was EXACTLY constant. A spread of ~1 point is what per-visit draws from
 * one partner-level range converge to over ~30 visits per worker. Real facilitators differ.
 */
export const NEAR_FLAT_POINTS = 3;
export const WIDE_SPREAD_POINTS = 15;

/** A column reads as a rate when every present value is a number in [0, 1]. */
function rateSpreadPoints(values: unknown[]): { min: number; max: number; spread: number } | null {
  const nums = values.filter((v) => v !== undefined && v !== null);
  if (nums.length < 3 || !nums.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  const n = nums as number[];
  const min = Math.min(...n);
  const max = Math.max(...n);
  return { min, max, spread: (max - min) * 100 };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function constantValue(values: unknown[]): { constant: boolean; value: unknown } {
  const present = values.filter((v) => v !== undefined);
  if (present.length < 2) return { constant: false, value: undefined };
  const first = JSON.stringify(present[0]);
  return { constant: present.every((v) => JSON.stringify(v) === first), value: present[0] };
}

/**
 * Every column a table shows varies across its rows.
 *
 *  - worker table: each scorecard indicator. The entity-count column
 *    (`rows.length`, labelled with the entity's plural — Spark's "Communities")
 *    is NOT judged: since connect-labs #2262 (2026-10-06) the indicator report
 *    render drops that column whenever every row of a table has the same count
 *    and states it once in the title or drill caption ("Educators · 1 facility
 *    each" — `indicator_report_render.js` `sameN`). A constant count is
 *    therefore never on screen, and a varying one is not constant, so the
 *    column cannot fail this check. A uniform count is NOTED in the detail
 *    (ace#2972: noora-health/20261015-1129 failed on a column that was not drawn);
 *  - case table: `display.case_fields`;
 *  - visit table: `display.visit_fields` + `display.visit_flags`, when visit rows are supplied.
 *
 * Worker rate columns are also judged NEAR-constant (ace#2746): a spread under
 * NEAR_FLAT_POINTS inside every partner, while another scorecard rate there
 * spreads ≥ WIDE_SPREAD_POINTS, fails; the same inside only some partners is
 * reported.
 *
 * Constant over EVERY row of the saved run → fail. Constant only within one
 * partner's drilled worker table → reported (a flag that is zero for a whole
 * partner can be true; the narrative should not film that table for it).
 */
export function checkConstantDisplayedColumns(
  snapshot: CascadeSnapshot | null | undefined,
  visitRows: Array<Record<string, unknown>> = [],
): QACheckResult & { findings: ConstantColumnFinding[] } {
  const findings: ConstantColumnFinding[] = [];
  const workers = snapshot?.byFLW ?? [];
  const display = snapshot?.display ?? {};
  const entityLabel = display.entity?.plural ? display.entity.plural[0].toUpperCase() + display.entity.plural.slice(1) : 'Entities';
  const workerCols: Array<{ name: string; get: (w: SnapshotWorkerRow) => unknown }> = Object.entries(display.indicators ?? {})
    .filter(([, m]) => m?.scorecard)
    .map(([id, m]) => ({ name: `${id} "${m?.label ?? id}"`, get: (w: SnapshotWorkerRow) => w.ind?.[id]?.value ?? undefined }));
  // The render collapses a uniform entity count into the table title (ace#2972) — note it, never fail it.
  const entityCount = constantValue(workers.map((w) => (Array.isArray(w.rows) ? w.rows.length : undefined)));
  const collapsedText = entityCount.constant
    ? ` (${entityLabel} column not drawn: every worker has ${fmt(entityCount.value)}, shown once in the title as "… each")`
    : '';
  for (const col of workerCols) {
    const all = constantValue(workers.map(col.get));
    if (all.constant) {
      findings.push({ table: 'worker', column: col.name, value: fmt(all.value), scope: 'programme' });
      continue;
    }
    const partners = [...new Set(workers.map((w) => w.llo ?? ''))].filter(Boolean);
    for (const p of partners) {
      const c = constantValue(workers.filter((w) => w.llo === p).map(col.get));
      if (c.constant) findings.push({ table: 'worker', column: col.name, value: fmt(c.value), scope: p });
    }
  }
  // ace#2746: near-constant worker rates. Judged per partner, because that is the table a viewer
  // drills into; a column is flat in a partner when its spread there is under NEAR_FLAT_POINTS
  // while another scorecard rate in the same partner spreads at least WIDE_SPREAD_POINTS. Flat in
  // EVERY partner fails (the pool has no per-worker effect for it); flat in some is reported.
  const exactProgramme = new Set(findings.filter((f) => f.table === 'worker' && f.scope === 'programme').map((f) => f.column));
  const groups = [...new Set(workers.map((w) => w.llo ?? ''))];
  const spreads = new Map<string, Map<string, ReturnType<typeof rateSpreadPoints>>>();
  for (const col of workerCols) {
    const perGroup = new Map<string, ReturnType<typeof rateSpreadPoints>>();
    for (const g of groups) perGroup.set(g, rateSpreadPoints(workers.filter((w) => (w.llo ?? '') === g).map(col.get)));
    spreads.set(col.name, perGroup);
  }
  for (const col of workerCols) {
    if (exactProgramme.has(col.name)) continue;
    const flatIn: Array<{ group: string; min: number; max: number }> = [];
    let judged = 0;
    for (const g of groups) {
      const own = spreads.get(col.name)!.get(g);
      if (!own) continue;
      judged++;
      const contrast = workerCols.some((o) => o.name !== col.name && (spreads.get(o.name)!.get(g)?.spread ?? 0) >= WIDE_SPREAD_POINTS);
      if (own.spread < NEAR_FLAT_POINTS && contrast) flatIn.push({ group: g, min: own.min, max: own.max });
    }
    if (judged === 0 || flatIn.length === 0) continue;
    if (flatIn.length === judged) {
      const lo = Math.min(...flatIn.map((f) => f.min));
      const hi = Math.max(...flatIn.map((f) => f.max));
      const value = `${pct(lo)}–${pct(hi)}, under ${NEAR_FLAT_POINTS} points within every partner${groups.length > 1 ? '' : "'s workers"}`;
      findings.push({ table: 'worker', column: col.name, value, scope: 'programme', near: true });
    } else {
      for (const f of flatIn) {
        // Exactly constant inside this partner is already reported above.
        if (f.max === f.min) continue;
        findings.push({ table: 'worker', column: col.name, value: `${pct(f.min)}–${pct(f.max)} (near-constant)`, scope: f.group || '(no partner)', near: true });
      }
    }
  }
  const cases = snapshot?.cases ?? [];
  for (const f of display.case_fields ?? []) {
    const c = constantValue(cases.map((r) => r[f.field]));
    if (c.constant) findings.push({ table: 'case', column: `${f.field} "${f.label ?? f.field}"`, value: fmt(c.value), scope: 'programme' });
  }
  if (visitRows.length) {
    const cols = [...(display.visit_fields ?? []).map((f) => f.field), ...(display.visit_flags ?? []).map((f) => f.column)];
    for (const col of cols) {
      const c = constantValue(visitRows.map((r) => r[col]));
      if (c.constant) findings.push({ table: 'visit', column: col, value: fmt(c.value), scope: 'programme' });
    }
  }
  const failing = findings.filter((f) => f.scope === 'programme');
  const reported = findings.filter((f) => f.scope !== 'programme');
  const reportedText =
    (reported.length
      ? ` (reported, constant within one partner's table: ${reported.map((f) => `${f.column}=${f.value} in ${f.scope}`).join('; ')})`
      : '') + collapsedText;
  if (workers.length === 0 && cases.length === 0) {
    return { pass: false, findings, detail: 'no worker or case rows in the saved run — columns were not judged', auto_fix_hint: 'pass the programme report\'s workflow_history_runs(include_snapshot) response' };
  }
  if (failing.length === 0) {
    return { pass: true, findings, detail: `${workerCols.length} worker, ${(display.case_fields ?? []).length} case column(s) vary${reportedText}` };
  }
  return {
    pass: false,
    findings,
    detail: `constant${failing.some((f) => f.near) ? ' or near-constant' : ''} on every row: ${failing.map((f) => `${f.table} ${f.column} = ${f.value}`).join('; ')}${reportedText}`,
    auto_fix_hint:
      'a column the same on every row is width a viewer reads for nothing: vary it in the data (the pool) or stop ' +
      'showing it (registry display `scorecard: false` / drop the case field) (ace#2735)' +
      (failing.some((f) => f.near)
        ? '. A NEAR-constant worker rate means the pool draws that value per visit from a partner-level range ' +
          'with no per-worker effect, so every worker converges on the partner mean: give each worker its own ' +
          'effect on the draw (demo-data-setup § C3), regenerate, rebuild history (ace#2746)'
        : ''),
  };
}

// ── 4. Degenerate drill levels ────────────────────────────────────────────

/** Children per parent at each drill level, from the snapshot. */
export function drillLevelChildCounts(snapshot: CascadeSnapshot | null | undefined): Record<DrillLevel, number[]> {
  const count = (keys: Array<string | number | undefined>, distinctChild: Array<unknown>) => {
    const m = new Map<string, Set<string>>();
    keys.forEach((k, i) => {
      if (k === undefined || k === '') return;
      const s = m.get(String(k)) ?? new Set<string>();
      s.add(JSON.stringify(distinctChild[i]));
      m.set(String(k), s);
    });
    return [...m.values()].map((s) => s.size);
  };
  const opps = snapshot?.byOpp ?? [];
  const workers = snapshot?.byFLW ?? [];
  return {
    'partner>opportunity': count(opps.map((o) => o.llo), opps.map((o) => o.opp)),
    'opportunity>worker': count(workers.map((w) => w.opp), workers.map((w) => w.key ?? w.flw)),
    'worker>entity': workers.filter((w) => Array.isArray(w.rows)).map((w) => (w.rows as unknown[]).length),
  };
}

/**
 * No drill level has exactly one child under every parent — a click into such a
 * level shows the row the viewer clicked, again. A level the PDD fixes at one
 * child is exempted only by a `single_child_levels` entry WITH a reason, and the
 * exemption is reported (the narrative should not pause on that level).
 */
export function checkDrillLevels(
  snapshot: CascadeSnapshot | null | undefined,
  exempt: CascadeStoryPlan['single_child_levels'] = [],
): QACheckResult {
  const counts = drillLevelChildCounts(snapshot);
  const evidenced = new Map((exempt ?? []).filter((e) => e.reason?.trim()).map((e) => [e.level, e.reason.trim()]));
  const problems: string[] = [];
  const notes: string[] = [];
  let judged = 0;
  for (const level of DRILL_LEVELS) {
    const c = counts[level];
    if (c.length < 2) continue;
    judged += 1;
    if (!c.every((n) => n === 1)) continue;
    const msg = `${level}: every one of ${c.length} parents has exactly one child`;
    if (evidenced.has(level)) notes.push(`${msg} — exempted: ${evidenced.get(level)}`);
    else problems.push(msg);
  }
  if (judged === 0) return { pass: false, detail: 'no drill level could be judged from the saved run', auto_fix_hint: 'pass the programme report\'s workflow_history_runs(include_snapshot) response' };
  if (problems.length === 0) return { pass: true, detail: `${judged} drill level(s) judged${notes.length ? `; ${notes.join('; ')}` : '; each branches'}` };
  return {
    pass: false,
    detail: problems.join('; ') + (notes.length ? `; ${notes.join('; ')}` : ''),
    auto_fix_hint:
      'a level with one child everywhere repeats its parent on screen: branch it in the data (a partner running two ' +
      'opportunities, a worker following several entities), or — when the PDD fixes it (one community per facilitator) ' +
      '— record `single_child_levels: [{level, reason}]` in cascade-story.yaml citing the PDD, and keep scenes from ' +
      'pausing on that level. An unevidenced entry exempts nothing (ace#2735).',
  };
}
