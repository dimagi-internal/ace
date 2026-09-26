/**
 * How much of the durable, opp-root `open-questions.md` Phase 1 may inline —
 * and when it must not be inlined at all.
 *
 * dimagi-internal/ace#1201 gave the durable open-questions ledger its missing
 * READ half: the orchestrator inlines `<opp>/open-questions.md` at Phase 1 so
 * a run can declare, per pre-existing question, whether it **resolves /
 * carries forward / contradicts** it. That read is correct and stays.
 *
 * dimagi-internal/ace#1487 is what nobody bounded around it. Two properties
 * compounded:
 *
 *  1. **Append-only with no garbage collection.** Every run appends its
 *     reconciliation, so the ledger only grows. `bednet-check-2-visit`'s
 *     reached 26,577 chars across three runs, and `idea-to-pdd/SKILL.md`
 *     mandates a read-back statement for EVERY pre-existing question — so the
 *     cost of Phase 1 grows linearly with the ledger, forever.
 *  2. **No opp-class scoping.** `bednet-check-2-visit` is the `/ace:iterate`
 *     fixture, whose brief says in as many words that domain detail beyond
 *     what is written must not be invented. Inlining 26KB of accumulated run
 *     history contradicts the brief, and nothing arbitrated — the run's PDD
 *     came out 43,003 chars from a 15,449-char brief, the excess inherited
 *     rather than derived.
 *
 * That is the same hazard ace#1325 closed (ACE reading its own prior output as
 * Phase 1 source evidence) arriving through the sanctioned inline-handoff path
 * instead of the migration path. A fixture opp that cannot hold its baseline
 * still stops measuring "can ACE build what the brief specifies" and starts
 * measuring "can ACE re-litigate its own back-catalogue".
 *
 * So the inline is now CLASSIFIED, not unconditional. This module is the
 * classifier: pure, no I/O, so the orchestrator prose and the tests bind to
 * one rule rather than two prose copies that drift.
 *
 * The fixture signal is NOT a new `opp.yaml` field (the issue's suggestion) —
 * it already exists at the opp root as `iterate-state.yaml`, registered in
 * `lib/opp-root-files.ts`. This module imports that registry rather than
 * re-enumerating it, because enumerating ACE-owned opp-root names per
 * incident IS the defect #1282/#1325 closed.
 *
 * The companion bound is a SHAPE, not just a size: `skills/idea-to-pdd`
 * now writes the durable doc with exactly two sections, `## Open` and
 * `## Archive`, and a resolved question MOVES to `## Archive` (carrying
 * `resolved_at` / `resolved_by` / `resolution_note`) instead of being
 * annotated in place — the same convention `run_state.yaml`'s
 * `open_questions:` list already follows
 * (`agents/orchestrator-reference.md § Cruft management`). `## Archive` is
 * never read back and never inlined, so the live list stops carrying the
 * audit trail's weight.
 */

import { isIterateFixtureOpp } from './opp-root-files.js';

/**
 * Above this many characters, the orchestrator passes the `file_id` plus a
 * RANKED subset of the open rows rather than the whole `## Open` section
 * (`selectOpenRows` below picks them), and names both the truncation and the
 * ids it omitted at the Phase 1→2 pause.
 *
 * 8,000 chars is roughly a third of the ledger that triggered #1487 and comfortably
 * holds a healthy opp's live question list; a doc past it is carrying history the
 * `## Archive` move should already have absorbed, so tripping this bound is itself
 * a signal the ledger needs pruning.
 */
export const OPEN_QUESTIONS_INLINE_CAP_CHARS = 8000;

export type OpenQuestionsInlineMode =
  /** Do not pass the durable ledger at all — the brief is the whole intended input. */
  | 'skip-fixture'
  /**
   * Pass the `## Open` section only, cut to the rows `selectOpenRows` ranks
   * highest by `blocking:`, plus the `file_id` and the omitted ids.
   */
  | 'inline-open-section-only'
  /** Pass the `## Open` section in full. */
  | 'inline-full';

export interface OpenQuestionsInlineInput {
  /** Size of the durable doc as read, in characters. */
  charCount: number;
  /** Direct children of `ACE/<opp>/`, by name (files and folders alike). */
  oppRootNames: string[];
}

export interface OpenQuestionsInlineDecision {
  mode: OpenQuestionsInlineMode;
  /** One sentence the orchestrator can paste into the Phase 1→2 pause summary. */
  reason: string;
  capChars: number;
}

/**
 * Decide how much of the durable `open-questions.md` Phase 1 may inline.
 *
 * Rules, in order:
 *   (a) fixture opp (an `iterate-state.yaml` at the opp root) → `skip-fixture`,
 *       at ANY size;
 *   (b) over `OPEN_QUESTIONS_INLINE_CAP_CHARS` → `inline-open-section-only`;
 *   (c) otherwise → `inline-full`.
 */
export function classifyOpenQuestionsInline(
  input: OpenQuestionsInlineInput,
): OpenQuestionsInlineDecision {
  const { charCount, oppRootNames } = input;

  if (isIterateFixtureOpp(oppRootNames)) {
    return {
      mode: 'skip-fixture',
      reason:
        'Fixture opp (iterate-state.yaml at the opp root): the durable open-questions ledger ' +
        'is NOT inlined at Phase 1 — the brief is the whole intended input, and a regression ' +
        'baseline must not absorb accumulated run history (dimagi-internal/ace#1487).',
      capChars: OPEN_QUESTIONS_INLINE_CAP_CHARS,
    };
  }

  if (charCount > OPEN_QUESTIONS_INLINE_CAP_CHARS) {
    return {
      mode: 'inline-open-section-only',
      reason:
        `Durable open-questions ledger is ${charCount} chars, over the ` +
        `${OPEN_QUESTIONS_INLINE_CAP_CHARS}-char inline cap: pass the file_id plus the rows ` +
        '`selectOpenRows` ranks highest by their `blocking:` field — NOT the newest rows ' +
        '(## Archive is never inlined) — and name both the truncation and the returned ' +
        '`omittedIds` at the Phase 1→2 pause (dimagi-internal/ace#1487, ace#2115).',
      capChars: OPEN_QUESTIONS_INLINE_CAP_CHARS,
    };
  }

  return {
    mode: 'inline-full',
    reason:
      `Durable open-questions ledger is ${charCount} chars, within the ` +
      `${OPEN_QUESTIONS_INLINE_CAP_CHARS}-char inline cap: pass its ## Open section in full ` +
      '(## Archive is never inlined).',
    capChars: OPEN_QUESTIONS_INLINE_CAP_CHARS,
  };
}

/* ------------------------------------------------------------------------- *
 * The READ-BACK half: which Drive export shape `## Open` actually survives.
 * ------------------------------------------------------------------------- */

/**
 * `open-questions.md` is a human-facing prose doc, so `skills/idea-to-pdd`
 * writes it with `drive_create_doc_from_markdown` — Drive CONVERTS the
 * markdown, and the reader sees real headings and real tables instead of raw
 * `##` and pipe characters. That write contract is right (a `run-surface-audit`
 * flagged the un-converted `hh-poverty-targeting` ledger as
 * `DOC-LITERAL-MARKDOWN` — it read as a broken export), but it changes what the
 * READ gets back, and the read is what Phase 1's inline consumes.
 *
 * Measured against a converted probe doc in Drive (2026-08-26; a structural
 * mirror of that ledger, trashed after):
 *
 *   - `drive_read_file` DEFAULT export (`text/plain`) returns `Open` — the
 *     `##` markers are GONE. Tables are flattened to one cell per line with a
 *     leading tab, so row boundaries are destroyed; `---` becomes
 *     `________________`; lines are CRLF-terminated.
 *   - `exportAs: 'text/markdown'` returns `## Open` with the pipe table intact
 *     (`| \# | PDD ref | ... |`, alignment row `| :---- | :---- |`), bold runs
 *     preserved, and markdown-significant characters BACKSLASH-ESCAPED
 *     (`resolved\_at`, `\#`).
 *
 * So on a converted doc the default export does not merely lose formatting —
 * it silently yields a `## Open` that no longer resolves and a question table
 * whose rows have run together. That is the invisible-failure shape: a caller
 * that fell back to the bare `Open` line would hand Phase 1 a mangled ledger
 * and nothing would say so.
 *
 * `extractOpenSection` is therefore the boundary check: it returns the section
 * only from a markdown-shaped read, and NAMES the remedy when handed a
 * heading-stripped plain-text export rather than guessing at it. The rule that
 * `## Archive` is never inlined is enforced structurally here — the section
 * ends at the next H1/H2 — instead of relying on the reader to stop.
 *
 * dimagi-internal/ace#2367 (parser half): a ledger whose `## Open` / `## Archive`
 * headings were written as literal paragraph text (not real Google Docs heading
 * style) round-trips through the SAME `text/markdown` export as `\#\# Open` /
 * `\#\# Archive` — Drive's exporter escapes markdown-significant punctuation in
 * plain paragraph text exactly as it does inside table cells, and a `#` that is
 * not part of a real structural heading is no exception. The heading regexes
 * below (`OPEN_HEADING`, `H1_OR_H2`, `ANY_ATX_HEADING`) therefore never matched,
 * and a correctly-shaped, fully-intact ledger came back `status: 'absent'` —
 * blaming the ledger's shape when the shape was fine and the escaping was the
 * only problem. `unescapeDriveMarkdown` already existed and `#` was already in
 * its `ESCAPED_PUNCTUATION` class; the bug was purely that it ran on the
 * section body AFTER the heading match instead of before it. Unescaping the
 * whole read up front — before any heading regex runs — fixes that ordering
 * and is a no-op on every shape that was already working (a real heading is
 * never escaped, and the `text/plain` export this module also has to detect
 * carries no backslashes at all).
 */

/** CommonMark's escapable ASCII punctuation, as Drive's markdown exporter emits it. */
const ESCAPED_PUNCTUATION = /\\([\\`*_{}[\]()#+\-.!|~<>&$"'])/g;

/**
 * Undo the backslash escaping Drive's markdown exporter applies to
 * markdown-significant characters, so a round-tripped row reads as the row
 * that was written (`resolved\_at` → `resolved_at`).
 */
export function unescapeDriveMarkdown(text: string): string {
  return text.replace(ESCAPED_PUNCTUATION, '$1');
}

/**
 * Which `drive_read_file` export the caller actually requested.
 *
 * ace#2367: two different defects produce the SAME bytes — no ATX headings
 * and a bare `Open` line — and they have OPPOSITE remedies:
 *
 *   - a `text/plain` export of a healthy converted doc → **re-read** it as
 *     `text/markdown`; the doc is fine, the read was wrong;
 *   - a `text/markdown` export of a FLATTENED doc (its headings written as
 *     ordinary paragraphs by a plain-text write) → **repair the doc**; no
 *     re-read will ever return anything different.
 *
 * This module used to guess between them from the bytes, and guessed wrong on
 * the poverty-graduation ledger: it printed the re-read remedy for a read that
 * was already markdown, so Phase 1 went round a loop and inlined none of the
 * opp's 15 open rows. The bytes cannot settle it — but the CALLER can, because
 * the caller chose the `exportAs` and is authoritative about it. So it passes
 * that in rather than having this file infer it (`CLAUDE.md § Close the loop to
 * the source of truth`).
 *
 * `'unknown'` is the backward-compatible default for a caller that has not
 * been updated: it keeps the pre-existing `needs-markdown-export` behaviour,
 * and that branch's `reason` now names the terminating second step so even an
 * un-updated caller cannot loop forever.
 */
export type OpenQuestionsReadExport = 'text/markdown' | 'text/plain' | 'unknown';

export type OpenQuestionsSectionOutcome =
  /** The `## Open` section, verbatim (minus Drive's escaping), `## Archive` excluded. */
  | { status: 'ok'; section: string }
  /**
   * The doc itself has no headings — a ledger flattened by a plain-text write.
   * The live rows were RECOVERED from the bare `Open` label, delimited so the
   * archive still cannot ride along, but this is a DEGRADED read: say so at
   * the pause and repair the doc.
   */
  | { status: 'flattened-headings'; section: string; reason: string }
  /**
   * The read is heading-stripped — a `text/plain` export of a CONVERTED doc.
   * Re-read with `exportAs: 'text/markdown'`; do not parse this text.
   */
  | { status: 'needs-markdown-export'; reason: string }
  /** Markdown-shaped, but carries no `## Open` section. */
  | { status: 'absent'; reason: string };

/** ATX heading at H1 or H2 — the only levels that close the `## Open` section. */
const H1_OR_H2 = /^ {0,3}#{1,2}[ \t]+\S/;
const OPEN_HEADING = /^ {0,3}##[ \t]+Open[ \t]*$/i;
const ANY_ATX_HEADING = /^ {0,3}#{1,6}[ \t]+\S/;
/** The heading text as a CONVERTED doc's plain-text export renders it: no markers. */
const BARE_OPEN_LINE = /^Open$/i;
/**
 * The matching bare `Archive` label. `## Archive` is the ONE section this
 * module excludes structurally, and it is the only other section the canonical
 * write shape defines (`skills/idea-to-pdd/SKILL.md § The durable
 * open-questions doc`), so it is the delimiter a degraded read can rely on.
 */
const BARE_ARCHIVE_LINE = /^Archive$/i;
/** A ledger row: a list bullet. */
const LIST_ITEM = /^\s*[-*]\s+\S/;
/** A row's wrapped continuation line — indented, not a new bullet. */
const CONTINUATION = /^\s+\S/;

/**
 * Pull the `## Open` section out of a read-back of the durable ledger.
 *
 * Pure — no I/O. The caller supplies whatever `drive_read_file` returned; this
 * decides whether that text is parseable at all.
 *
 *   (a) markdown-shaped with a `## Open` heading → `ok`, the section only,
 *       ending at the next H1/H2 so `## Archive` can never ride along;
 *   (b) no ATX headings at all but a bare `Open` line → `needs-markdown-export`
 *       (a `text/plain` export of a converted doc);
 *   (c) otherwise → `absent`.
 *
 * The text is unescaped (`unescapeDriveMarkdown`) BEFORE any heading regex
 * runs, not after — see the doc comment above (ace#2367). That makes an
 * escaped-but-correctly-shaped heading (`\#\# Open`) match like any other, and
 * is a no-op for text that was never escaped, so the returned section (and the
 * `needs-markdown-export` / `absent` classification) never need a second pass.
 */
export function extractOpenSection(
  text: string,
  exportAs: OpenQuestionsReadExport = 'unknown',
): OpenQuestionsSectionOutcome {
  const lines = unescapeDriveMarkdown(text.replace(/\r\n?/g, '\n')).split('\n');
  const start = lines.findIndex((line) => OPEN_HEADING.test(line));

  if (start === -1) {
    const hasHeadings = lines.some((line) => ANY_ATX_HEADING.test(line));
    const bareOpen = lines.findIndex((line) => BARE_OPEN_LINE.test(line.trim()));
    if (!hasHeadings && bareOpen !== -1) {
      if (exportAs === 'text/markdown') {
        return recoverFlattenedOpenSection(lines, bareOpen);
      }
      return {
        status: 'needs-markdown-export',
        reason:
          'The read carries no ATX headings but does carry a bare "Open" line: this is a ' +
          'text/plain export of a CONVERTED Google Doc, so the `##` markers are stripped and ' +
          'any pipe table in it has been flattened to one cell per line. Re-read the file with ' +
          "`drive_read_file(..., exportAs: 'text/markdown')` — do NOT parse this text. " +
          'If you ALREADY read it as text/markdown, do NOT re-read it — the bytes will not ' +
          "change. Pass 'text/markdown' as extractOpenSection's second argument instead: the " +
          'doc itself is flattened, and that returns `flattened-headings` with the live rows ' +
          'recovered plus the repair to make (dimagi-internal/ace#2367).',
      };
    }
    return {
      status: 'absent',
      reason:
        'No `## Open` heading in the durable open-questions doc' +
        (hasHeadings ? '' : ', and no bare "Open" label to recover one from') +
        '. Nothing is inlined at Phase 1; ' +
        'the ledger needs the two-section `## Open` / `## Archive` shape ' +
        '(skills/idea-to-pdd/SKILL.md § The durable open-questions doc).',
    };
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (H1_OR_H2.test(lines[i])) {
      end = i;
      break;
    }
  }

  return {
    status: 'ok',
    // Already unescaped up front (see the doc comment above) — no second pass needed.
    section: lines.slice(start, end).join('\n').trimEnd(),
  };
}

/**
 * Recover the live rows from a FLATTENED ledger — one whose `## Open` /
 * `## Archive` headings were written as ordinary paragraphs, so a
 * `text/markdown` export carries no heading markers at all.
 *
 * **Why recover rather than refuse, and why NOT the whole body.** Three
 * outcomes were available and two of them are silent failures of opposite
 * sign. Refusing reads the doc as EMPTY: poverty-graduation's 15 open rows —
 * including the design author's hold on the work order and the solicitation —
 * simply do not reach Phase 1, and ace#1201 exists precisely to stop a
 * pre-existing question going unreconciled. Falling back to the WHOLE body
 * reads the doc as all-open: the flattened ledger's `Archive` label is an
 * ordinary paragraph too, so resolved history would be inlined as live
 * questions and Phase 1 would re-litigate settled decisions — the harm
 * ace#1487 and the two-section shape were built to prevent, and the one
 * invariant this module enforces structurally rather than by asking the
 * reader to stop.
 *
 * So the recovery is DELIMITED, and it ends at whichever comes first:
 *
 *   (a) a bare `Archive` label — the only other section the canonical write
 *       shape defines, and the one that must never ride along. Checked
 *       unconditionally so an EMPTY `Open` section still terminates; and
 *   (b) once the rows have started, the first line that is neither a list
 *       item, a wrapped continuation, nor blank. In a flattened doc every row
 *       is a bullet, so a bare paragraph after them is another section label
 *       whatever it is called. Requiring a row first keeps a prose note
 *       between `Open` and its rows from cutting the section short.
 *
 * This is a DEGRADED read and its status says so: `flattened-headings`, never
 * `ok`. The repair is to rewrite the doc in the two-section shape — a re-read
 * cannot help, which is the loop ace#2367 was filed against.
 */
function recoverFlattenedOpenSection(
  lines: string[],
  bareOpen: number,
): OpenQuestionsSectionOutcome {
  let end = lines.length;
  let sawRow = false;
  for (let i = bareOpen + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (BARE_ARCHIVE_LINE.test(line.trim())) {
      end = i;
      break;
    }
    if (LIST_ITEM.test(line)) {
      sawRow = true;
      continue;
    }
    if (sawRow && line.trim().length > 0 && !CONTINUATION.test(line)) {
      end = i;
      break;
    }
  }

  return {
    status: 'flattened-headings',
    section: lines.slice(bareOpen, end).join('\n').trimEnd(),
    reason:
      'DEGRADED READ. The durable open-questions doc has NO headings at all — "Open" and ' +
      '"Archive" are ordinary paragraphs — so it was flattened by a plain-text write, not by ' +
      'the export. Re-reading it will return the same bytes, so do not: the live rows below ' +
      'were recovered from the bare "Open" label and delimited at the bare "Archive" label, ' +
      'so archived rows are still excluded. Inline them, and say at the Phase 1→2 pause that ' +
      'this ledger was read in degraded form. REPAIR IT: rewrite the doc in the two-section ' +
      '`## Open` / `## Archive` shape via `drive_create_doc_from_markdown` (find-or-create ' +
      'keeps the file id), checking the content with `checkOpenQuestionsWriteShape` first ' +
      '(skills/idea-to-pdd/SKILL.md § The durable open-questions doc; ' +
      'dimagi-internal/ace#2367).',
  };
}

/* ------------------------------------------------------------------------- *
 * The WRITE-SHAPE half: a writer cannot publish what the reader would refuse.
 * ------------------------------------------------------------------------- */

export interface OpenQuestionsWriteCheck {
  /** True iff this content reads back `ok` through `extractOpenSection`. */
  ok: boolean;
  /** One sentence naming what is wrong, pasteable into a halt. */
  reason: string;
}

/**
 * Check content BEFORE it is written to the durable `open-questions.md`.
 *
 * ace#2367's parser half recovers a flattened ledger; nothing stopped one
 * being written. The flattening came from a turn that read the doc back as
 * `text/plain` — bare labels, run-on rows — and wrote THAT text out again,
 * laundering the headings away with no boundary to notice. Every writer
 * (`skills/idea-to-pdd`, `skills/inbox-triage` step 2g) runs this on the
 * markdown it is about to hand `drive_create_doc_from_markdown`, and does not
 * write on `ok: false`.
 *
 * It is deliberately the SAME function the reader uses, so the write cannot
 * pass a shape the read then refuses — a class-level preventer rather than a
 * second parser that drifts (`CLAUDE.md § Class-level preventers`).
 *
 * The content is pre-write markdown, so it is unescaped by construction and is
 * checked as `'text/markdown'`: a flattened draft therefore surfaces here as a
 * REFUSAL, not as the `flattened-headings` recovery, which exists only to
 * salvage a doc that is already broken in Drive.
 */
export function checkOpenQuestionsWriteShape(markdown: string): OpenQuestionsWriteCheck {
  const outcome = extractOpenSection(markdown, 'text/markdown');
  if (outcome.status === 'ok') {
    const spliced = findSplicedPreamble(markdown);
    if (spliced.length) {
      return {
        ok: false,
        reason:
          'REFUSED — do not write this. It reads back `ok`, but its structure shows a spliced ' +
          `rewrite a partner would see: ${spliced.join('; ')}. Rewrite the preamble (everything ` +
          'above `## Open`) as ONE whole block rather than editing it in place, with a single ' +
          '`Last updated by run` line (skills/idea-to-pdd/SKILL.md § The durable open-questions ' +
          'doc; dimagi-internal/ace#2499).',
      };
    }
    return {
      ok: true,
      reason:
        'The content reads back `ok` through `extractOpenSection`: it carries a real `## Open` ' +
        'heading and the next run can inline it.',
    };
  }
  return {
    ok: false,
    reason:
      'REFUSED — do not write this. `extractOpenSection` reads it back as ' +
      `\`${outcome.status}\`, so the next run's Phase 1 could not inline it: ${outcome.reason} ` +
      'Write the doc with real `## Open` / `## Archive` ATX headings ' +
      '(skills/idea-to-pdd/SKILL.md § The durable open-questions doc; ' +
      'dimagi-internal/ace#2367).',
  };
}

/** An H2 — the level a spliced sentence fragment lands at. */
const H2_LINE = /^ {0,3}##[ \t]+(\S.*?)[ \t]*$/;
const ARCHIVE_HEADING = /^ {0,3}##[ \t]+Archive[ \t]*$/i;
const LAST_UPDATED_STAMP = /last updated by run/i;

/**
 * Structural signs that a preamble rewrite was SPLICED rather than rewritten
 * (dimagi-internal/ace#2499). `extractOpenSection` cannot see any of these —
 * it only needs one real `## Open` — so the write gate asks separately.
 *
 * Measured on spark-facilitator revision 43: an edit cut at the `## Open`
 * inside the old preamble's `` `## Open` `` CODE SPAN, so the rest of that
 * sentence became an H2 (`## Open\` before raising questions of its own, …`)
 * and the old `Last updated by run 20260906-2233` line survived beneath the new
 * `…20260925-1536` one. Deliberately NOT "any H2 other than Open/Archive": a
 * third section (`## Settled — do not re-open`, the converted-gdoc fixture) is
 * a legal ledger, and refusing it would refuse a healthy doc to catch a
 * different defect. What a splice leaves is narrower:
 *
 *   - a GARBLED heading — an H2 that starts as `Open`/`Archive` but carries
 *     more text, or carries an unbalanced backtick (half of a code span);
 *   - the canonical heading TWICE;
 *   - more than one `Last updated by run` stamp in the preamble (a mention
 *     inside a row is a row's business, not a stamp).
 *
 * Returns one human-readable problem per defect; empty when the shape is clean.
 */
export function findSplicedPreamble(markdown: string): string[] {
  const lines = unescapeDriveMarkdown(markdown.replace(/\r\n?/g, '\n')).split('\n');
  const problems: string[] = [];

  for (const line of lines) {
    const m = H2_LINE.exec(line);
    if (!m || OPEN_HEADING.test(line) || ARCHIVE_HEADING.test(line)) continue;
    const text = m[1];
    const nearMiss = /^(open|archive)\b/i.test(text);
    const halfCodeSpan = (text.match(/`/g) ?? []).length % 2 === 1;
    if (nearMiss || halfCodeSpan) {
      const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      problems.push(`garbled heading \`## ${shown}\` (a sentence fragment rendered as a section heading)`);
    }
  }

  const openCount = lines.filter((l) => OPEN_HEADING.test(l)).length;
  if (openCount > 1) problems.push(`${openCount} \`## Open\` headings (exactly one is allowed)`);
  const archiveCount = lines.filter((l) => ARCHIVE_HEADING.test(l)).length;
  if (archiveCount > 1) problems.push(`${archiveCount} \`## Archive\` headings (at most one is allowed)`);

  const firstOpen = lines.findIndex((l) => OPEN_HEADING.test(l));
  const preamble = firstOpen === -1 ? lines : lines.slice(0, firstOpen);
  const stamps = preamble.filter((l) => LAST_UPDATED_STAMP.test(l)).length;
  if (stamps > 1) {
    problems.push(
      `${stamps} \`Last updated by run\` lines in the preamble, which disagree about which run last touched the ledger`,
    );
  }
  return problems;
}

/* ------------------------------------------------------------------------- *
 * The SELECTION half: which rows survive the cap, and which are named as
 * omitted (dimagi-internal/ace#2115).
 * ------------------------------------------------------------------------- */

/**
 * `classifyOpenQuestionsInline` says HOW MUCH may be inlined. It never said
 * WHICH rows, and the prose that filled the gap said "the most recent open
 * rows".
 *
 * Recency is the wrong sort key for this ledger. `## Open` is a live work
 * list a run only ever leaves rows on: a question is old precisely BECAUSE
 * nobody has answered it. Recency-first truncation therefore cuts the
 * long-standing blockers and keeps the freshly-raised detail.
 *
 * Measured on `spark-facilitator` (run `20260906-2233`, ledger revision 18 —
 * `## Open` is 15,187 chars / 21 rows, so the cap fires). Selecting
 * most-recent-first to 8,000 chars kept 9 rows and dropped 12, including:
 *
 *   - `cbf-smartphones-and-connectivity` — the ledger's ONLY row whose
 *     `blocking:` reads `Go/no-go. If the answer is no, the pilot cannot run
 *     as designed.`
 *   - `fiyp-media-assets` (Before Phase 3), `pilot-district-and-communities`
 *     (Before Phase 4), `pilot-record-instead-of-or-in-addition` and
 *     `app-runtime-default-language` (Before Phase 6) — all gating phases
 *     that very run was about to execute.
 *
 * ...while KEEPING `proposal-generator-boundary`, whose own `blocking:` field
 * says it is non-blocking for the pilot window. Every row of the oldest
 * cohort (`raised_by: 20260817-1610`) was cut, and that cohort holds both of
 * the opp's highest-severity questions.
 *
 * The rows already carry a machine-readable `blocking:` field. Nothing parsed
 * it. This does.
 *
 * The second half matters at least as much: the omission used to be SILENT.
 * ace#1201 exists to force Phase 1 to state, per pre-existing question,
 * whether this run resolves / carries forward / contradicts it — and a row
 * that never reaches Phase 1 is silently exempt from exactly that
 * reconciliation, with a PDD emitted either way and nothing to say so. So
 * `selectOpenRows` RETURNS the ids it could not fit; the caller carries them
 * forward explicitly rather than remembering to.
 */

/** Rank tiers, most urgent first. Lower ordinal wins. */
export type OpenRowTier =
  /** `blocking:` begins `Go/no-go` — the pilot may not be runnable at all. */
  | 'go-no-go'
  /** `blocking:` begins `Before Phase <N>` — ordered by ascending N. */
  | 'before-phase'
  /**
   * Everything else: `Before closeout`, `Before expansion`, `Post-pilot`,
   * `Non-blocking`, free prose, or no `blocking:` field at all.
   */
  | 'other';

export interface OpenQuestionRow {
  /** The row's `id:` field, or `null` when the row carries none. */
  id: string | null;
  /** The row verbatim, as it appeared in the `## Open` section. */
  text: string;
  /** The row's `blocking:` value, trimmed, or `null` when absent. */
  blocking: string | null;
  /** The row's `raised_by:` value, or `null` when absent. */
  raisedBy: string | null;
  tier: OpenRowTier;
  /** Parsed `<N>` from `Before Phase <N>`; `null` for every other tier. */
  phase: number | null;
}

export interface SelectOpenRowsInput {
  /** The `## Open` section, as returned by `extractOpenSection`. */
  section: string;
  /** Character budget for the whole inline block. Defaults to the cap. */
  capChars?: number;
}

export interface SelectOpenRowsResult {
  /**
   * The block to inline: the `## Open` heading and any preamble, then the
   * selected rows in RANK order (blockers first) — not ledger order, so the
   * most consequential questions sit at the top of what Phase 1 reads.
   */
  inlined: string;
  /** Ids of the rows that DID fit, in the same rank order. */
  includedIds: string[];
  /**
   * Ids of the rows that did NOT fit. Never silent: the caller must name
   * these in the inline block and at the Phase 1→2 pause (ace#1201).
   * A row with no parseable `id:` is reported as `<unidentified row N>`.
   */
  omittedIds: string[];
  /** True iff `omittedIds` is non-empty. */
  truncated: boolean;
  /**
   * True iff `rows.length > 0` and not one row's `blocking:` field parsed —
   * a corpus/parser MISMATCH, not a legitimate all-`other` tiering.
   *
   * dimagi-internal/ace#2396: no ACE writer currently emits `blocking:`. The
   * canonical row template (`skills/idea-to-pdd/SKILL.md` § The durable
   * open-questions doc) declares only `id` / `question` / `raised_by` /
   * `owner` / `answered_where`; real ledgers carry free-prose `**blocks:**`
   * instead. So on the real corpus this is `true`, every row lands in tier
   * `other`, and the ranking silently degrades to the within-tier recency
   * tiebreak applied to a single tier — exactly the cut ace#2115 was filed
   * and closed to eliminate. `reason` also states this in prose; this field
   * is the same fact as a boolean a caller (or a test) can branch on without
   * reading English.
   *
   * Deliberately NOT fatal and does NOT change `ok` / non-`ok` status —
   * Phase 1 depends on this path, and a hard failure here would block every
   * run on every opp whose ledger uses `blocks:`, which, on the evidence, is
   * all of them. Which field name and value vocabulary the ledger should
   * standardise on, and updating the writers (`skills/idea-to-pdd`,
   * `skills/inbox-triage`) to emit it, is a still-open design decision this
   * flag does not make — it only makes the degradation loud instead of
   * silent.
   */
  rankingFieldAbsent: boolean;
  /** One sentence, pasteable into the Phase 1→2 pause summary. */
  reason: string;
}

/** A row starts at a `- **id:**` bullet and runs to the next one. */
const ROW_START = /^\s*[-*]\s+\*\*id:\*\*/;
/** Drive's markdown export escapes `_`, so tolerate `raised\_by` as well. */
const FIELD_ID = /\*\*id:\*\*\s*([^\s*]+)/;
const FIELD_RAISED_BY = /\*\*raised\\?_by:\*\*\s*([^\s*]+)/;
/** `blocking:` runs to the next `**field:**` marker or the end of the row. */
const FIELD_BLOCKING = /\*\*blocking:\*\*\s*([\s\S]*?)(?=\*\*[A-Za-z\\_]+:\*\*|$)/;
const BEFORE_PHASE = /^before\s+phase\s+(\d+)/i;
const GO_NO_GO = /^go\s*\/?\s*no[-\s]?go/i;

const TIER_ORDINAL: Record<OpenRowTier, number> = {
  'go-no-go': 0,
  'before-phase': 1,
  other: 2,
};

function classifyBlocking(blocking: string | null): { tier: OpenRowTier; phase: number | null } {
  if (!blocking) return { tier: 'other', phase: null };
  const value = blocking.trim();
  if (GO_NO_GO.test(value)) return { tier: 'go-no-go', phase: null };
  const phaseMatch = BEFORE_PHASE.exec(value);
  if (phaseMatch) return { tier: 'before-phase', phase: Number(phaseMatch[1]) };
  return { tier: 'other', phase: null };
}

/**
 * Split the `## Open` section into its preamble and its rows.
 *
 * Pure. The preamble is everything before the first `- **id:**` bullet (the
 * heading, and any note the ledger carries above its rows); it is ALWAYS
 * inlined and always counts against the budget.
 */
export function parseOpenRows(section: string): { preamble: string; rows: OpenQuestionRow[] } {
  const lines = section.replace(/\r\n?/g, '\n').split('\n');
  const firstRow = lines.findIndex((line) => ROW_START.test(line));
  if (firstRow === -1) {
    return { preamble: section.trimEnd(), rows: [] };
  }

  const preamble = lines.slice(0, firstRow).join('\n').trimEnd();

  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines.slice(firstRow)) {
    if (ROW_START.test(line) && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  const rows = chunks.map((chunk): OpenQuestionRow => {
    const text = chunk.replace(/\s+$/, '');
    const blocking = FIELD_BLOCKING.exec(text)?.[1]?.trim() ?? null;
    const { tier, phase } = classifyBlocking(blocking);
    return {
      id: FIELD_ID.exec(text)?.[1] ?? null,
      text,
      blocking: blocking && blocking.length > 0 ? blocking : null,
      raisedBy: FIELD_RAISED_BY.exec(text)?.[1] ?? null,
      tier,
      phase,
    };
  });

  return { preamble, rows };
}

/**
 * Rank the `## Open` rows and fill to `capChars`, returning the ids that did
 * not fit.
 *
 * Ranking, in order:
 *   1. `blocking:` beginning `Go/no-go`;
 *   2. `Before Phase <N>`, by ASCENDING N (a Phase 3 blocker outranks a
 *      Phase 8 one — the run reaches it sooner);
 *   3. everything else (`Before closeout`, `Before expansion`, `Post-pilot`,
 *      `Non-blocking`, free prose, or no `blocking:` at all);
 *   4. recency (`raised_by`, descending) ONLY as the within-tier tiebreak,
 *      then the ledger's own order, so the result is total and stable.
 *
 * The fill is STRICT: rows are taken in rank order and the fill STOPS at the
 * first row that does not fit, rather than skipping it to squeeze smaller
 * rows in behind it. Skipping would re-open the exact inversion this exists
 * to close — a short `Non-blocking` row displacing a long `Before Phase 3`
 * one — and the cost of stopping is only unused budget, which is the
 * cheaper failure. A ledger whose first ranked row alone exceeds the cap
 * inlines nothing and reports every row as omitted; that is loud, and it is
 * the signal to prune (`## Archive`), not a case to work around.
 *
 * Under the cap this is a no-op that returns the section unchanged with an
 * empty `omittedIds`, so a caller can run it unconditionally.
 */
export function selectOpenRows(input: SelectOpenRowsInput): SelectOpenRowsResult {
  const capChars = input.capChars ?? OPEN_QUESTIONS_INLINE_CAP_CHARS;
  const { preamble, rows } = parseOpenRows(input.section);

  const label = (row: OpenQuestionRow, index: number) =>
    row.id ?? `<unidentified row ${index + 1}>`;

  if (rows.length === 0) {
    return {
      inlined: preamble,
      includedIds: [],
      omittedIds: [],
      truncated: false,
      rankingFieldAbsent: false,
      reason:
        'The durable open-questions ledger has no `## Open` rows to inline: the section is ' +
        'passed as-is (dimagi-internal/ace#2115).',
    };
  }

  // dimagi-internal/ace#2396: true when NOT ONE row's `blocking:` field
  // parsed — a corpus/parser mismatch, since no ACE writer currently emits
  // that field. See the `rankingFieldAbsent` doc comment above.
  const rankingFieldAbsent = rows.every((row) => row.blocking === null);

  const ranked = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const tier = TIER_ORDINAL[a.row.tier] - TIER_ORDINAL[b.row.tier];
      if (tier !== 0) return tier;
      if (a.row.tier === 'before-phase') {
        const phase = (a.row.phase ?? Number.MAX_SAFE_INTEGER) - (b.row.phase ?? Number.MAX_SAFE_INTEGER);
        if (phase !== 0) return phase;
      }
      // Recency is the TIEBREAK, never the sort key: newest first.
      const recency = (b.row.raisedBy ?? '').localeCompare(a.row.raisedBy ?? '');
      if (recency !== 0) return recency;
      return a.index - b.index;
    });

  const separator = '\n\n';
  let used = preamble.length;
  const included: Array<{ row: OpenQuestionRow; index: number }> = [];
  const omitted: string[] = [];

  let full = false;
  for (const entry of ranked) {
    if (full) {
      omitted.push(label(entry.row, entry.index));
      continue;
    }
    const cost =
      entry.row.text.length +
      (included.length > 0 || preamble.length > 0 ? separator.length : 0);
    if (used + cost <= capChars) {
      included.push(entry);
      used += cost;
    } else {
      // STRICT stop — see the doc comment. Everything below this row is
      // omitted too, even if it would have fit.
      full = true;
      omitted.push(label(entry.row, entry.index));
    }
  }

  const parts = [preamble, ...included.map((entry) => entry.row.text)].filter(
    (part) => part.length > 0,
  );

  const includedIds = included.map((entry) => label(entry.row, entry.index));

  const reason = (() => {
    if (omitted.length === 0) {
      return (
        `All ${rows.length} \`## Open\` rows fit within the ${capChars}-char inline cap; ` +
        'none omitted (dimagi-internal/ace#2115).'
      );
    }
    if (rankingFieldAbsent) {
      // dimagi-internal/ace#2396: tell the truth. Every row parsed with
      // `blocking: null`, so this is NOT a ranked cut — say so instead of
      // claiming a ranking that never happened, which is how the
      // degradation stayed invisible on the real corpus.
      return (
        `None of the ${rows.length} \`## Open\` rows carry a \`blocking:\` field — no ACE ` +
        'writer currently emits it (dimagi-internal/ace#2396), so this is NOT a ranked cut: ' +
        'every row landed in tier `other` and the fill fell back to the within-tier recency ' +
        `tiebreak only. Filled to the ${capChars}-char inline cap: ${includedIds.length} ` +
        `inlined, ${omitted.length} NOT inlined and therefore NOT reconciled by this run — ` +
        `${omitted.join(', ')}. Name them in the inline block and at the Phase 1→2 pause, and ` +
        'read them from the file_id if a phase needs one (dimagi-internal/ace#1201).'
      );
    }
    return (
      `Ranked the ${rows.length} \`## Open\` rows by \`blocking:\` (Go/no-go, then Before ` +
      'Phase N ascending, then the rest; recency only as the within-tier tiebreak) and filled ' +
      `to the ${capChars}-char inline cap: ${includedIds.length} inlined, ${omitted.length} ` +
      `NOT inlined and therefore NOT reconciled by this run — ${omitted.join(', ')}. Name ` +
      'them in the inline block and at the Phase 1→2 pause, and read them from the file_id ' +
      'if a phase needs one (dimagi-internal/ace#1201, ace#2115).'
    );
  })();

  return {
    inlined: parts.join(separator),
    includedIds,
    omittedIds: omitted,
    truncated: omitted.length > 0,
    rankingFieldAbsent,
    reason,
  };
}
