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
  parseOpenRows,
  selectOpenRows,
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

/**
 * dimagi-internal/ace#2115 — the cap said HOW MUCH, never WHICH, and the prose
 * that filled the gap said "the most recent open rows".
 *
 * `## Open` is a live work list a run only ever leaves rows on, so a question
 * is old BECAUSE nobody has answered it. Recency-first truncation therefore
 * cuts the long-standing blockers and keeps the freshly-raised detail — the
 * precise inversion of what the cap should protect.
 *
 * The fixture below is not an invented shape: it is the VERBATIM
 * `exportAs: 'text/markdown'` read of `ACE/spark-facilitator/open-questions.md`
 * (file `1-ALB_Yax5xfDB6U1VpKY3eEjVFfoVjIXsvM_dopIEbo`, revision 18) taken
 * during run `20260906-2233` — the read that produced the issue. Its `## Open`
 * section is 15,187 chars over 21 rows, so the 8,000-char cap fires, and
 * selecting most-recent-first drops the ledger's ONLY `Go/no-go` row while
 * keeping `proposal-generator-boundary`, whose own `blocking:` field calls it
 * non-blocking for the pilot window.
 */
describe('ranking the ## Open rows before the cut (#2115)', () => {
  const sparkLedger = () =>
    fs.readFileSync(
      path.join(process.cwd(), 'test/fixtures/open-questions/spark-facilitator.text-markdown.md'),
      'utf8',
    );

  const sparkOpenSection = () => {
    const outcome = extractOpenSection(sparkLedger());
    if (outcome.status !== 'ok') throw new Error(`fixture unreadable: ${outcome.status}`);
    return outcome.section;
  };

  it('the fixture really is the over-cap, recency-hostile case (ground truth)', () => {
    const section = sparkOpenSection();
    expect(section.length, '## Open chars').toBeGreaterThan(OPEN_QUESTIONS_INLINE_CAP_CHARS);
    expect(section.length).toBe(15_187);

    const { rows } = parseOpenRows(section);
    expect(rows, '21 open rows').toHaveLength(21);

    // The go/no-go row is in the OLDEST cohort; the row that survived
    // recency-first truncation is in the NEWEST one. That inversion is the bug.
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('cbf-smartphones-and-connectivity')?.tier).toBe('go-no-go');
    expect(byId.get('cbf-smartphones-and-connectivity')?.raisedBy).toBe('20260817-1610');
    expect(byId.get('proposal-generator-boundary')?.raisedBy).toBe('20260828-0703');

    const oldest = [...rows].sort((a, b) => (a.raisedBy ?? '').localeCompare(b.raisedBy ?? ''))[0];
    expect(oldest.raisedBy, 'the go/no-go sits in the oldest cohort').toBe('20260817-1610');
  });

  it('the Go/no-go row survives the 8,000-char cut — the regression', () => {
    const result = selectOpenRows({ section: sparkOpenSection() });

    expect(result.truncated, 'the cap fires on this ledger').toBe(true);
    expect(result.inlined.length).toBeLessThanOrEqual(OPEN_QUESTIONS_INLINE_CAP_CHARS);

    // THE assertion. Recency-first dropped this row; ranking keeps it first.
    expect(result.includedIds, 'the go/no-go row is inlined').toContain(
      'cbf-smartphones-and-connectivity',
    );
    expect(result.includedIds[0], 'and it is inlined FIRST').toBe(
      'cbf-smartphones-and-connectivity',
    );
    expect(result.inlined, 'its text really is in the block').toContain(
      'Do the CBFs who would be in the pilot have smartphones',
    );
  });

  it('rows gating phases this run executes outrank rows that gate nothing yet', () => {
    const result = selectOpenRows({ section: sparkOpenSection() });

    // Recency-first dropped all four of these; three gate phases 3/4 that the
    // run was about to execute.
    for (const id of [
      'fiyp-media-assets', // Before Phase 3
      'gps-capture-acceptability', // Before Phase 3
      'lookup-table-provisioning', // Before Phase 3
      'pilot-district-and-communities', // Before Phase 4
    ]) {
      expect(result.includedIds, id).toContain(id);
    }

    // ...and the rows whose own blocking field defers them are the ones cut.
    for (const id of [
      'proposal-generator-boundary', // "Non-blocking for the Goal Setting pilot"
      'rwanda-two-cbf-attribution', // Before expansion
      'progression-affects-payment', // Post-pilot
      'assessment-item-rotation', // Non-blocking
    ]) {
      expect(result.omittedIds, id).toContain(id);
    }
  });

  it('every row is accounted for — nothing vanishes between the two lists', () => {
    const section = sparkOpenSection();
    const { rows } = parseOpenRows(section);
    const result = selectOpenRows({ section });

    expect(result.includedIds.length + result.omittedIds.length).toBe(rows.length);
    expect(new Set([...result.includedIds, ...result.omittedIds]).size).toBe(rows.length);
    expect(result.reason, 'the omitted ids are named in the pasteable reason').toContain(
      'assessment-item-rotation',
    );
    expect(result.reason).toContain('NOT reconciled by this run');
  });

  /**
   * The minimal shape of the same defect, so the rule is legible without the
   * 21-row ledger: oldest row is the Go/no-go, newest is Non-blocking, and the
   * budget only fits one.
   */
  const row = (id: string, raisedBy: string, blocking: string, pad = 0) =>
    `- **id:** ${id} **question:** Q? ${'x'.repeat(pad)} **raised_by:** ${raisedBy} ` +
    `**owner:** operator **blocking:** ${blocking}`;

  it('oldest Go/no-go beats newest Non-blocking when only one fits', () => {
    const section = [
      '## Open',
      '',
      row('newest-detail', '20260901-0000', 'Non-blocking', 200),
      '',
      row('oldest-blocker', '20260101-0000', 'Go/no-go. The pilot cannot run otherwise.', 200),
    ].join('\n');

    const result = selectOpenRows({ section, capChars: 400 });
    expect(result.includedIds).toEqual(['oldest-blocker']);
    expect(result.omittedIds).toEqual(['newest-detail']);
    expect(result.truncated).toBe(true);
  });

  it('Before Phase N sorts ASCENDING — the phase the run reaches first wins', () => {
    const section = [
      '## Open',
      '',
      row('late', '20260901-0000', 'Before Phase 8'),
      '',
      row('early', '20260101-0000', 'Before Phase 3'),
      '',
      row('middle', '20260801-0000', 'Before Phase 6'),
    ].join('\n');

    const { includedIds } = selectOpenRows({ section, capChars: 10_000 });
    expect(includedIds).toEqual(['early', 'middle', 'late']);
  });

  it('the full tier order is go/no-go → Before Phase N → everything else', () => {
    const section = [
      '## Open',
      '',
      row('non-blocking', '20260901-0000', 'Non-blocking'),
      '',
      row('post-pilot', '20260902-0000', 'Post-pilot'),
      '',
      row('closeout', '20260903-0000', 'Before closeout'),
      '',
      row('expansion', '20260904-0000', 'Before expansion'),
      '',
      row('phase-4', '20260101-0000', 'Before Phase 4'),
      '',
      row('gng', '20260102-0000', 'Go/no-go. Everything stops.'),
    ].join('\n');

    const { includedIds } = selectOpenRows({ section, capChars: 10_000 });
    expect(includedIds.slice(0, 2)).toEqual(['gng', 'phase-4']);
    // Within the trailing tier, recency is the tiebreak and only there.
    expect(includedIds.slice(2)).toEqual(['expansion', 'closeout', 'post-pilot', 'non-blocking']);
  });

  it('recency is the WITHIN-tier tiebreak, newest first', () => {
    const section = [
      '## Open',
      '',
      row('older', '20260101-0000', 'Before Phase 3'),
      '',
      row('newer', '20260901-0000', 'Before Phase 3'),
    ].join('\n');

    expect(selectOpenRows({ section, capChars: 10_000 }).includedIds).toEqual(['newer', 'older']);
  });

  it('a row with no blocking: field lands in the trailing tier, not the front', () => {
    const section = [
      '## Open',
      '',
      '- **id:** unlabelled **question:** Q? **raised_by:** 20260901-0000 **owner:** operator',
      '',
      row('labelled', '20260101-0000', 'Before Phase 8'),
    ].join('\n');

    const { includedIds } = selectOpenRows({ section, capChars: 10_000 });
    expect(includedIds).toEqual(['labelled', 'unlabelled']);
  });

  it('under the cap it is a no-op: every row inlined, nothing omitted', () => {
    const section = ['## Open', '', row('a', '20260101-0000', 'Non-blocking')].join('\n');
    const result = selectOpenRows({ section });
    expect(result.truncated).toBe(false);
    expect(result.omittedIds).toEqual([]);
    expect(result.includedIds).toEqual(['a']);
    expect(result.inlined).toContain('## Open');
  });

  it('the fill STOPS at the first row that does not fit — no small-row jumping', () => {
    // A short Non-blocking row must never displace a long Before-Phase-3 one.
    const section = [
      '## Open',
      '',
      row('big-blocker', '20260101-0000', 'Before Phase 3', 400),
      '',
      row('tiny-trivia', '20260901-0000', 'Non-blocking'),
    ].join('\n');

    const result = selectOpenRows({ section, capChars: 200 });
    expect(result.includedIds).toEqual([]);
    expect(result.omittedIds).toEqual(['big-blocker', 'tiny-trivia']);
  });

  it('the ## Open heading and any preamble always ride along', () => {
    const section = [
      '## Open',
      '',
      'A note the ledger carries above its rows.',
      '',
      row('a', '20260101-0000', 'Go/no-go. Stop.'),
    ].join('\n');

    const result = selectOpenRows({ section, capChars: 10_000 });
    expect(result.inlined.startsWith('## Open')).toBe(true);
    expect(result.inlined).toContain('A note the ledger carries above its rows.');
  });

  it('a section with no rows is passed through, not mangled', () => {
    const result = selectOpenRows({ section: '## Open\n\n_None._', capChars: 10 });
    expect(result.inlined).toBe('## Open\n\n_None._');
    expect(result.omittedIds).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('a row with no id: is still reported when omitted — never silently dropped', () => {
    const section = [
      '## Open',
      '',
      '- **id:** kept **question:** Q? **raised_by:** 20260101-0000 **blocking:** Go/no-go. Stop.',
      '',
      `- **question:** ${'y'.repeat(200)} **raised_by:** 20260901-0000 **blocking:** Non-blocking`,
    ].join('\n');

    // The second bullet carries no `id:`, so it is not a row start — it folds
    // into the first row. Give it one so it parses as its own row.
    const withId = section.replace('- **question:**', '- **id:**  **question:**');
    const result = selectOpenRows({ section: withId, capChars: 150 });
    expect(result.omittedIds.some((id) => id.startsWith('<unidentified row'))).toBe(true);
  });

  it('Drive\'s escaped raised\\_by still parses (the export really escapes it)', () => {
    const raw = sparkLedger();
    expect(raw, 'the exporter really does escape').toContain('raised\\_by');
    // extractOpenSection unescapes, but the field regexes tolerate both forms
    // so a caller that hands over a raw slice is not silently mis-ranked.
    const escaped = '## Open\n\n- **id:** a **raised\\_by:** 20260101-0000 **blocking:** Go/no-go. Stop.';
    const { rows } = parseOpenRows(escaped);
    expect(rows[0].raisedBy).toBe('20260101-0000');
    expect(rows[0].tier).toBe('go-no-go');
  });
});

describe('the executing prose ranks rather than truncating by recency (#2115)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('the orchestrator Phase 1 block names the ranker and drops "most recent"', () => {
    const doc = read('agents/ace-orchestrator.md');
    const start = doc.indexOf('### Phase 1: Idea to Design');
    const phase1 = doc.slice(start, doc.indexOf('### Phase 2:', start));

    expect(phase1, 'Phase 1 must name the selector').toContain('selectOpenRows');
    expect(phase1, 'Phase 1 must name the sort key').toContain('blocking:');
    expect(phase1, 'Phase 1 must require the omitted ids be named').toContain('omittedIds');
    // The rule this replaces. "most recent" must not survive anywhere in the
    // block, or the doc reverts the fix by being re-read.
    expect(phase1.toLowerCase(), 'the recency rule is gone').not.toContain('most recent');
  });

  it('the classifier reason no longer prescribes recency either', () => {
    const decision = classifyOpenQuestionsInline({
      charCount: 26_577,
      oppRootNames: REAL_OPP_ROOT,
    });
    expect(decision.reason.toLowerCase()).not.toContain('most recent');
    expect(decision.reason).toContain('selectOpenRows');
  });
});
