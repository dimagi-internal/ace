/**
 * The ledger PARSER — used only by the one-time migration tool
 * (scripts/migrate-open-questions.ts via lib/open-questions-migrate.ts).
 *
 * No run reads an open-questions ledger any more (operator decision
 * 2026-10-07, ace#2757): Phase 1's legacy read and its inline bounds
 * (ace#1201 / #1487 / #2115 / #2396) were deleted with
 * lib/open-questions-inline.ts. What survives is the read-back half the
 * migration needs to open a real ledger exported from Drive — converted gdocs,
 * backslash-escaped headings, and flattened docs (#2367).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { extractOpenSection, parseOpenRows, unescapeDriveMarkdown } from '../../lib/open-questions-migrate.js';

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

/**
 * dimagi-internal/ace#2367 (parser half) — a ledger whose `## Open` /
 * `## Archive` headings were typed as literal paragraph text (never given
 * Google Docs' real Heading style) round-trips through the SAME
 * `exportAs: 'text/markdown'` path the CONVERTED-doc suite above exercises,
 * except Drive escapes the literal `#` characters exactly as it does inside a
 * table cell: `## Open` → `\#\# Open`. The heading regexes never matched
 * that, so a correctly-shaped, fully-intact ledger came back `absent`,
 * blaming the ledger's shape rather than the escaping. Verified against the
 * live ledger cited in the issue (`1oHNL2EszxRh7BEsnHd2SvxxIk11pEu2WqENI-T5JlEQ`):
 * matching the raw read gave `absent`; unescaping before the heading match
 * gave `ok` with all 15 rows and `## Archive` still excluded.
 */
describe('reading a ledger whose headings are literal, backslash-escaped text (#2367)', () => {
  const ESCAPED_HEADING_LEDGER = [
    '# Probe — Open Design Questions',
    '',
    '\\#\\# Settled — do not re-open',
    '',
    '- Nigeria PPI, 2020 — resolved',
    '',
    '\\#\\# Open',
    '',
    '- **id:** row-one',
    '  **blocking:** Before Phase 3',
    '  **raised\\_by:** 20260810-0900',
    '',
    '- **id:** row-two',
    '  **blocking:** Non-blocking',
    '  **raised\\_by:** 20260811-0900',
    '',
    '\\#\\# Archive',
    '',
    '- **id:** row-gone',
    '  **resolved\\_at:** 2026-08-01T00:00:00Z',
    '  **resolution\\_note:** settled long ago.',
    '',
  ].join('\n');

  it('an escaped-but-correctly-shaped ## Open heading resolves to ok, not absent', () => {
    const outcome = extractOpenSection(ESCAPED_HEADING_LEDGER);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    expect(outcome.section.startsWith('## Open'), 'the heading itself is unescaped').toBe(true);
    // Both rows survive with their fields intact.
    expect(outcome.section).toContain('**id:** row-one');
    expect(outcome.section).toContain('**id:** row-two');
    expect(outcome.section, 'the field escape is undone too').toContain('**raised_by:**');
    expect(outcome.section).not.toContain('raised\\_by');

    const { rows } = parseOpenRows(outcome.section);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['row-one', 'row-two']);
    expect(rows.map((r) => r.raisedBy)).toEqual(['20260810-0900', '20260811-0900']);
  });

  it('## Archive is still structurally excluded even though its heading was escaped too', () => {
    const outcome = extractOpenSection(ESCAPED_HEADING_LEDGER);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    expect(outcome.section).not.toContain('## Archive');
    expect(outcome.section).not.toContain('row-gone');
    expect(outcome.section).not.toContain('## Settled');
    expect(outcome.section).not.toContain('Nigeria PPI');
  });

  it('control: a genuinely heading-stripped text/plain export still asks for a re-read, not ok', () => {
    // Same failure signature nothing else should swallow: no ATX headings anywhere,
    // but a bare "Open" line — this must keep returning needs-markdown-export.
    const outcome = extractOpenSection(
      fs.readFileSync(
        path.join(process.cwd(), 'test/fixtures/open-questions', 'converted-gdoc.text-plain.txt'),
        'utf8',
      ),
    );
    expect(outcome.status).toBe('needs-markdown-export');
  });

  it('control: a ledger with genuinely no ## Open section still returns absent', () => {
    const outcome = extractOpenSection(
      ['# Probe — Open Design Questions', '', '\\#\\# Archive', '', '- **id:** row-gone'].join('\n'),
    );
    expect(outcome.status).toBe('absent');
    if (outcome.status !== 'absent') return;
    expect(outcome.reason).toContain('## Open');
  });
});

/**
 * dimagi-internal/ace#2367 (the remaining half) — the ledger with NO headings
 * at all.
 *
 * PR #2397 fixed the adjacent shape: headings typed as literal text, which
 * Drive's markdown exporter escapes to `\#\# Open`. Unescaping before the
 * heading match resolves those. It does nothing for the shape the issue was
 * actually filed against, which carries no `#` characters at ALL — a ledger
 * flattened by an earlier plain-text WRITE, where `Open` and `Archive` are
 * ordinary paragraphs and every row is a run-on paragraph.
 *
 * Verified against `origin/main` at 726e1fe7 (post-#2397) with a reconstruction
 * of the poverty-graduation ledger ace#2367 quotes:
 *
 *   $ npx tsx probe-2367-premise.ts
 *   status: needs-markdown-export
 *   reason: "... Re-read the file with `drive_read_file(..., exportAs:
 *            'text/markdown')` — do NOT parse this text."
 *
 * That verdict is not merely unhelpful, it LOOPS: the read already WAS the
 * markdown export, so the named remedy returns the same bytes, and Phase 1
 * inlines none of the opp's 15 open rows (including the design author's hold
 * on the work order) while reporting a cause that is false.
 *
 * Two things are wrong and both are fixed here:
 *
 *  1. **The module guesses at which export the caller requested.** The caller
 *     KNOWS — it passed `exportAs` to `drive_read_file`. `extractOpenSection`
 *     now takes that as its second argument, so `text/markdown` + no headings
 *     is a FLATTENED DOC (repair it) and `text/plain`/unknown + no headings
 *     stays `needs-markdown-export` (re-read it). No heuristic over Drive's
 *     export bytes; the authoritative fact comes from the party that has it.
 *  2. **A flattened doc must not be silently read as EMPTY, and must not be
 *     silently read as WHOLE either.** The recovery is delimited: it starts at
 *     the bare `Open` label and stops at the bare `Archive` label (or at the
 *     first non-list line after the rows begin), so the one invariant this
 *     module enforces structurally — `## Archive` is never inlined — survives
 *     a degraded read. Treating the whole body as the open section would
 *     inline resolved history as live questions, which is the harm ace#1487
 *     and the two-section shape exist to prevent; that is the false positive
 *     this suite refuses to trade into.
 */
describe('a ledger with NO headings at all — the flattened doc (#2367)', () => {
  const fixture = (name: string) =>
    fs.readFileSync(path.join(process.cwd(), 'test/fixtures/open-questions', name), 'utf8');

  /**
   * NOT an inline literal. These are the VERBATIM bytes Drive returned on
   * 2026-09-17 for a probe doc built the way the poverty-graduation ledger was
   * broken: `drive_create_doc_from_markdown` fed content with NO `#` headings
   * — the shape a turn produces when it reads the doc back as `text/plain`
   * (which strips the markers) and writes that text out again.
   *
   *   test/fixtures/open-questions/flattened-gdoc.text-markdown.md  (exportAs markdown)
   *   test/fixtures/open-questions/flattened-gdoc.text-plain.txt    (default export)
   *
   * The probe doc (`1rISrQ7MpEsCGUmheB94RsPz-BbkQ4kstLQYq9nnPybg`, under the
   * ACE root) was trashed immediately after capture, as the 2026-08-26 probe
   * above was.
   *
   * What the capture SETTLES, rather than assumes:
   *   - the `text/markdown` export of a flattened doc carries no `#` at all —
   *     `Open` and `Archive` are bare paragraphs, so the escaped-heading fix
   *     (#2397) cannot reach it;
   *   - `**bold**` runs and `raised\_by` escaping DO survive, so the rows are
   *     intact and worth recovering;
   *   - the `text/plain` export of the SAME doc drops `**` entirely
   *     (`* id: partner-selection-on-hold question: …`), so its rows carry no
   *     `- **id:**` bullet and genuinely cannot be parsed — which is why that
   *     branch must keep refusing rather than recovering.
   */
  const FLATTENED_LEDGER = fixture('flattened-gdoc.text-markdown.md');

  it('a markdown READ of a flattened doc is flattened-headings, not a re-read prompt', () => {
    const outcome = extractOpenSection(FLATTENED_LEDGER, 'text/markdown');
    expect(
      outcome.status,
      'the caller already read markdown — telling it to read markdown again is the loop',
    ).toBe('flattened-headings');
    if (outcome.status !== 'flattened-headings') return;

    expect(outcome.reason, 'the remedy must be REPAIR, not re-read').toMatch(/repair|rewrite/i);
    expect(
      outcome.reason,
      'and it must not send the caller back round the re-read loop',
    ).not.toContain("Re-read the file with `drive_read_file");
  });

  it('the open rows are recovered rather than silently dropped', () => {
    const outcome = extractOpenSection(FLATTENED_LEDGER, 'text/markdown');
    expect(outcome.status).toBe('flattened-headings');
    if (outcome.status !== 'flattened-headings') return;

    expect(outcome.section).toContain('partner-selection-on-hold');
    expect(outcome.section).toContain('consumption-support-paid');
    // Drive's escaping is undone on this path too, so the rows parse.
    expect(outcome.section).toContain('**raised_by:**');

    const { rows } = parseOpenRows(outcome.section);
    expect(rows.map((r) => r.id)).toEqual([
      'partner-selection-on-hold',
      'consumption-support-paid',
    ]);
  });

  it('the ARCHIVE still never rides along — the recovery is delimited, not whole-body', () => {
    const outcome = extractOpenSection(FLATTENED_LEDGER, 'text/markdown');
    expect(outcome.status).toBe('flattened-headings');
    if (outcome.status !== 'flattened-headings') return;

    expect(outcome.section, 'resolved history is not a live question').not.toContain(
      'ppi-instrument',
    );
    expect(outcome.section).not.toContain('Kenya 2015 PPI');
    expect(outcome.section).not.toContain('resolution_note');
    // Nor the title paragraph above the bare `Open` label.
    expect(outcome.section).not.toContain('ACE-2367 probe');
    expect(outcome.section.startsWith('Open')).toBe(true);
  });

  it('the CAPTURED text/plain export of the SAME doc is refused — its rows are unparseable', () => {
    const plain = fixture('flattened-gdoc.text-plain.txt');
    // Ground truth from the capture: the plain export drops the bold runs, so
    // the `- **id:**` row marker does not exist and nothing could be recovered.
    expect(plain, 'no bold survives the plain export').not.toContain('**id:**');
    expect(parseOpenRows(plain).rows, 'so there is nothing to parse').toHaveLength(0);

    expect(extractOpenSection(plain, 'text/plain').status).toBe('needs-markdown-export');
    expect(extractOpenSection(plain).status).toBe('needs-markdown-export');
  });

  it('a bare Archive label with an EMPTY Open section still terminates the recovery', () => {
    const outcome = extractOpenSection(
      ['Open Questions', '', 'Open', '', 'Archive', '', '- **id:** row-gone'].join('\n'),
      'text/markdown',
    );
    expect(outcome.status).toBe('flattened-headings');
    if (outcome.status !== 'flattened-headings') return;
    expect(outcome.section).not.toContain('row-gone');
  });

  it('a flattened doc with NO bare Open label is absent — never a whole-body fallback', () => {
    // The false positive this must not trade into: with no label there is no
    // way to tell a live question from an archived one, so inventing a section
    // would inline the whole ledger, resolved rows and all.
    const outcome = extractOpenSection(
      [
        'Open Questions — some opp',
        '',
        '- **id:** row-one **question:** still live?',
        '',
        '- **id:** row-gone **resolved\\_at:** 2026-08-01T00:00:00Z',
      ].join('\n'),
      'text/markdown',
    );
    expect(outcome.status).toBe('absent');
    if (outcome.status !== 'absent') return;
    expect(outcome).not.toHaveProperty('section');
  });

  it('control: the SAME bytes read as text/plain still ask for a re-read', () => {
    const outcome = extractOpenSection(FLATTENED_LEDGER, 'text/plain');
    expect(outcome.status).toBe('needs-markdown-export');
  });

  it('control: an unstated export still asks for a re-read, but names the flattened case too', () => {
    // Backward compatibility: every pre-existing caller passes one argument.
    const outcome = extractOpenSection(FLATTENED_LEDGER);
    expect(outcome.status).toBe('needs-markdown-export');
    if (outcome.status !== 'needs-markdown-export') return;
    // ...and the loop is broken even for a caller that never learns the new
    // argument: the remedy says what to do when the re-read returns the same
    // bytes, by naming the terminating branch and how to reach it.
    expect(outcome.reason).toContain("exportAs: 'text/markdown'");
    expect(outcome.reason, 'the second, terminating branch is named').toContain(
      'flattened-headings',
    );
  });

  it('NEGATIVE CONTROL: a well-formed ## Open / ## Archive doc is byte-identical, with or without the new argument', () => {
    const WELL_FORMED = [
      '# Open Questions',
      '',
      '## Open',
      '',
      '- **id:** row-one',
      '  **blocking:** Before Phase 3',
      '',
      '## Archive',
      '',
      '- **id:** row-gone',
    ].join('\n');

    const bare = extractOpenSection(WELL_FORMED);
    const markdown = extractOpenSection(WELL_FORMED, 'text/markdown');
    const plain = extractOpenSection(WELL_FORMED, 'text/plain');

    for (const [label, outcome] of [
      ['no argument', bare],
      ["'text/markdown'", markdown],
      ["'text/plain'", plain],
    ] as const) {
      expect(outcome.status, label).toBe('ok');
      if (outcome.status !== 'ok') continue;
      expect(outcome.section, label).toBe('## Open\n\n- **id:** row-one\n  **blocking:** Before Phase 3');
      expect(outcome.section, label).not.toContain('row-gone');
    }
    expect(markdown).toEqual(bare);
    expect(plain).toEqual(bare);
  });

  it('NEGATIVE CONTROL: the escaped-heading ledger (#2397) is unchanged by the new argument', () => {
    const ESCAPED = [
      '# Probe',
      '',
      '\\#\\# Open',
      '',
      '- **id:** row-one',
      '',
      '\\#\\# Archive',
      '',
      '- **id:** row-gone',
    ].join('\n');

    expect(extractOpenSection(ESCAPED, 'text/markdown')).toEqual(extractOpenSection(ESCAPED));
    const outcome = extractOpenSection(ESCAPED, 'text/markdown');
    expect(outcome.status, 'a real (escaped) heading still wins over the flattened path').toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.section).toBe('## Open\n\n- **id:** row-one');
  });

  it('NEGATIVE CONTROL: the converted-gdoc fixtures are unaffected by the new argument', () => {
    const fixture = (name: string) =>
      fs.readFileSync(path.join(process.cwd(), 'test/fixtures/open-questions', name), 'utf8');

    for (const name of ['converted-gdoc.text-markdown.md', 'literal-markdown-gdoc.text-plain.txt']) {
      expect(extractOpenSection(fixture(name), 'text/markdown'), name).toEqual(
        extractOpenSection(fixture(name)),
      );
      expect(extractOpenSection(fixture(name)).status, name).toBe('ok');
    }
  });
});
