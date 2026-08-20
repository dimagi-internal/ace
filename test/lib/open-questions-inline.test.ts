/**
 * dimagi-internal/ace#1487 — the durable open-questions inline was unbounded.
 *
 * ace#1201 gave the opp-root `open-questions.md` its missing read half by
 * inlining it at Phase 1. Nobody bounded the read: the ledger is append-only
 * (resolved rows were annotated in place, never moved out), and nothing scoped
 * the read to opps where inheriting run history makes sense. On the
 * `/ace:iterate` fixture opp `bednet-check-2-visit` the ledger reached 26,577
 * chars across three runs, and the run's PDD came out 43,003 chars from a
 * 15,449-char brief — carrying rates, cohort sizes and programme ceilings the
 * brief never states. A fixture that cannot hold its baseline still stops
 * measuring "can ACE build what the brief specifies".
 *
 * Two locks here:
 *
 *  1. the classifier itself — fixture opps skip the inline AT ANY SIZE, and
 *     everyone else is capped;
 *  2. a doc assertion (same style as `test/lib/opp-root-files.test.ts`'s
 *     Step 5b check) that the executing PROSE names both bounds, so the
 *     orchestrator doc and the helper cannot drift apart. The helper is what
 *     the tests bind to, but the orchestrator is what actually runs, and prose
 *     that silently loses a rule is exactly how #1487 stayed invisible.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  OPEN_QUESTIONS_INLINE_CAP_CHARS,
  classifyOpenQuestionsInline,
  type OpenQuestionsInlineMode,
} from '../../lib/open-questions-inline.js';

/** A real opp root: no `/ace:iterate` campaign state. */
const REAL_OPP_ROOT = ['opp.yaml', 'inputs', 'runs', 'current', 'open-questions.md'];

/** The `/ace:iterate` fixture opp root — `iterate-state.yaml` is the fixture signal. */
const FIXTURE_OPP_ROOT = ['opp.yaml', 'inputs', 'runs', 'iterate-state.yaml'];

describe('open-questions inline bounds (#1487)', () => {
  const cases: Array<{
    name: string;
    charCount: number;
    oppRootNames: string[];
    expected: OpenQuestionsInlineMode;
  }> = [
    {
      name: 'fixture opp skips the inline at the measured #1487 ledger size',
      charCount: 26_577, // bednet-check-2-visit, revision 27 — the regression case
      oppRootNames: FIXTURE_OPP_ROOT,
      expected: 'skip-fixture',
    },
    {
      name: 'fixture opp skips the inline even when the ledger is tiny',
      charCount: 12,
      oppRootNames: FIXTURE_OPP_ROOT,
      expected: 'skip-fixture',
    },
    {
      name: 'fixture opp skips the inline at exactly the cap',
      charCount: OPEN_QUESTIONS_INLINE_CAP_CHARS,
      oppRootNames: FIXTURE_OPP_ROOT,
      expected: 'skip-fixture',
    },
    {
      name: 'fixture opp skips the inline when the doc is empty',
      charCount: 0,
      oppRootNames: FIXTURE_OPP_ROOT,
      expected: 'skip-fixture',
    },
    {
      name: 'a legacy iterate-state file trips the fixture branch too (registry regex)',
      charCount: 26_577,
      oppRootNames: ['opp.yaml', 'inputs', 'runs', 'iterate-state-legacy-20260814.yaml'],
      expected: 'skip-fixture',
    },
    {
      name: 'real opp at the #1487 ledger size gets the ## Open section only',
      charCount: 26_577,
      oppRootNames: REAL_OPP_ROOT,
      expected: 'inline-open-section-only',
    },
    {
      name: 'real opp one char over the cap is truncated',
      charCount: OPEN_QUESTIONS_INLINE_CAP_CHARS + 1,
      oppRootNames: REAL_OPP_ROOT,
      expected: 'inline-open-section-only',
    },
    {
      name: 'real opp exactly at the cap still inlines in full — the bound is >, not >=',
      charCount: OPEN_QUESTIONS_INLINE_CAP_CHARS,
      oppRootNames: REAL_OPP_ROOT,
      expected: 'inline-full',
    },
    {
      name: 'a healthy real opp inlines in full',
      charCount: 900,
      oppRootNames: REAL_OPP_ROOT,
      expected: 'inline-full',
    },
    {
      name: 'an empty real ledger inlines in full',
      charCount: 0,
      oppRootNames: REAL_OPP_ROOT,
      expected: 'inline-full',
    },
    {
      name: 'an opp root with no entries at all is not a fixture',
      charCount: 900,
      oppRootNames: [],
      expected: 'inline-full',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const decision = classifyOpenQuestionsInline({
        charCount: c.charCount,
        oppRootNames: c.oppRootNames,
      });
      expect(decision.mode).toBe(c.expected);
      expect(decision.capChars).toBe(OPEN_QUESTIONS_INLINE_CAP_CHARS);
    });
  }

  it('a look-alike operator file is NOT the fixture signal', () => {
    // Step 5b migrates these into inputs/ precisely because ACE does not own
    // them — they must not silently switch Phase 1's read off.
    for (const name of ['iterate.md', 'iterate-state.md', 'my-iterate-state.yaml']) {
      expect(
        classifyOpenQuestionsInline({
          charCount: 26_577,
          oppRootNames: ['opp.yaml', 'inputs', name],
        }).mode,
        name,
      ).toBe('inline-open-section-only');
    }
  });

  it('every branch returns a pasteable reason naming the issue', () => {
    for (const oppRootNames of [FIXTURE_OPP_ROOT, REAL_OPP_ROOT]) {
      for (const charCount of [900, 26_577]) {
        const { reason } = classifyOpenQuestionsInline({ charCount, oppRootNames });
        expect(reason.length, 'reason').toBeGreaterThan(40);
      }
    }
    // The two bounded branches cite the issue so a pause summary carries the why.
    expect(
      classifyOpenQuestionsInline({ charCount: 12, oppRootNames: FIXTURE_OPP_ROOT }).reason,
    ).toContain('ace#1487');
    expect(
      classifyOpenQuestionsInline({ charCount: 26_577, oppRootNames: REAL_OPP_ROOT }).reason,
    ).toContain('ace#1487');
  });
});

describe('the executing prose states both bounds (#1487)', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('the orchestrator Phase 1 block names the fixture signal and the cap', () => {
    const doc = read('agents/ace-orchestrator.md');
    const start = doc.indexOf('### Phase 1: Idea to Design');
    const end = doc.indexOf('### Phase 2:', start);
    expect(start, 'Phase 1 block').toBeGreaterThan(-1);
    expect(end, 'Phase 2 block').toBeGreaterThan(start);
    const phase1 = doc.slice(start, end);

    // FIXTURE SKIP — the signal is the opp-root registry entry, not a new opp.yaml field.
    expect(phase1, 'Phase 1 must name the fixture signal').toContain('iterate-state.yaml');
    // BOUNDED INLINE — the cap is a named export, not a number retyped into prose.
    expect(phase1, 'Phase 1 must name the cap constant').toContain(
      'OPEN_QUESTIONS_INLINE_CAP_CHARS',
    );
    // The #1201 rationale is narrowed, not removed.
    expect(phase1, 'Phase 1 must keep the #1201 rationale').toContain('ace#1201');
  });

  it('idea-to-pdd declares the two-section shape', () => {
    const skill = read('skills/idea-to-pdd/SKILL.md');
    expect(skill, 'the skill must declare ## Archive').toContain('## Archive');
    expect(skill, 'the skill must declare ## Open').toContain('## Open');
  });

  it('the artifact manifest no longer describes the file as append-only', () => {
    const manifest = read('lib/artifact-manifest.ts');
    const entry = manifest.slice(
      manifest.indexOf("path: 'open-questions.md'"),
      manifest.indexOf("path: 'eval-calibration/known-issues.md'"),
    );
    expect(entry, 'manifest entry').toContain('## Archive');
    expect(entry, 'manifest entry').toContain('never inlined');
  });
});
