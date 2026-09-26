/**
 * The Phase 7 cascade STORY: what a synthetic programme is built to show, and
 * whether it actually shows it (ace#2510).
 *
 * A synthetic programme is only worth filming if a viewer drilling
 * programme → partner → opportunity → worker → case finds something. Four
 * signals are authored on purpose, each tied to a registry indicator and a PDD
 * clause:
 *
 *   lagging_partner  — one partner worst on its indicator (the PM's first click)
 *   standout_worker  — one worker best among every worker on its indicator
 *   data_quality     — one worker extreme on a PDD review signal (the S-1 class)
 *   trend            — one partner (or the programme) moving across the weeks
 *
 * The generator draws distributions; a declared signal can still fail to land
 * (a noisy cohort swamps it, a filter drops the carrier, a unit is misread).
 * So the plan is checked BEFORE generation (`checkCascadeStoryPlan`) and the
 * signal is checked AFTER, against the saved runs the programme report actually
 * graded (`verifyCascadeStoryLanded`) — the source of truth is the snapshot,
 * never the manifest. This is `CLAUDE.md § close the loop to the source of
 * truth`: the manifest is what we asked for, the snapshot is what labs says.
 *
 * Pure: no I/O. Snapshot values are labs' raw fractions (0.62 for 62%).
 */

export type SignalKind = 'lagging_partner' | 'standout_worker' | 'data_quality' | 'trend';
export const REQUIRED_SIGNAL_KINDS: readonly SignalKind[] = ['lagging_partner', 'standout_worker', 'data_quality', 'trend'];

export interface StorySignal {
  kind: SignalKind;
  /** Partner label (lagging_partner, trend) or worker username (standout_worker, data_quality); `programme` for a programme-wide trend. */
  carrier: string;
  /** Registry indicator id the signal moves, e.g. `SF_P1`. */
  indicator: string;
  /** Is a higher value better on this indicator? Taken from the registry's `direction`. */
  higher_is_better: boolean;
  /** trend only: which way the carrier moves across the periods. */
  trend_direction?: 'up' | 'down';
  /** The PDD clause the signal derives from, e.g. `PDD §7.2 S-1`. Required: an uncited signal is an invented one. */
  pdd_ref: string;
  /** What a viewer SEES, in one sentence — written before generation. */
  visible_as: string;
}

export interface StoryPartner {
  label: string;
  opportunity_id: number;
  workers: number;
}

export interface CascadeStoryPlan {
  partners: StoryPartner[];
  weeks: number;
  signals: StorySignal[];
  /** Worker usernames the plan names as carriers must exist; the roster lets the check say so. */
  worker_roster?: string[];
}

export interface StoryFinding {
  signal?: SignalKind;
  severity: 'fail' | 'warn';
  detail: string;
}

export interface PlanFloors {
  minPartners: number;
  minWorkersPerPartner: number;
  minWeeks: number;
}

/** Default story shape: 3 partners × ~12 workers × ~13 weeks. */
export const DEFAULT_FLOORS: PlanFloors = { minPartners: 3, minWorkersPerPartner: 8, minWeeks: 8 };

export function checkCascadeStoryPlan(
  plan: CascadeStoryPlan,
  registryIndicatorIds: readonly string[],
  floors: PlanFloors = DEFAULT_FLOORS,
): { verdict: 'pass' | 'fail'; findings: StoryFinding[] } {
  const findings: StoryFinding[] = [];
  const fail = (detail: string, signal?: SignalKind) => findings.push({ severity: 'fail', detail, ...(signal ? { signal } : {}) });

  if (plan.partners.length < floors.minPartners) {
    fail(`${plan.partners.length} partner(s); the cascade needs ≥ ${floors.minPartners} so a partner comparison and an anonymous benchmark mean something`);
  }
  const labels = new Set(plan.partners.map((p) => p.label));
  if (labels.size !== plan.partners.length) fail('partner labels must be distinct — they are the llo_map organisation names');
  const opps = new Set(plan.partners.map((p) => p.opportunity_id));
  if (opps.size !== plan.partners.length) fail('each partner needs its own synthetic opportunity');
  for (const p of plan.partners) {
    if (p.opportunity_id < 10000) fail(`partner ${p.label}: opportunity ${p.opportunity_id} is not labs-only (≥ 10000) — a real Connect org/opp must never carry synthetic data`);
    if (p.workers < floors.minWorkersPerPartner) fail(`partner ${p.label}: ${p.workers} workers; ≥ ${floors.minWorkersPerPartner} needed so a standout is not trivially the only row`);
  }
  if (plan.weeks < floors.minWeeks) fail(`${plan.weeks} weeks; ≥ ${floors.minWeeks} needed for a trend across saved weekly runs`);

  const ids = new Set(registryIndicatorIds);
  const roster = plan.worker_roster ? new Set(plan.worker_roster) : null;
  for (const kind of REQUIRED_SIGNAL_KINDS) {
    if (!plan.signals.some((s) => s.kind === kind)) fail(`no \`${kind}\` signal — the story needs all four (lagging partner, standout worker, data-quality problem, trend)`, kind);
  }
  for (const s of plan.signals) {
    if (!ids.has(s.indicator)) fail(`indicator ${s.indicator} is not in the registry`, s.kind);
    if (!/§\s*\d/.test(s.pdd_ref ?? '')) fail(`\`pdd_ref\` "${s.pdd_ref ?? ''}" cites no PDD section — an uncited signal is an invented one`, s.kind);
    if (!s.visible_as || s.visible_as.trim().length < 20) fail('`visible_as` must say, in a sentence, what a viewer sees', s.kind);
    const partnerCarrier = s.kind === 'lagging_partner' || (s.kind === 'trend' && s.carrier !== 'programme');
    if (partnerCarrier && !labels.has(s.carrier)) fail(`carrier "${s.carrier}" is not a partner in the plan`, s.kind);
    if ((s.kind === 'standout_worker' || s.kind === 'data_quality') && roster && !roster.has(s.carrier)) {
      fail(`carrier "${s.carrier}" is not in the worker roster`, s.kind);
    }
    if (s.kind === 'trend' && !s.trend_direction) fail('a trend signal must declare `trend_direction: up|down`', s.kind);
  }
  return { verdict: findings.some((f) => f.severity === 'fail') ? 'fail' : 'pass', findings };
}

// ── After generation: did the signal land in what labs graded? ───────────

/** One saved run's graded cells, the subset of `state.snapshot` this check reads. */
export interface GradedPeriod {
  period_end: string;
  byLLO: Array<{ llo: string; ind: Record<string, { value: number | null } | undefined> }>;
  byFLW: Array<{ flw?: string; key?: string; ind: Record<string, { value: number | null } | undefined> }>;
  programInd?: Record<string, { value: number | null } | undefined>;
}

export interface SignalResult {
  kind: SignalKind;
  carrier: string;
  indicator: string;
  landed: boolean;
  observed: string;
}

export interface LandedThresholds {
  /** Minimum gap (in raw value units, 0.05 = 5 pts) between the carrier and the nearest other row. */
  minGap: number;
  /** Minimum first→last movement for a trend. */
  minTrendDelta: number;
}
export const DEFAULT_LANDED: LandedThresholds = { minGap: 0.05, minTrendDelta: 0.05 };

const val = (cell: { value: number | null } | undefined): number | null =>
  cell && typeof cell.value === 'number' && Number.isFinite(cell.value) ? cell.value : null;

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function workerName(row: GradedPeriod['byFLW'][number]): string {
  return row.flw ?? (row.key ? row.key.split('::').pop() ?? row.key : '');
}

/**
 * Compare the carrier against every other row at the LATEST period.
 * `extremeIsGood`: the carrier should be the best row (standout) vs the worst row
 * (lagging partner, data-quality problem).
 */
function extremeCheck(
  rows: Array<{ name: string; v: number | null }>,
  carrier: string,
  higherIsBetter: boolean,
  extremeIsGood: boolean,
  minGap: number,
): { landed: boolean; observed: string } {
  const mine = rows.find((r) => r.name === carrier);
  if (!mine || mine.v === null) return { landed: false, observed: `${carrier} has no graded value` };
  const others = rows.filter((r) => r.name !== carrier && r.v !== null) as Array<{ name: string; v: number }>;
  if (others.length === 0) return { landed: false, observed: 'no other rows to compare against' };
  // "high" means numerically greater. The carrier must sit at the high end when
  // (good extreme and higher is better) or (bad extreme and lower is better).
  const wantHigh = extremeIsGood === higherIsBetter;
  const nearest = wantHigh ? Math.max(...others.map((o) => o.v)) : Math.min(...others.map((o) => o.v));
  const gap = wantHigh ? mine.v - nearest : nearest - mine.v;
  return {
    landed: gap >= minGap,
    observed: `${carrier} ${pct(mine.v)} vs nearest other ${pct(nearest)} (gap ${(gap * 100).toFixed(1)} pts)`,
  };
}

export function verifyCascadeStoryLanded(
  plan: CascadeStoryPlan,
  periods: GradedPeriod[],
  thresholds: LandedThresholds = DEFAULT_LANDED,
): { verdict: 'pass' | 'fail'; results: SignalResult[] } {
  const ordered = [...periods].sort((a, b) => a.period_end.localeCompare(b.period_end));
  const latest = ordered[ordered.length - 1];
  const results: SignalResult[] = [];
  for (const s of plan.signals) {
    let out: { landed: boolean; observed: string };
    if (!latest) out = { landed: false, observed: 'no saved runs to grade against' };
    else if (s.kind === 'lagging_partner') {
      const rows = latest.byLLO.map((r) => ({ name: r.llo, v: val(r.ind[s.indicator]) }));
      out = extremeCheck(rows, s.carrier, s.higher_is_better, false, thresholds.minGap);
    } else if (s.kind === 'standout_worker' || s.kind === 'data_quality') {
      const rows = latest.byFLW.map((r) => ({ name: workerName(r), v: val(r.ind[s.indicator]) }));
      out = extremeCheck(rows, s.carrier, s.higher_is_better, s.kind === 'standout_worker', thresholds.minGap);
    } else {
      const series = ordered
        .map((p) =>
          s.carrier === 'programme'
            ? val(p.programInd?.[s.indicator])
            : val(p.byLLO.find((r) => r.llo === s.carrier)?.ind[s.indicator]),
        )
        .filter((v): v is number => v !== null);
      if (series.length < 2) out = { landed: false, observed: `${series.length} graded period(s) — a trend needs at least 2` };
      else {
        const delta = series[series.length - 1] - series[0];
        const moved = s.trend_direction === 'down' ? -delta : delta;
        out = {
          landed: moved >= thresholds.minTrendDelta,
          observed: `${s.carrier} ${pct(series[0])} → ${pct(series[series.length - 1])} over ${series.length} saved runs`,
        };
      }
    }
    results.push({ kind: s.kind, carrier: s.carrier, indicator: s.indicator, ...out });
  }
  return { verdict: results.length > 0 && results.every((r) => r.landed) ? 'pass' : 'fail', results };
}
