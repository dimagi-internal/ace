/**
 * Redact assessment answer keys out of a file before it is uploaded into a
 * worker-facing OCS RAG collection.
 *
 * WHY THIS EXISTS (dimagi-internal/ace#2869): `ocs-agent-setup` § Step 5
 * indexes the Phase 3 app summaries into the per-run FLW chatbot's collection.
 * `pdd-to-learn-app_summary.md` records the BUILT answer key for every scored
 * Learn form in its `## Build notes` (Step 7a's assessment self-check, which
 * runs `checkAnswerKeyPattern` over the keys). Indexed verbatim, a worker can
 * ask the support chatbot for the answers to the assessments, including the
 * final certification Connect uses to unlock paid Deliver work. Observed on
 * `smallholder-seasonal/20261012-1549`, where the line read:
 *
 *     ... Built keys (unchanged by the repairs): m01 a,a,d,a,b; m02 d,b,b,b,c;
 *     ... m12 a,b,c,b,b; final d,a,d,b,c,a,a,c,d,c,b,c.
 *
 * Same class as ace#1018 (the deep-QA instrument indexed into the bot it
 * grades): an artifact that must not be retrievable by the audience it gates
 * reached the corpus because the recipe said "every file in the folder".
 *
 * The summary is right to carry the keys: the build team and the
 * `-eval` rubrics read them. What is wrong is the INDEXED copy, so the fix is
 * a redaction of the downloaded file, not a change to what the producer writes.
 *
 * Four rewrites, in order:
 *
 * 1. **Internal sections are dropped whole.** `## Build notes` (both the Learn
 *    and Deliver summaries end with it, and it is build-team bookkeeping that
 *    answers no "where do I find X" question), plus any heading naming an
 *    answer key or the assessment self-check, up to the next heading of the
 *    same or higher level.
 * 2. **Tables keep their shape.** A column whose header names the key
 *    (`Correct`, `Answer`, `Key`, `Correct option`, `Expected answer`) has its
 *    body cells replaced, and any other cell carrying a key run or a score
 *    calculate literal is replaced too. Deleting the row would break the
 *    table; deleting the line would break every row below it.
 * 3. **Prose lines carrying a key are replaced** with a one-line placeholder,
 *    keeping the indent and list marker. A key is a run of three or more
 *    option letters (`a,a,d,a,b`), a `Built keys` / `answer key:` label, a
 *    per-question `q3 = b` pair, or a `qN_score` calculate comparing against a
 *    literal (`if(/data/q3 = 'plant_after_rains', 1, 0)` IS the key, since
 *    CommCare has no correct-option primitive).
 * 4. **Correct-answer markers are removed** from option lines (`(correct)`,
 *    `✓`, `<- correct`), keeping the option text.
 *
 * Pure string in / string out: no I/O. CLI wrapper:
 * `scripts/redact-kb-answer-keys.ts`.
 */

export type RedactionKind =
  | 'section'
  | 'table-column'
  | 'table-cell'
  | 'line'
  | 'correct-marker';

export interface Redaction {
  kind: RedactionKind;
  /** 1-based line number in the INPUT. */
  line: number;
  /** The heading text for a dropped section; otherwise the rule that fired. */
  detail: string;
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

export const REDACTED_LINE = '[Assessment answer key withheld from the chatbot knowledge base.]';
export const REDACTED_CELL = '_withheld_';

/** Headings whose whole section is internal and never indexed. */
const INTERNAL_SECTION = /^(?:build notes|assessment self-check|answer keys?|built keys?|assessment (?:answer )?keys?)\b/i;

/** Table header cells that ARE the answer key column. */
const KEY_COLUMN =
  /^(?:correct(?: answer| option| choice| letter)?(?: \(.*\))?|answer[ -]key|built[ -]key|key letter|right answer)$/i;

/**
 * Three or more single option letters separated by commas, e.g. `a,a,d,a,b`
 * or `d, b, b`. The look-arounds keep it off ordinary words.
 */
const KEY_RUN = /(?<![A-Za-z0-9_])[a-fA-F](?:\s*,\s*[a-fA-F]){2,}(?![A-Za-z0-9_])/;

/** `Built keys`, `answer key:`, `answer keys (` — a label introducing a key. */
const KEY_LABEL = /\bbuilt[ -]keys?\b|\banswer[ -]keys?\s*[:=(]/i;

/** `q3 = b`, `Q3: c`, `q12 -> a` — per-question key pairs. */
const QUESTION_PAIR = /\bq\d+\s*(?:=|:|->|→)\s*[a-fA-F](?![A-Za-z0-9_])/i;

/** A `qN_score` / `*_score` calculate comparing an answer to a literal. */
const SCORE_LITERAL = /_score\b[^\n]*?=\s*['"][^'"\n]+['"]/i;

/** Markers that flag the correct option on an option line. */
const CORRECT_MARKER = /\s*(?:\((?:correct(?: answer)?|answer|key)\)|\*\*\(correct\)\*\*|(?:<-|←)\s*correct\b|[✓✔])/gi;

function carriesKey(s: string): string | null {
  if (KEY_LABEL.test(s)) return 'key-label';
  if (KEY_RUN.test(s)) return 'key-run';
  if (QUESTION_PAIR.test(s)) return 'question-pair';
  if (SCORE_LITERAL.test(s)) return 'score-literal';
  return null;
}

/**
 * A markdown heading. Drive's `text/markdown` export of a Doc that was itself
 * written FROM markdown escapes the hashes (`\\#\\# Build notes`) — that is the
 * shape the live `pdd-to-learn-app_summary.md` export has — so both forms count.
 */
const HEADING = /^((?:\\?#){1,6})\s+(.*?)\s*(?:\\?#)*\s*$/;

function headingLevel(hashes: string): number {
  return hashes.replace(/\\/g, '').length;
}

function stripFormatting(cell: string): string {
  return cell.replace(/\\(?=[^A-Za-z0-9\s])/g, '').replace(/[*_`]/g, '').trim();
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|');
}

function joinRow(cells: string[]): string {
  return `|${cells.join('|')}|`;
}

/**
 * Remove every assessment answer key from a markdown document while keeping
 * the rest of it (structure, prose, unaffected table cells) intact.
 */
export function redactAnswerKeys(markdown: string): RedactResult {
  const lines = markdown.split('\n');
  const redactions: Redaction[] = [];
  const out: string[] = [];

  // Leave YAML frontmatter alone: it carries ids, not keys, and a rewrite
  // there could corrupt the block.
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      out.push(...lines.slice(0, close + 1));
      i = close + 1;
    }
  }

  let skipLevel = 0; // >0 while inside a dropped section of this heading level
  let inFence = false;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const h = inFence ? null : HEADING.exec(line);
    if (h) {
      const level = headingLevel(h[1]);
      if (skipLevel > 0 && level <= skipLevel) skipLevel = 0;
      if (skipLevel === 0 && INTERNAL_SECTION.test(stripFormatting(h[2]))) {
        skipLevel = level;
        redactions.push({ kind: 'section', line: i + 1, detail: stripFormatting(h[2]) });
        i++;
        continue;
      }
    }
    if (skipLevel > 0) {
      i++;
      continue;
    }

    // Table block: header, separator, body rows.
    if (
      !inFence &&
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])
    ) {
      const header = splitRow(line);
      const keyCols = new Set(
        header.map((c, idx) => (KEY_COLUMN.test(stripFormatting(c)) ? idx : -1)).filter((idx) => idx >= 0),
      );
      out.push(line, lines[i + 1]);
      for (const idx of keyCols) {
        redactions.push({ kind: 'table-column', line: i + 1, detail: stripFormatting(header[idx]) });
      }
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitRow(lines[i]).map((cell, idx) => {
          if (keyCols.has(idx) && cell.trim() !== '') return ` ${REDACTED_CELL} `;
          const rule = carriesKey(cell);
          if (rule) {
            redactions.push({ kind: 'table-cell', line: i + 1, detail: rule });
            return ` ${REDACTED_CELL} `;
          }
          const unmarked = cell.replace(CORRECT_MARKER, '');
          if (unmarked !== cell) {
            redactions.push({ kind: 'correct-marker', line: i + 1, detail: 'correct-marker' });
          }
          return unmarked;
        });
        out.push(joinRow(cells));
        i++;
      }
      continue;
    }

    const rule = carriesKey(line);
    if (rule) {
      const lead = /^(\s*(?:[-*+]|\d+[.)])?\s*)/.exec(line)?.[1] ?? '';
      out.push(`${lead}${REDACTED_LINE}`);
      redactions.push({ kind: 'line', line: i + 1, detail: rule });
      i++;
      continue;
    }

    const unmarked = line.replace(CORRECT_MARKER, '');
    if (unmarked !== line) {
      redactions.push({ kind: 'correct-marker', line: i + 1, detail: 'correct-marker' });
    }
    out.push(unmarked);
    i++;
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { text, redactions };
}

/**
 * Does any answer key survive in this text? The post-condition the CLI asserts
 * before an upload may proceed. Frontmatter is skipped for the same reason
 * `redactAnswerKeys` skips it.
 */
export function hasResidualAnswerKey(text: string): boolean {
  let body = text;
  if (body.startsWith('---\n')) {
    const close = body.indexOf('\n---', 4);
    if (close > 0) body = body.slice(close + 4);
  }
  return body.split('\n').some((l) => carriesKey(l) !== null || /\((?:correct(?: answer)?)\)|[✓✔]/i.test(l));
}
