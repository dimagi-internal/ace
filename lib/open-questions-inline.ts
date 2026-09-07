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

export type OpenQuestionsSectionOutcome =
  /** The `## Open` section, verbatim (minus Drive's escaping), `## Archive` excluded. */
  | { status: 'ok'; section: string }
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
 */
export function extractOpenSection(text: string): OpenQuestionsSectionOutcome {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => OPEN_HEADING.test(line));

  if (start === -1) {
    const hasHeadings = lines.some((line) => ANY_ATX_HEADING.test(line));
    if (!hasHeadings && lines.some((line) => BARE_OPEN_LINE.test(line.trim()))) {
      return {
        status: 'needs-markdown-export',
        reason:
          'The read carries no ATX headings but does carry a bare "Open" line: this is a ' +
          'text/plain export of a CONVERTED Google Doc, so the `##` markers are stripped and ' +
          'any pipe table in it has been flattened to one cell per line. Re-read the file with ' +
          "`drive_read_file(..., exportAs: 'text/markdown')` — do NOT parse this text.",
      };
    }
    return {
      status: 'absent',
      reason:
        'No `## Open` heading in the durable open-questions doc. Nothing is inlined at Phase 1; ' +
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
    section: unescapeDriveMarkdown(lines.slice(start, end).join('\n').trimEnd()),
  };
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
      reason:
        'The durable open-questions ledger has no `## Open` rows to inline: the section is ' +
        'passed as-is (dimagi-internal/ace#2115).',
    };
  }

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

  const reason =
    omitted.length === 0
      ? `All ${rows.length} \`## Open\` rows fit within the ${capChars}-char inline cap; ` +
        'none omitted (dimagi-internal/ace#2115).'
      : `Ranked the ${rows.length} \`## Open\` rows by \`blocking:\` (Go/no-go, then Before ` +
        'Phase N ascending, then the rest; recency only as the within-tier tiebreak) and filled ' +
        `to the ${capChars}-char inline cap: ${includedIds.length} inlined, ${omitted.length} ` +
        `NOT inlined and therefore NOT reconciled by this run — ${omitted.join(', ')}. Name ` +
        'them in the inline block and at the Phase 1→2 pause, and read them from the file_id ' +
        'if a phase needs one (dimagi-internal/ace#1201, ace#2115).';

  return {
    inlined: parts.join(separator),
    includedIds,
    omittedIds: omitted,
    truncated: omitted.length > 0,
    reason,
  };
}
