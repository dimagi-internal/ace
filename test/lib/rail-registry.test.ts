import { describe, it, expect } from 'vitest';
import { RAILS, citationsIn, isRepoPolicingRail, normaliseIssue } from '../../lib/rail-registry';

/**
 * The scanner behind `test/skills/rail-registry.test.ts`.
 *
 * Held to the rule it enforces: each case feeds it an input it must get WRONG
 * if the logic regresses, not merely one it can process. Both directions cost
 * something real. A detector that over-reports turns every per-skill
 * `checks.test.ts` into a rail and the registry into 200 lines of noise; one
 * that under-reports lets a new rail ship with no provenance, which is the
 * whole thing this exists to stop.
 *
 * The `normaliseIssue` cases are REGRESSIONS, not hypotheticals — both were
 * found by running the first cut over ACE's own tree.
 */

describe('isRepoPolicingRail — a rail versus an ordinary unit test', () => {
  it('a test that reads a source tree is a rail', () => {
    // Verbatim from test/skills/claims-authoring.test.ts.
    const src = `const SKILL = readFileSync(join(process.cwd(), 'skills/inbox-triage/SKILL.md'), 'utf8');`;
    expect(isRepoPolicingRail(src)).toBe(true);
  });

  it('NEGATIVE — a test that reads only its own fixture is not', () => {
    // Verbatim shape from test/skills/pdd-to-work-order-qa/checks.test.ts.
    // Counting this would enrol every per-skill QA suite and make the
    // registry a list of things that are not rails.
    const src = [
      `const FIXTURES = join(__dirname, 'fixtures');`,
      `const GOOD_WO = readFileSync(join(FIXTURES, 'good-work-order.md'), 'utf8');`,
    ].join('\n');
    expect(isRepoPolicingRail(src)).toBe(false);
  });

  it('NEGATIVE — importing a source module is not reading the repo', () => {
    const src = `import { checkThing } from '../../skills/idea-to-pdd-qa/checks';`;
    expect(isRepoPolicingRail(src)).toBe(false);
  });

  it('NEGATIVE — a disk read with no source path is not a rail', () => {
    const src = `const raw = readFileSync(tmpFile, 'utf8');`;
    expect(isRepoPolicingRail(src)).toBe(false);
  });

  it('a relative walk up into a source tree counts', () => {
    const src = `const md = readFileSync(new URL('../../agents/qa-and-training.md', import.meta.url));`;
    expect(isRepoPolicingRail(src)).toBe(true);
  });
});

describe('normaliseIssue — four spellings of one issue', () => {
  it('collapses every ACE spelling to ace#n', () => {
    expect(normaliseIssue(undefined, '1238')).toBe('ace#1238');
    expect(normaliseIssue('ace', '1238')).toBe('ace#1238');
    expect(normaliseIssue('jjackson/ace', '1238')).toBe('ace#1238');
    expect(normaliseIssue('dimagi-internal/ace', '1238')).toBe('ace#1238');
  });

  it('keeps an upstream owner VERBATIM, org included', () => {
    // Not just "so a Nova issue is not mistaken for an ACE one" — dropping the
    // org makes the reference invisible to scripts/probe-upstream-asks.ts,
    // whose REF_RE requires owner/repo#n. An earlier cut shortened every owner
    // to its repo segment and planted 93 such references; the ace#2050 ledger
    // in test/lib/upstream-asks.test.ts caught it in CI.
    expect(normaliseIssue('voidcraft-labs/commcare-nova', '545')).toBe('voidcraft-labs/commcare-nova#545');
    expect(normaliseIssue('dimagi-internal/connect-labs', '1331')).toBe('dimagi-internal/connect-labs#1331');
  });
});

describe('citationsIn — one issue cited two ways is one reference', () => {
  it('drops the org-less spelling when the qualified one is present', () => {
    // test/docs/upstream-absence-claims.test.ts writes both. Keeping the short
    // form would plant an org-less reference in the registry — the defect this
    // whole rule exists to avoid.
    const src = 'voidcraft-labs/commcare-nova#545 closed COMPLETED; see also commcare-nova#545 upstream.';
    expect(citationsIn(src).issues).toEqual(['voidcraft-labs/commcare-nova#545']);
  });

  it('NEGATIVE — a different issue number is not collapsed away', () => {
    const src = 'voidcraft-labs/commcare-nova#545 and voidcraft-labs/commcare-nova#625';
    expect(citationsIn(src).issues).toEqual([
      'voidcraft-labs/commcare-nova#545',
      'voidcraft-labs/commcare-nova#625',
    ]);
  });
});

describe('citationsIn — what a rail actually records', () => {
  it('NEGATIVE — a word before a detached `#` is not a repo name', () => {
    // The measured regression: `the #811/#893 inversion` yielded `the#811`,
    // which then failed the anti-fabrication check against its own file. The
    // owner must be ADJACENT to the `#`, or English prose becomes a repo.
    expect(citationsIn('branches on matcher-miss — the #811/#893 inversion').issues).toEqual([
      'ace#811',
      'ace#893',
    ]);
  });

  it('reads an adjacent owner as a repo', () => {
    expect(citationsIn('dimagi-internal/ace#1331 + #1295 — three skills assumed').issues).toEqual([
      'ace#1331',
      'ace#1295',
    ]);
  });

  it('finds a run id', () => {
    expect(citationsIn('Found on spark-facilitator/20260828-0703: the deep verdict').runs).toEqual([
      'spark-facilitator/20260828-0703',
    ]);
  });

  it('NEGATIVE — a bare number is not a citation', () => {
    // Otherwise every line count, byte size and year in a header would read
    // as provenance and the anti-fabrication rule would pass anything.
    expect(citationsIn('the 471-line workaround stayed documented for 2026 days').issues).toEqual([]);
  });
});

describe('RAILS — the registry itself', () => {
  it('registers every rail this repo has, and each carries a provenance field', () => {
    // A cheap shape assertion; the filesystem reconciliation lives in
    // test/skills/rail-registry.test.ts, which is where it can read the tree.
    const entries = Object.entries(RAILS);
    expect(entries.length).toBeGreaterThan(90);
    for (const [file, p] of entries) {
      expect(file, 'keys are repo-relative test paths').toMatch(/^test\/(skills|docs)\/.*\.test\.ts$/);
      expect(
        p.issues.length > 0 || p.observed !== undefined || p.measurement !== undefined || !!p.unknown,
        `${file} declares nothing`,
      ).toBe(true);
    }
  });
});
