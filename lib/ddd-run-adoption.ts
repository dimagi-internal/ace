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

  const elsewhere = roots
    .filter((rootName) => rootName !== currentRunsRootName)
    .flatMap(candidatesUnder);

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

  return {
    disposition: 'start-fresh',
    inPlace,
    elsewhere,
    adopt: null,
    reason:
      `No run for '${narrativeSlug}' under any runs root in ${runsParent} — ` +
      `a fresh DDD run is correct.`,
  };
}
