/**
 * Find `**bold**` spans in a Google Doc and map them to absolute doc indices.
 *
 * ## Why this exists (ace#2335)
 *
 * `pdd-to-work-order` renders the Work Order by copying a styled Google Docs
 * template and substituting prose tokens with `replaceAllText`. That API is
 * plain-text substitution — it carries no character formatting — so the skill
 * has carried this instruction since the render path landed:
 *
 * > **Bold rendering is a known pipeline gap.** … there is no markdown-bold →
 * > Google-Docs-bold finalizer. **Do NOT emit `**asterisks**` in prose
 * > tokens** — they render as literal asterisks in the Google Doc. … (The
 * > writing-style guide's bold rules apply once a docs-finalize-bold
 * > post-processor ships — *not yet built*; tracking as a backlog item.)
 *
 * So `references/writing-style.md` specifies bold-use rules for a contractual
 * document, and the renderer could not honour them: every work order shipped
 * with its emphasis flattened, and `pdd-to-work-order-eval § writing_style`
 * took a guaranteed strike for it. This module is the missing half.
 *
 * ## Why the logic is here and not in the MCP server
 *
 * The hard part is arithmetic, not I/O: Docs indices are absolute over the
 * whole document, a paragraph's text is split across an arbitrary number of
 * `textRun` elements, and deleting the marker characters shifts every later
 * index. That is worth testing against synthetic documents rather than against
 * a live Doc, so the server keeps only the batchUpdate calls.
 */

/** The subset of the Docs API document shape this module reads. */
export interface DocsTextRun {
  content?: string | null;
}
export interface DocsParagraphElement {
  startIndex?: number | null;
  endIndex?: number | null;
  textRun?: DocsTextRun | null;
}
export interface DocsParagraph {
  elements?: DocsParagraphElement[] | null;
}
export interface DocsTableCell {
  content?: DocsStructuralElement[] | null;
}
export interface DocsTableRow {
  tableCells?: DocsTableCell[] | null;
}
export interface DocsTable {
  tableRows?: DocsTableRow[] | null;
}
export interface DocsStructuralElement {
  startIndex?: number | null;
  endIndex?: number | null;
  paragraph?: DocsParagraph | null;
  table?: DocsTable | null;
}

/**
 * One `**bold**` occurrence, in absolute document indices.
 *
 * ```
 *   … some **emphasised** text …
 *          ^      ^         ^  ^
 *          |      |         |  closeEnd   (exclusive)
 *          |      |         innerEnd      (exclusive)
 *          |      innerStart
 *          openStart
 * ```
 */
export interface BoldSpan {
  /** Index of the first `*` of the opening marker. */
  openStart: number;
  /** Index of the first character of the emphasised text. */
  innerStart: number;
  /** Exclusive end of the emphasised text = index of the closing marker's first `*`. */
  innerEnd: number;
  /** Exclusive end of the closing marker. */
  closeEnd: number;
  /** The emphasised text itself, for diagnostics. */
  text: string;
}

const MARKER = '**';

/**
 * Walk a document body and return every `**bold**` span, ordered
 * **last-to-first** so a caller can mutate the document without invalidating
 * the spans it has not processed yet.
 *
 * Table cells are walked recursively. The Work Order's §2 scope blocks, §4.2
 * verified-unit criteria and §8.1 permissions all live inside table cells, so a
 * top-level-only walk (which is all `docs_finalize_bullets` does) would miss
 * most of the document's prose.
 */
export function findBoldSpans(bodyContent: readonly DocsStructuralElement[]): BoldSpan[] {
  const spans: BoldSpan[] = [];
  for (const paragraph of collectParagraphs(bodyContent)) {
    spans.push(...spansInParagraph(paragraph));
  }
  // Descending by position. Deleting the markers of a later span cannot move an
  // earlier one, so a caller processing in this order never recomputes indices.
  spans.sort((a, b) => b.openStart - a.openStart);
  return spans;
}

/** Depth-first collection of every paragraph, including inside nested tables. */
function collectParagraphs(
  bodyContent: readonly DocsStructuralElement[],
): DocsParagraph[] {
  const out: DocsParagraph[] = [];
  for (const el of bodyContent) {
    if (el.paragraph) out.push(el.paragraph);
    if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          out.push(...collectParagraphs(cell.content ?? []));
        }
      }
    }
  }
  return out;
}

/**
 * Find the bold spans within ONE paragraph.
 *
 * Scoped per paragraph deliberately: a stray unmatched `**` must not pair with
 * one several paragraphs away and bold everything in between. Markdown itself
 * does not allow emphasis to straddle a paragraph break.
 */
function spansInParagraph(paragraph: DocsParagraph): BoldSpan[] {
  // Flatten the paragraph's text runs into one string plus a parallel array
  // giving each character's absolute document index. A run's own startIndex is
  // authoritative — runs are not guaranteed contiguous (an inline object or a
  // footnote reference sits between them), so deriving indices by accumulating
  // lengths would silently drift.
  let text = '';
  const indexOf: number[] = [];
  for (const el of paragraph.elements ?? []) {
    const content = el.textRun?.content;
    if (typeof content !== 'string' || content.length === 0) continue;
    const base = el.startIndex;
    if (typeof base !== 'number') continue;
    for (let i = 0; i < content.length; i++) {
      text += content[i];
      indexOf.push(base + i);
    }
  }
  if (text.length === 0) return [];

  const spans: BoldSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(MARKER, cursor);
    if (open === -1) break;
    const close = text.indexOf(MARKER, open + MARKER.length);
    if (close === -1) break;

    const inner = text.slice(open + MARKER.length, close);

    // `****` (empty) and a run that is only asterisks are not emphasis. Leaving
    // them alone is safer than deleting characters an author may have meant.
    if (inner.length === 0 || /^\*+$/.test(inner)) {
      cursor = open + MARKER.length;
      continue;
    }
    // Emphasis does not span a line break inside a paragraph. U+000B is in the
    // class because that is how Google Docs encodes a SOFT line break
    // (Shift+Enter) — it stays inside one paragraph, so a `\n`-only check would
    // miss it and bold across the break. Written as a \u escape, never a raw
    // byte: `test/no-control-bytes.test.ts` rejects a literal 0x0b in a tracked
    // .ts source, and it reads TRACKED files — so a full local suite run before
    // the first `git add` cannot catch it. CI did.
    if (/[\n\r\u000b\f]/.test(inner)) {
      cursor = open + MARKER.length;
      continue;
    }

    spans.push({
      openStart: indexOf[open],
      innerStart: indexOf[open + MARKER.length],
      innerEnd: indexOf[close],
      closeEnd: indexOf[close + MARKER.length - 1] + 1,
      text: inner,
    });
    cursor = close + MARKER.length;
  }
  return spans;
}

/**
 * The batchUpdate requests that turn one span into real Google Docs bold.
 *
 * **Order is load-bearing.** Docs applies the requests in a batch
 * sequentially, each seeing the previous one's result:
 *
 * 1. `updateTextStyle` over the inner range, using pre-deletion indices — valid
 *    because nothing has been deleted yet.
 * 2. delete the CLOSING marker (the higher index), which cannot disturb the
 *    style already applied to the text before it.
 * 3. delete the OPENING marker, which shifts the styled text left by two; the
 *    style travels with the characters.
 *
 * Reversing 2 and 3 would leave the closing-marker range pointing two
 * characters past where the text now ends.
 */
export function boldSpanRequests(span: BoldSpan): unknown[] {
  return [
    {
      updateTextStyle: {
        range: { startIndex: span.innerStart, endIndex: span.innerEnd },
        textStyle: { bold: true },
        fields: 'bold',
      },
    },
    {
      deleteContentRange: {
        range: { startIndex: span.innerEnd, endIndex: span.closeEnd },
      },
    },
    {
      deleteContentRange: {
        range: { startIndex: span.openStart, endIndex: span.innerStart },
      },
    },
  ];
}
