import { describe, it, expect } from 'vitest';
import {
  isTerminatedRun,
  resolveDddRunAdoption,
  runBelongsToSlug,
  type DddRunAdoptionInput,
  type DddRunLiveness,
} from '../../lib/ddd-run-adoption';

const RUNS_PARENT = '/Users/x/.canopy/ddd/runs';

function input(
  layout: Record<string, readonly string[]>,
  currentRunsRootName: string,
  narrativeSlug: string,
): DddRunAdoptionInput {
  return {
    runsParent: RUNS_PARENT,
    currentRunsRootName,
    narrativeSlug,
    listRunsRoots: () => Object.keys(layout),
    listRuns: (rootName) => layout[rootName] ?? [],
  };
}

describe('the spark-facilitator case that cost a hand repair (ace#2287)', () => {
  // Verbatim from spark-facilitator/20260908-2215: the run was three renders
  // deep under the worktree that CREATED it, while the resuming worktree
  // resolved to a different, empty runs root.
  const layout = {
    'emdash-spark-y3wpj': ['spark-fcap-facilitation-2026-09-08-001'],
    'emdash-c-resume-spark-8105-3kpzm': [],
    'bednet-2syps': ['bednet-coverage-2026-08-01-001'],
  };

  it('does NOT tell the resuming worktree to start fresh', () => {
    const out = resolveDddRunAdoption(
      input(layout, 'emdash-c-resume-spark-8105-3kpzm', 'spark-fcap-facilitation'),
    );
    expect(out.disposition).toBe('adopt-from-other-worktree');
    expect(out.disposition).not.toBe('start-fresh');
  });

  it('names the exact run dir to adopt', () => {
    const out = resolveDddRunAdoption(
      input(layout, 'emdash-c-resume-spark-8105-3kpzm', 'spark-fcap-facilitation'),
    );
    expect(out.adopt?.runDir).toBe(
      `${RUNS_PARENT}/emdash-spark-y3wpj/spark-fcap-facilitation-2026-09-08-001`,
    );
    expect(out.reason).toContain('ace#2287');
  });

  it('resumes in place once the run has been adopted', () => {
    const adopted = {
      ...layout,
      'emdash-c-resume-spark-8105-3kpzm': ['spark-fcap-facilitation-2026-09-08-001'],
    };
    const out = resolveDddRunAdoption(
      input(adopted, 'emdash-c-resume-spark-8105-3kpzm', 'spark-fcap-facilitation'),
    );
    expect(out.disposition).toBe('resume-in-place');
    expect(out.adopt?.runsRootName).toBe('emdash-c-resume-spark-8105-3kpzm');
  });
});

describe('start-fresh is still reachable', () => {
  it('reports start-fresh when no root holds a run for the slug', () => {
    const out = resolveDddRunAdoption(
      input(
        { 'wt-a': ['other-narrative-2026-01-01-001'], 'wt-b': [] },
        'wt-b',
        'spark-fcap-facilitation',
      ),
    );
    expect(out.disposition).toBe('start-fresh');
    expect(out.adopt).toBeNull();
  });

  it('tolerates a current runs root that does not exist yet', () => {
    const out = resolveDddRunAdoption(input({ 'wt-a': [] }, 'brand-new-worktree', 'slug'));
    expect(out.disposition).toBe('start-fresh');
    expect(out.inPlace).toEqual([]);
  });
});

describe('slug matching cannot adopt a different narrative', () => {
  // Adopting the wrong narrative's renders is WORSE than starting fresh: the
  // judged verdicts would be carried silently onto a different story.
  it('does not match a slug that is merely a prefix of the run id', () => {
    expect(runBelongsToSlug('spark-fcap-facilitation-2026-09-08-001', 'spark-fcap')).toBe(false);
    expect(runBelongsToSlug('spark-fcap-facilitation-2026-09-08-001', 'spark-fcap-facilitation')).toBe(
      true,
    );
  });

  it('does not match the bare slug with no run suffix', () => {
    expect(runBelongsToSlug('slug', 'slug')).toBe(false);
    expect(runBelongsToSlug('slug-', 'slug')).toBe(false);
  });

  it('ignores a same-prefix sibling narrative when resolving', () => {
    const out = resolveDddRunAdoption(
      input({ 'wt-a': ['spark-fcap-facilitation-2026-09-08-001'], 'wt-b': [] }, 'wt-b', 'spark-fcap'),
    );
    expect(out.disposition).toBe('start-fresh');
  });
});

describe('picking among several runs', () => {
  it('adopts the newest run id (lexical order is chronological)', () => {
    const out = resolveDddRunAdoption(
      input(
        {
          'wt-old': ['demo-2026-09-01-001'],
          'wt-newer': ['demo-2026-09-08-002', 'demo-2026-09-08-001'],
          'wt-here': [],
        },
        'wt-here',
        'demo',
      ),
    );
    expect(out.adopt?.runId).toBe('demo-2026-09-08-002');
    expect(out.elsewhere).toHaveLength(3);
    expect(out.reason).toContain('(3 found)');
  });

  it('prefers an in-place run over a newer one elsewhere', () => {
    // In-place wins regardless of recency: the loop's own state is there, and
    // adopting across roots is the exceptional path, not an upgrade path.
    const out = resolveDddRunAdoption(
      input(
        { 'wt-here': ['demo-2026-09-01-001'], 'wt-other': ['demo-2026-09-08-002'] },
        'wt-here',
        'demo',
      ),
    );
    expect(out.disposition).toBe('resume-in-place');
    expect(out.adopt?.runId).toBe('demo-2026-09-01-001');
  });
});

describe("a candidate that is not this run's to resume (ace#2315)", () => {
  // Verbatim from bednet-check-2-visit/20260908-1544, at the moment Phase 7 had
  // to decide. Two runs of the SAME narrative slug existed on the machine, both
  // from EARLIER /ace:run invocations of the same opportunity, and the resolver
  // recommended adopting one. Following it would have handed this run a
  // score_history of three identical 2.0s over a dataset that no longer exists,
  // firing the stall detector on the first render.
  const layout = {
    'bednet-u12df': ['bednet-two-visit-spot-check-2026-08-26-001'],
    'bednet-2syps': ['bednet-two-visit-spot-check-2026-08-19-001'],
    'ace-bednet-check-2-visit-20260908-1544': [],
  };
  const SLUG = 'bednet-two-visit-spot-check';
  const HERE = 'ace-bednet-check-2-visit-20260908-1544';

  const terminal: Record<string, DddRunLiveness> = {
    [`${RUNS_PARENT}/bednet-u12df/bednet-two-visit-spot-check-2026-08-26-001`]: {
      terminal_status: 'stopped_not_converged',
      auto_iterate_next_action: null,
    },
    [`${RUNS_PARENT}/bednet-2syps/bednet-two-visit-spot-check-2026-08-19-001`]: {
      terminal_status: 'stopped_not_converged',
      auto_iterate_next_action: null,
    },
  };
  const withLiveness = () => ({
    ...input(layout, HERE, SLUG),
    readRunLiveness: (dir: string) => terminal[dir] ?? null,
  });

  it('does NOT offer a run canopy already terminated', () => {
    const out = resolveDddRunAdoption(withLiveness());
    expect(out.disposition).toBe('start-fresh');
    expect(out.adopt).toBeNull();
    expect(out.elsewhere).toHaveLength(0);
  });

  it('says WHY it skipped them, naming the terminal status', () => {
    const out = resolveDddRunAdoption(withLiveness());
    expect(out.reason).toContain('stopped_not_converged');
    expect(out.reason).toContain('ace#2315');
  });

  it('is the regression: without the liveness reader it still recommends adoption', () => {
    // Pins the exact behaviour this change exists to fix, so an edit that drops
    // the reader cannot pass silently.
    const out = resolveDddRunAdoption(input(layout, HERE, SLUG));
    expect(out.disposition).toBe('adopt-from-other-worktree');
  });

  it('excludes a root scoped to a DIFFERENT ACE run, even mid-flight', () => {
    // Two concurrent runs of one opp mint the same slug. Neither may adopt the
    // other's work, terminated or not — run independence (CLAUDE.md).
    const out = resolveDddRunAdoption(
      input(
        {
          'ace-bednet-check-2-visit-20260901-0900': [
            'bednet-two-visit-spot-check-2026-09-01-001',
          ],
          [HERE]: [],
        },
        HERE,
        SLUG,
      ),
    );
    expect(out.disposition).toBe('start-fresh');
    expect(out.reason).toContain("a different ACE run's runs root");
  });

  it('still adopts a live run from a plain WORKTREE root — ace#2287 keeps working', () => {
    // The exclusions must not swallow the case adoption exists for: a fork
    // whose original worktree holds an unfinished run.
    const out = resolveDddRunAdoption({
      ...input(
        { 'emdash-spark-y3wpj': ['spark-fcap-facilitation-2026-09-08-001'], 'wt-here': [] },
        'wt-here',
        'spark-fcap-facilitation',
      ),
      readRunLiveness: () => ({ terminal_status: null, auto_iterate_next_action: 'render' }),
    });
    expect(out.disposition).toBe('adopt-from-other-worktree');
    expect(out.adopt?.runId).toBe('spark-fcap-facilitation-2026-09-08-001');
  });
});

describe("canopy's in-flight 'running' is not an ending (ace#2360)", () => {
  // canopy's `classify_termination` (runtime/scripts/ddd/run_pipeline.py) stamps
  // `terminal_status: running` on a loop whose next action is `continue` — i.e.
  // a run that is STILL IN FLIGHT. That is precisely the interrupted shape
  // adoption exists to rescue (ace#2287: iteration 2, score_history [2.0, 2.0],
  // next action continue). Reading it as "already ended" re-opens the silent
  // restart. Verbatim from spark-facilitator/20260910-1624, Phase 7 Step 3.1.
  const layout = {
    'emdash-spark-y3wpj': ['spark-fcap-facilitation-2026-09-08-001'],
    'wt-here': [],
  };
  const SLUG = 'spark-fcap-facilitation';
  const RUN_DIR = `${RUNS_PARENT}/emdash-spark-y3wpj/spark-fcap-facilitation-2026-09-08-001`;

  const resolveWith = (liveness: DddRunLiveness) =>
    resolveDddRunAdoption({
      ...input(layout, 'wt-here', SLUG),
      readRunLiveness: (dir: string) => (dir === RUN_DIR ? liveness : null),
    });

  it('ADOPTS a run stamped running + continue under another worktree root', () => {
    const out = resolveWith({ terminal_status: 'running', auto_iterate_next_action: 'continue' });
    expect(out.disposition).toBe('adopt-from-other-worktree');
    expect(out.adopt?.runDir).toBe(RUN_DIR);
  });

  it('ADOPTS a run stamped running whose next action was never recomputed (null)', () => {
    // The exact liveness the resolver read on 20260910-1624: the session died
    // between the judge and compute_auto_iterate.
    const out = resolveWith({ terminal_status: 'running', auto_iterate_next_action: null });
    expect(out.disposition).toBe('adopt-from-other-worktree');
  });

  it("never describes a running candidate as 'already ended'", () => {
    const out = resolveWith({ terminal_status: 'running', auto_iterate_next_action: 'continue' });
    expect(out.reason).not.toContain('already ended');
    expect(out.reason).not.toContain('terminal_status=running');
  });

  it('still EXCLUDES a run canopy genuinely ended', () => {
    const out = resolveWith({
      terminal_status: 'stopped_not_converged',
      auto_iterate_next_action: null,
    });
    expect(out.disposition).toBe('start-fresh');
    expect(out.reason).toContain('already ended: terminal_status=stopped_not_converged');
  });

  it('classifies every canopy terminal_status value the way classify_termination means it', () => {
    // The four ending statuses classify_termination can emit, plus its one
    // in-flight value. Pinned so a drift in either direction is a test diff.
    for (const ended of [
      'converged_clean',
      'converged_with_open_questions',
      'stopped_not_converged',
      'diverging',
    ]) {
      expect(isTerminatedRun({ terminal_status: ended }), ended).toBe(true);
    }
    expect(isTerminatedRun({ terminal_status: 'running' })).toBe(false);
    expect(isTerminatedRun({ terminal_status: ' running ' })).toBe(false);
    expect(isTerminatedRun({ terminal_status: null })).toBe(false);
    expect(isTerminatedRun({ terminal_status: '' })).toBe(false);
    expect(isTerminatedRun(null)).toBe(false);
  });
});
