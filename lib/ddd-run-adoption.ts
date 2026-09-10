/**
 * Is there an existing canopy DDD run this phase should ADOPT rather than
 * restart?
 *
 * Why this is code rather than a line of prose in the Phase 7 doc
 * (dimagi-internal/ace#2287): the loss it prevents is silent, and the phase
 * that suffers it is the most expensive one ACE runs.
 *
 * canopy keeps DDD run artifacts OUT of the project repo (they accumulate
 * multi-MB clips and were bloating checkouts), and keys the runs root on the
 * git worktree basename — `scripts/ddd/resolve_ddd_dir.sh`:
 *
 * ```sh
 * RUNS_DIR="$HOME/.canopy/ddd/runs/$(basename "$REPO_ROOT")"
 * ```
 *
 * That is reasonable for canopy. It is a trap for ACE, because Phase 7
 * advertises itself as re-runnable and `skills/fork-run` is precisely the
 * operation that changes the worktree. Resume Phase 7 from a different
 * worktree and the runs root is a DIFFERENT, empty directory: canopy's
 * `resolve_narrative` reports `decision: new`, `Agent(canopy:ddd)` starts a
 * fresh run, and every completed render is discarded.
 *
 * Nothing halts and nothing warns. Measured on
 * `spark-facilitator/20260908-2215`: the run being resumed was three renders
 * deep (`iteration: 2`, `score_history: [2.0, 2.0]`, 18 findings, three
 * verdicts) under `runs/emdash-spark-y3wpj/`, while the resuming worktree
 * resolved to `runs/emdash-c-resume-spark-8105-3kpzm/`. A human had to find
 * and copy it across.
 *
 * The cost is not only the ~70 minutes of re-rendering. `compute_auto_iterate`
 * terminates on a noise-banded score STALL and a finding PLATEAU computed over
 * `score_history`; a history reset to `[]` cannot detect the stall it was about
 * to detect. So a silent restart changes the loop's terminal verdict, not just
 * its runtime — which is exactly the class of failure the phase doc's
 * "the loop owns its termination" guarantee assumes away.
 *
 * This module is pure path logic — directory listings come in as injected
 * functions — so it is unit-testable and carries no device or network truth.
 */

/** One DDD run directory found on this machine. */
export interface DddRunCandidate {
  /** Basename of the runs root it lives under (i.e. a worktree name). */
  runsRootName: string;
  /** The run id (the run directory's own name). */
  runId: string;
  /** Absolute path to the run directory. */
  runDir: string;
}

/**
 * The bit of a candidate's `run_state.yaml` that decides whether it is still
 * adoptable. Injected, like the directory listings, so this module stays pure.
 */
export interface DddRunLiveness {
  /** canopy's own ending, when the loop has already stopped. */
  terminal_status?: string | null;
  /** What `compute_auto_iterate` decided to do next; null on a finished run. */
  auto_iterate_next_action?: string | null;
}

export interface DddRunAdoptionInput {
  /** Absolute path to `~/.canopy/ddd/runs` (the parent of every runs root). */
  runsParent: string;
  /**
   * Basename of the runs root the CURRENT worktree resolves to — i.e. the
   * output of `resolve_ddd_dir.sh --runs`, basename'd.
   */
  currentRunsRootName: string;
  /** The narrative slug whose runs we are looking for, e.g. `spark-fcap-facilitation`. */
  narrativeSlug: string;
  /** Lists the runs-root basenames under `runsParent`. */
  listRunsRoots: () => readonly string[];
  /** Lists run-id directory names under `runsParent/<rootName>`. */
  listRuns: (runsRootName: string) => readonly string[];
  /**
   * Reads a candidate's liveness. OPTIONAL: when absent, no candidate is
   * excluded for being finished and the resolver behaves as it did before
   * ace#2315 — so a caller that cannot read run state is never silently
   * given a different answer than it asked for.
   */
  readRunLiveness?: (runDir: string) => DddRunLiveness | null | undefined;
}

/**
 * A runs root that belongs to ONE ACE run: `ace-<opp-slug>-<YYYYMMDD-HHMM>`.
 *
 * Phase 7 pins `CANOPY_DDD_RUNS_DIR` to one of these, which is what makes the
 * root survive a fork (ace#2287's fix, done without hand-copying). It also
 * makes a root belonging to a DIFFERENT ACE run recognisable, which is what
 * ace#2315 needs.
 */
const ACE_RUN_ROOT = /^ace-.+-\d{8}-\d{4}$/;

export function isAceRunScopedRoot(rootName: string): boolean {
  return ACE_RUN_ROOT.test(rootName);
}

/**
 * `terminal_status` values canopy stamps on a loop that has NOT ended.
 *
 * canopy's `classify_termination` (`runtime/scripts/ddd/run_pipeline.py`) writes
 * `terminal_status` on EVERY judged iteration, not only on the last one: when
 * `compute_auto_iterate` says `continue` it stamps `"running"`, and only
 * `stop_*` / convergence / divergence produce one of the four endings
 * (`converged_clean`, `converged_with_open_questions`, `stopped_not_converged`,
 * `diverging`). So a non-empty `terminal_status` is NOT "the loop has ended" —
 * a session that dies between the judge and the next render leaves
 * `terminal_status: running` behind, which is exactly the interrupted shape
 * adoption exists to rescue (ace#2360; observed on
 * spark-facilitator/20260910-1624 with the ace#2287 run itself).
 */
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['running']);

/**
 * Has this run already ENDED?
 *
 * Adoption exists to rescue work that was INTERRUPTED — a loop still mid-flight
 * when its session died. A run canopy already terminated is not interrupted
 * work, and resuming one is strictly harmful: `compute_auto_iterate` decides
 * when to stop from `score_history`, so inheriting a finished run's history
 * makes the stall detector fire on the first render and reports
 * `stopped_not_converged` over renders this run never performed (ace#2315).
 *
 * "Ended" means canopy stamped one of its ending statuses — an empty status or
 * its in-flight `running` is a loop still owed its next render (ace#2360).
 */
export function isTerminatedRun(liveness: DddRunLiveness | null | undefined): boolean {
  if (!liveness) return false;
  const status = (liveness.terminal_status ?? '').trim();
  if (status.length === 0) return false;
  return !IN_FLIGHT_STATUSES.has(status);
}

export type DddResumeDisposition =
  /** A run for this slug already sits under the current worktree's root — resume normally. */
  | 'resume-in-place'
  /**
   * No run here, but one or more exist under OTHER worktrees' roots. Adopt the
   * newest rather than dispatching a fresh loop.
   */
  | 'adopt-from-other-worktree'
  /** No run for this slug anywhere on this machine — a fresh run is correct. */
  | 'start-fresh';

export interface DddRunAdoption {
  disposition: DddResumeDisposition;
  /** Runs for this slug under the current worktree's runs root. */
  inPlace: DddRunCandidate[];
  /** Runs for this slug under any OTHER worktree's runs root. */
  elsewhere: DddRunCandidate[];
  /**
   * The single run to act on: the in-place one when present, else the
   * lexically greatest run id found elsewhere (run ids are
   * `<slug>-<YYYY-MM-DD>-<NNN>`, so lexical order is chronological order).
   * Null only when `disposition` is `start-fresh`.
   */
  adopt: DddRunCandidate | null;
  /** One line naming what was found and why, for the phase to surface verbatim. */
  reason: string;
}

/**
 * A run directory belongs to `slug` only when its name is exactly
 * `<slug>-<YYYY-MM-DD>-<digits>`.
 *
 * That grammar is canopy's, not a guess — `scripts/ddd/runstate._next_run_id`
 * mints `f"{narrative_slug}-{today}-"` + a zero-padded counter and recognises a
 * run by `name.startswith(prefix)` where the prefix INCLUDES the date, plus
 * `suffix.isdigit()`.
 *
 * Matching the full grammar rather than a bare `<slug>-` prefix is load-bearing.
 * `spark-fcap-` is itself a prefix of `spark-fcap-facilitation-2026-09-08-001`,
 * so a prefix test adopts a DIFFERENT narrative's run whenever one slug is a
 * dash-prefix of another — carrying that run's rendered clips and judged
 * verdicts silently onto the wrong story, which is strictly worse than starting
 * fresh. (Caught by this module's own test before it shipped.)
 */
export function runBelongsToSlug(runId: string, narrativeSlug: string): boolean {
  const prefix = `${narrativeSlug}-`;
  if (!runId.startsWith(prefix)) return false;
  return /^\d{4}-\d{2}-\d{2}-\d+$/.test(runId.slice(prefix.length));
}

/**
 * Resolve whether Phase 7 should resume in place, adopt a run from another
 * worktree, or legitimately start fresh.
 *
 * Deliberately reports rather than acts: adopting a run means moving multi-MB
 * artifacts between directories, and the caller (the phase agent) is the one
 * that knows whether it is allowed to.
 */
export function resolveDddRunAdoption(input: DddRunAdoptionInput): DddRunAdoption {
  const { runsParent, currentRunsRootName, narrativeSlug } = input;

  const candidatesUnder = (rootName: string): DddRunCandidate[] =>
    input
      .listRuns(rootName)
      .filter((runId) => runBelongsToSlug(runId, narrativeSlug))
      .map((runId) => ({
        runsRootName: rootName,
        runId,
        runDir: `${runsParent}/${rootName}/${runId}`,
      }));

  const roots = input.listRunsRoots();

  const inPlace = roots.includes(currentRunsRootName)
    ? candidatesUnder(currentRunsRootName)
    : [];

  // Two exclusions, both about candidates that are not this run's work to
  // resume (ace#2315). Neither touches `inPlace`: a run already under this
  // root IS this run's, and re-reporting it is how a resume finds its own dir.
  const excluded: string[] = [];

  const elsewhere = roots
    .filter((rootName) => {
      if (rootName === currentRunsRootName) return false;
      // (1) A root scoped to a DIFFERENT ACE run. Every /ace:run of an opp
      // re-derives the same narrative from the same PDD and so mints the same
      // slug; run independence says one run never reads another's state.
      if (isAceRunScopedRoot(rootName) && isAceRunScopedRoot(currentRunsRootName)) {
        excluded.push(`${rootName} (a different ACE run's runs root)`);
        return false;
      }
      return true;
    })
    .flatMap(candidatesUnder)
    // (2) A run canopy already TERMINATED. Adoption rescues interrupted work;
    // a finished run is not interrupted, and inheriting its score_history
    // pre-decides this run's terminal verdict.
    .filter((c) => {
      const liveness = input.readRunLiveness?.(c.runDir);
      if (isTerminatedRun(liveness)) {
        excluded.push(
          `${c.runsRootName}/${c.runId} (already ended: ` +
            `terminal_status=${liveness?.terminal_status})`,
        );
        return false;
      }
      return true;
    });

  const byRunIdDesc = (a: DddRunCandidate, b: DddRunCandidate): number =>
    a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;

  inPlace.sort(byRunIdDesc);
  elsewhere.sort(byRunIdDesc);

  if (inPlace.length > 0) {
    return {
      disposition: 'resume-in-place',
      inPlace,
      elsewhere,
      adopt: inPlace[0],
      reason:
        `Run ${inPlace[0].runId} for '${narrativeSlug}' is already under this worktree's ` +
        `runs root (${currentRunsRootName}) — resume it.`,
    };
  }

  if (elsewhere.length > 0) {
    const pick = elsewhere[0];
    const others = elsewhere.length > 1 ? ` (${elsewhere.length} found)` : '';
    return {
      disposition: 'adopt-from-other-worktree',
      inPlace,
      elsewhere,
      adopt: pick,
      reason:
        `No run for '${narrativeSlug}' under this worktree's runs root ` +
        `(${currentRunsRootName}), but ${pick.runId} exists under ` +
        `'${pick.runsRootName}'${others}. The DDD runs root is keyed on the worktree ` +
        `basename, so dispatching now would start a FRESH run and discard those ` +
        `renders plus score_history (ace#2287). Adopt ${pick.runDir} first.`,
    };
  }

  const skipped = excluded.length
    ? ` Skipped ${excluded.length} candidate(s) that are not this run's to resume: ` +
      `${excluded.join('; ')} (ace#2315).`
    : '';

  return {
    disposition: 'start-fresh',
    inPlace,
    elsewhere,
    adopt: null,
    reason:
      `No adoptable run for '${narrativeSlug}' under any runs root in ${runsParent} — ` +
      `a fresh DDD run is correct.${skipped}`,
  };
}
