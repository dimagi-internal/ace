/**
 * Plan the benchmark re-publish after `workflow_rebuild_history` (dimagi-internal/ace#2717).
 *
 * An opp report's Benchmarks tab shows the most recently PUBLISHED as-of, not
 * the latest period (`demo-data-setup` § C5). A registry edit + rebuild
 * restates every saved run, but publishes nothing, so the tab keeps the old
 * publication: measured on spark-facilitator/20261004-1706 (registry 7185 v3),
 * partner C's Benchmarks tab read "as of 9 Aug" with the 3–9 Aug figures
 * (A 93.3% / B 98.3% / C 90.0%) beside a Report tab as of 4 Oct.
 *
 * The fix is to re-publish each rebuilt run to the cohort, OLDEST FIRST, so the
 * last publish is the latest period. This module turns the before/after
 * `workflow_history_runs` listings of the programme report into that ordered
 * publish list, and refuses rather than publishing a partial series:
 *  - a period present before the rebuild and missing after it,
 *  - two runs for one period after the rebuild,
 *  - a gap in the after-series wider than one cadence step (a missing week).
 *
 * Pure. The publish itself (`benchmarks_publish`) is an operator-visible write
 * and is never made here.
 */

export interface HistoryRun {
  run_id: number;
  /** ISO date (YYYY-MM-DD) the run is graded as of. */
  period_end: string;
}

export interface BenchmarkPublishCall {
  cohort_id: number;
  workflow_id: number;
  run_id: number;
  program_id: number;
  /** Not a `benchmarks_publish` argument: the as-of this call publishes, for the log and the final check. */
  period_end: string;
}

export interface RepublishPlanInput {
  cohortId: number;
  /** The programme report's workflow definition id (the runs belong to it). */
  workflowId: number;
  programId: number;
  /** Programme report `workflow_history_runs(..., generated_only: false)` read BEFORE the rebuild. */
  before: HistoryRun[];
  /** The same read AFTER the rebuild. */
  after: HistoryRun[];
  /** Period length; weekly is what § C5 builds. */
  cadence?: 'weekly' | 'daily';
}

export interface RepublishPlan {
  /** In publish order: oldest period first, latest last. */
  calls: BenchmarkPublishCall[];
  /** The as-of the Benchmarks tab must show once every call has landed. */
  expectedAsOf: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(iso: string): number {
  if (!ISO.test(iso)) throw new Error(`planBenchmarkRepublish: period_end "${iso}" is not an ISO date (YYYY-MM-DD)`);
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`planBenchmarkRepublish: period_end "${iso}" is not a valid date`);
  return Math.round(t / 86_400_000);
}

export function planBenchmarkRepublish(input: RepublishPlanInput): RepublishPlan {
  const step = input.cadence === 'daily' ? 1 : 7;
  if (input.after.length === 0) {
    throw new Error('planBenchmarkRepublish: the after-rebuild listing is empty — nothing was rebuilt, or the wrong report was read');
  }

  const afterByPeriod = new Map<string, HistoryRun>();
  for (const r of input.after) {
    dayNumber(r.period_end);
    if (afterByPeriod.has(r.period_end)) {
      throw new Error(`planBenchmarkRepublish: two runs for period ending ${r.period_end} after the rebuild (${afterByPeriod.get(r.period_end)!.run_id}, ${r.run_id})`);
    }
    afterByPeriod.set(r.period_end, r);
  }

  const missing = input.before.filter((r) => !afterByPeriod.has(r.period_end));
  if (missing.length > 0) {
    throw new Error(
      `planBenchmarkRepublish: period(s) ${missing.map((r) => `${r.period_end} (run ${r.run_id})`).join(', ')} existed before the rebuild and have no run after it — finish the rebuild (re-call with start=<next_start>) before publishing`,
    );
  }

  const ordered = [...afterByPeriod.values()].sort((a, b) => a.period_end.localeCompare(b.period_end));
  for (let i = 1; i < ordered.length; i += 1) {
    const gap = dayNumber(ordered[i].period_end) - dayNumber(ordered[i - 1].period_end);
    if (gap !== step) {
      throw new Error(
        `planBenchmarkRepublish: ${input.cadence ?? 'weekly'} series is not contiguous — ${ordered[i - 1].period_end} → ${ordered[i].period_end} is ${gap} days; a period is missing`,
      );
    }
  }

  const calls = ordered.map((r) => ({
    cohort_id: input.cohortId,
    workflow_id: input.workflowId,
    run_id: r.run_id,
    program_id: input.programId,
    period_end: r.period_end,
  }));
  return { calls, expectedAsOf: ordered[ordered.length - 1].period_end };
}
