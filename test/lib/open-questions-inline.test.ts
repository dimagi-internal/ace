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
  extractOpenSection,
  unescapeDriveMarkdown,
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

/**
 * The durable ledger is published as a CONVERTED Google Doc (Drive turns the
 * markdown into real headings and real tables) — `drive_create_doc_from_markdown`
 * is what `skills/idea-to-pdd` is told to write it with, and a `run-surface-audit`
 * of `hh-poverty-targeting/20260824-1404` flagged the un-converted file as
 * `DOC-LITERAL-MARKDOWN`: the reader saw raw `##`, `**`, and pipe tables.
 *
 * Converting changes what the READ gives back, and Phase 1 reads this file. The
 * fixtures below are not invented shapes — they are the VERBATIM bytes Drive
 * returned for a converted probe doc on 2026-08-26 (a structural mirror of that
 * ledger, created with `drive_create_doc_from_markdown` and trashed after):
 *
 *   test/fixtures/open-questions/converted-gdoc.text-plain.txt      (default export)
 *   test/fixtures/open-questions/converted-gdoc.text-markdown.md    (exportAs markdown)
 *   test/fixtures/open-questions/literal-markdown-gdoc.text-plain.txt (pre-conversion)
 *
 * The load-bearing finding: on a converted doc the DEFAULT `text/plain` export
 * strips the `##` markers (`## Open` → `Open`) and flattens every pipe table to
 * one cell per line. The section does not merely lose styling — it stops
 * resolving, and a reader that guessed at the bare `Open` line would inline a
 * ledger whose question rows have run together, with nothing to say so.
 */
describe('reading the durable ledger back from a CONVERTED gdoc', () => {
  const fixture = (name: string) =>
    fs.readFileSync(
      path.join(process.cwd(), 'test/fixtures/open-questions', name),
      'utf8',
    );

  const CONVERTED_PLAIN = 'converted-gdoc.text-plain.txt';
  const CONVERTED_MARKDOWN = 'converted-gdoc.text-markdown.md';
  const LITERAL_PLAIN = 'literal-markdown-gdoc.text-plain.txt';

  it('the converted doc read as text/markdown still resolves ## Open', () => {
    const outcome = extractOpenSection(fixture(CONVERTED_MARKDOWN));
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    expect(outcome.section.startsWith('## Open'), 'section starts at the heading').toBe(true);
    // The pipe table survives conversion as a pipe table — rows stay rows.
    expect(outcome.section).toContain('| 1 | Q2 |');
    expect(outcome.section).toContain('| 3 | Q1 |');
    expect(outcome.section).toContain('rate-band-source');
  });

  it('## Archive never rides along, nor does the section above ## Open', () => {
    for (const name of [CONVERTED_MARKDOWN, LITERAL_PLAIN]) {
      const outcome = extractOpenSection(fixture(name));
      expect(outcome.status, name).toBe('ok');
      if (outcome.status !== 'ok') continue;
      // ## Archive is closed history: never read back, never inlined (#1487).
      expect(outcome.section, name).not.toContain('deliver-app-photo-capture');
      expect(outcome.section, name).not.toContain('## Archive');
      // ...and the ## Settled section ABOVE it is not swept in either.
      expect(outcome.section, name).not.toContain('Nigeria PPI, 2020');
    }
  });

  it('Drive markdown-export escaping is undone, so a row reads as it was written', () => {
    const raw = fixture(CONVERTED_MARKDOWN);
    // Ground truth: Drive escapes markdown-significant characters on export.
    expect(raw, 'the exporter really does escape').toContain('\\#');
    expect(raw).toContain('resolved\\_at');

    const outcome = extractOpenSection(raw);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.section, 'escaping is undone').not.toContain('\\#');
    expect(outcome.section).toContain('| # | PDD ref |');
  });

  it('the DEFAULT text/plain export of a converted doc is REFUSED, not guessed at', () => {
    const raw = fixture(CONVERTED_PLAIN);
    // Ground truth: conversion strips the markers and flattens the table.
    expect(raw, 'no ## markers survive the plain-text export').not.toContain('## Open');
    expect(raw, 'the heading text is all that is left').toMatch(/^Open$/m);

    const outcome = extractOpenSection(raw);
    expect(outcome.status).toBe('needs-markdown-export');
    if (outcome.status !== 'needs-markdown-export') return;
    expect(outcome.reason, 'the remedy is named').toContain("exportAs: 'text/markdown'");
    // The whole point: no section is returned. A mangled ledger must not reach Phase 1.
    expect(outcome).not.toHaveProperty('section');
  });

  it('the pre-conversion shape (literal markdown in a gdoc) still resolves', () => {
    // The conversion must not be a one-way door: a ledger that has not been
    // republished yet keeps working exactly as it did.
    const outcome = extractOpenSection(fixture(LITERAL_PLAIN));
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.section).toContain('| 1 | Q2 |');
    expect(outcome.section).toContain('rate-band-source');
  });

  it('CRLF line endings (which Drive returns) do not defeat the match', () => {
    const outcome = extractOpenSection('# T\r\n\r\n## Open\r\n\r\n- row\r\n\r\n## Archive\r\n\r\n- gone\r\n');
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.section).toBe('## Open\n\n- row');
  });

  it('a ### subheading inside ## Open does not end the section', () => {
    const outcome = extractOpenSection(
      ['## Open', '', '### Blocked on the operator', '', '- row', '', '## Archive', '', '- gone'].join('\n'),
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.section).toContain('### Blocked on the operator');
    expect(outcome.section).not.toContain('gone');
  });

  it('a markdown-shaped doc with no ## Open section reports absent', () => {
    const outcome = extractOpenSection('# Open Questions\n\n## Archive\n\n- gone\n');
    expect(outcome.status).toBe('absent');
    if (outcome.status !== 'absent') return;
    expect(outcome.reason).toContain('## Open');
  });

  it('an empty read is absent, not a markdown-export prompt', () => {
    expect(extractOpenSection('').status).toBe('absent');
    expect(extractOpenSection('   \n\n').status).toBe('absent');
  });

  it('unescapeDriveMarkdown only touches backslash-escaped punctuation', () => {
    expect(unescapeDriveMarkdown('resolved\\_at \\# \\| \\- \\.')).toBe('resolved_at # | - .');
    expect(unescapeDriveMarkdown('C:\\path and 50\\% of it')).toBe('C:\\path and 50\\% of it');
  });
});

describe('the executing prose states the export contract (DOC-LITERAL-MARKDOWN)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('the orchestrator Phase 1 block names the markdown export and the extractor', () => {
    const doc = read('agents/ace-orchestrator.md');
    const phase1 = doc.slice(
      doc.indexOf('### Phase 1: Idea to Design'),
      doc.indexOf('### Phase 2:', doc.indexOf('### Phase 1: Idea to Design')),
    );
    // The durable ledger is a CONVERTED gdoc: the default text/plain export
    // strips `##` and flattens its tables, so the read must name the format.
    expect(phase1, 'Phase 1 must name the export format').toContain("exportAs: 'text/markdown'");
    expect(phase1, 'Phase 1 must name the extractor').toContain('extractOpenSection');
  });

  it('idea-to-pdd names the markdown export where it reads the ledger back', () => {
    const skill = read('skills/idea-to-pdd/SKILL.md');
    expect(skill, 'the skill must name the export format').toContain("exportAs: 'text/markdown'");
    expect(skill, 'the skill must name the extractor').toContain('extractOpenSection');
  });
});
