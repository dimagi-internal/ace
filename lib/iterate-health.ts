/**
 * Rolling-window health for `/ace:iterate`.
 *
 * ## Why this replaced the streak
 *
 * `iterate-state.yaml` used to store a `streak` counted "against a plugin
 * version": every autofix merge restamped `plugin_version` and zeroed `streak`,
 * and the loop exited successfully only at `streak >= required_streak` (5).
 * ACE merges ~9 VERSION bumps/day across parallel worktrees, so that exit
 * condition demanded five consecutive clean end-to-end runs during a code
 * freeze that never happens. The improvement loop and the measurement loop
 * invalidated each other by construction, and the loop never produced a
 * reading.
 *
 * Two structural changes, not a tuning change:
 *
 * 1. **Streak is derived, never stored.** It is recomputed from `iterations[]`
 *    on every read, so there is no field for a merge to zero. The class of bug
 *    is gone, not tuned down.
 * 2. **The primary metric is a rolling pass rate over the last N iterations,
 *    version-agnostic.** Shipping a fix mid-window is normal and expected —
 *    that's what the loop is FOR. Version is recorded per iteration for
 *    attribution (`by_version`), never used as a gate.
 *
 * Pure module: no I/O, no clock, no randomness. `iterate-loop.md` reads this
 * and prints `summary` each pass.
 */

export interface IterateIteration {
  run_id: string;
  verdict: 'clean' | 'dirty';
  failure_class?: string | null;
  fix_pr?: string | null;
  version_at_run?: string | null;
  started_at?: string | null;
  /**
   * True when the only blocking criterion was an artifact frozen into the
   * seeded golden prefix — a defect upstream of the fork that the autofix
   * subagent structurally cannot reach (the fix belongs in the golden's PDD,
   * not in any skill this iteration ran). Counted separately so a decayed
   * fixture reads as "re-mint the golden", not as "ACE is regressing".
   */
  seeded_prefix_defect?: boolean | null;
}

export type IterateHealthVerdict = 'converged' | 'not-converged' | 'insufficient-data';
export type IterateTrend = 'improving' | 'flat' | 'regressing' | 'unknown';

export interface IterateHealth {
  /** Window size actually used (clamped to >= 2). */
  window: number;
  /** Pass-rate target actually used (clamped into (0,1]). */
  pass_target: number;
  /** Iterations in the whole history. */
  total: number;
  /** Iterations inside the window (== min(total, window)). */
  considered: number;
  clean: number;
  dirty: number;
  /** clean/considered over the window; null when there is nothing to divide. */
  pass_rate: number | null;
  /** Trailing clean run at the newest end of the history. Derived. */
  current_streak: number;
  /** Longest clean run anywhere in the history. Derived. */
  longest_streak: number;
  verdict: IterateHealthVerdict;
  converged: boolean;
  /** Iterations still needed before the window is full enough to read. */
  runs_until_readable: number;
  /** Newer half of the window vs older half. */
  trend: IterateTrend;
  /** Per-version clean/dirty tallies inside the window, for attribution. */
  by_version: Record<string, { clean: number; dirty: number }>;
  /** Failure classes inside the window, most frequent first. */
  top_failure_classes: Array<{ failure_class: string; count: number }>;
  /**
   * Dirty iterations in the window blocked solely by the frozen seeded prefix.
   * Does NOT soften `pass_rate` — a run that never proved a delivery is dirty
   * whatever the cause. This is the term that tells the operator WHICH thing to
   * go fix, so a stale fixture stops masquerading as a regressing system.
   */
  blocked_by_golden: number;
  /**
   * Dirty classes in the window that the autofix loop never landed a fix for
   * (`fix_pr` null on every occurrence), most frequent first.
   */
  unfixable_classes: Array<{ failure_class: string; count: number }>;
  /**
   * Non-null when the loop should stop rather than spend more iterations on
   * something iterating cannot fix. The existing per-failure-class cap only
   * counts iterations WITH a `fix_pr`, so a class that is never fixable at all
   * never trips it — that is the hole this closes.
   */
  halt: { reason: 'stale-golden' | 'unfixable-class'; detail: string } | null;
  /** One-line human summary the loop prints every pass. */
  summary: string;
}

export interface IterateHealthOptions {
  window?: number;
  pass_target?: number;
  /** Occurrences of an unfixable class (or golden-blocked runs) before halting. */
  unfixable_class_cap?: number;
}

/** Default rolling window: 10 seeded runs. */
export const DEFAULT_ITERATE_WINDOW = 10;
/** Default target: 80% of the window clean. */
export const DEFAULT_ITERATE_PASS_TARGET = 0.8;
/** Default occurrences of an unfixable failure class before the loop halts. */
export const DEFAULT_UNFIXABLE_CLASS_CAP = 2;

function clampWindow(w: unknown): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return DEFAULT_ITERATE_WINDOW;
  const i = Math.floor(w);
  return i < 2 ? 2 : i;
}

function clampTarget(t: unknown): number {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return DEFAULT_ITERATE_PASS_TARGET;
  return t > 1 ? 1 : t;
}

function clampCap(c: unknown): number {
  if (typeof c !== 'number' || !Number.isFinite(c)) return DEFAULT_UNFIXABLE_CLASS_CAP;
  const i = Math.floor(c);
  return i < 1 ? 1 : i;
}

/** A fix_pr counts as "landed" only when it is a non-empty string. */
function hasFix(it: IterateIteration): boolean {
  return typeof it.fix_pr === 'string' && it.fix_pr.length > 0;
}

function passRate(list: IterateIteration[]): number | null {
  if (list.length === 0) return null;
  return list.filter((i) => i.verdict === 'clean').length / list.length;
}

/**
 * Compute rolling health from an iteration history (oldest first — the order
 * `iterate-state.yaml` appends in).
 */
export function computeIterateHealth(
  iterations: IterateIteration[],
  options: IterateHealthOptions = {},
): IterateHealth {
  const window = clampWindow(options.window);
  const pass_target = clampTarget(options.pass_target);
  const unfixable_class_cap = clampCap(options.unfixable_class_cap);
  const history = Array.isArray(iterations) ? iterations : [];

  const total = history.length;
  const considered = Math.min(total, window);
  const win = history.slice(total - considered);

  const clean = win.filter((i) => i.verdict === 'clean').length;
  const dirty = considered - clean;
  const pass_rate = passRate(win);

  // Derived streaks — recomputed, never stored, so nothing can zero them.
  let current_streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].verdict !== 'clean') break;
    current_streak++;
  }
  let longest_streak = 0;
  let run = 0;
  for (const it of history) {
    if (it.verdict === 'clean') {
      run++;
      if (run > longest_streak) longest_streak = run;
    } else {
      run = 0;
    }
  }

  const windowFull = considered >= window;
  const converged = windowFull && pass_rate !== null && pass_rate >= pass_target;
  const verdict: IterateHealthVerdict = !windowFull
    ? 'insufficient-data'
    : converged
      ? 'converged'
      : 'not-converged';

  // Trend: newer half of the window vs older half. Needs >= 4 to halve
  // meaningfully (2 per side); below that it's noise, so say so.
  let trend: IterateTrend = 'unknown';
  if (considered >= 4) {
    const mid = Math.floor(considered / 2);
    const older = passRate(win.slice(0, mid));
    const newer = passRate(win.slice(considered - mid));
    if (older !== null && newer !== null) {
      trend = newer > older ? 'improving' : newer < older ? 'regressing' : 'flat';
    }
  }

  const by_version: Record<string, { clean: number; dirty: number }> = {};
  for (const it of win) {
    const key = it.version_at_run ?? 'unknown';
    const bucket = (by_version[key] ??= { clean: 0, dirty: 0 });
    if (it.verdict === 'clean') bucket.clean++;
    else bucket.dirty++;
  }

  const classCounts = new Map<string, number>();
  for (const it of win) {
    if (it.verdict !== 'dirty') continue;
    const fc = it.failure_class;
    if (typeof fc !== 'string' || fc.length === 0) continue;
    classCounts.set(fc, (classCounts.get(fc) ?? 0) + 1);
  }
  const top_failure_classes = [...classCounts.entries()]
    .map(([failure_class, count]) => ({ failure_class, count }))
    .sort((a, b) => b.count - a.count || a.failure_class.localeCompare(b.failure_class));

  // Golden-blocked runs: dirty because of a frozen seeded artifact the loop
  // cannot reach. Kept OUT of pass_rate deliberately — the number stays strict;
  // this only names the culprit so a decayed fixture is actionable.
  const blocked_by_golden = win.filter(
    (it) => it.verdict === 'dirty' && it.seeded_prefix_defect === true,
  ).length;

  // Classes the autofix loop never landed a fix for. Excludes golden-blocked
  // runs, which get their own (more specific, more actionable) halt reason.
  const unfixableCounts = new Map<string, { count: number; anyFixed: boolean }>();
  for (const it of win) {
    if (it.verdict !== 'dirty' || it.seeded_prefix_defect === true) continue;
    const fc = it.failure_class;
    if (typeof fc !== 'string' || fc.length === 0) continue;
    const bucket = unfixableCounts.get(fc) ?? { count: 0, anyFixed: false };
    bucket.count++;
    if (hasFix(it)) bucket.anyFixed = true;
    unfixableCounts.set(fc, bucket);
  }
  const unfixable_classes = [...unfixableCounts.entries()]
    .filter(([, v]) => !v.anyFixed)
    .map(([failure_class, v]) => ({ failure_class, count: v.count }))
    .sort((a, b) => b.count - a.count || a.failure_class.localeCompare(b.failure_class));

  let halt: IterateHealth['halt'] = null;
  if (blocked_by_golden >= unfixable_class_cap) {
    halt = {
      reason: 'stale-golden',
      detail:
        `${blocked_by_golden} of the last ${considered} iterations were blocked by the frozen ` +
        `seeded prefix, which no autofix can reach. Re-mint the fixture ` +
        `(\`/ace:iterate <opp> --new-golden\`) before spending more runs.`,
    };
  } else if (unfixable_classes.length > 0 && unfixable_classes[0].count >= unfixable_class_cap) {
    const worst = unfixable_classes[0];
    halt = {
      reason: 'unfixable-class',
      detail:
        `"${worst.failure_class}" has recurred ${worst.count}× in the window with no fix ever ` +
        `landing. Iterating will not clear it — investigate the class directly.`,
    };
  }

  const runs_until_readable = Math.max(0, window - considered);
  const pct = pass_rate === null ? 'n/a' : `${Math.round(pass_rate * 100)}%`;
  const base = windowFull
    ? `${clean}/${considered} clean (${pct}) over the last ${window} runs — ${verdict}` +
      ` (target ${Math.round(pass_target * 100)}%, trend ${trend}, streak ${current_streak})`
    : `${clean}/${considered} clean (${pct}) — insufficient-data, need ${runs_until_readable} more` +
      ` run${runs_until_readable === 1 ? '' : 's'} to fill the ${window}-run window`;
  const goldenNote =
    blocked_by_golden > 0 ? ` [${blocked_by_golden} blocked by a stale golden]` : '';
  const haltNote = halt ? ` — HALT: ${halt.reason}` : '';
  const summary = `${base}${goldenNote}${haltNote}`;

  return {
    window,
    pass_target,
    total,
    considered,
    clean,
    dirty,
    pass_rate,
    current_streak,
    longest_streak,
    verdict,
    converged,
    runs_until_readable,
    trend,
    by_version,
    top_failure_classes,
    blocked_by_golden,
    unfixable_classes,
    halt,
    summary,
  };
}
