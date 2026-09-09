import { describe, it, expect } from 'vitest';
import {
  resolveDddRunAdoption,
  runBelongsToSlug,
  type DddRunAdoptionInput,
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
