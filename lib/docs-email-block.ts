/**
 * Insert Google Docs "email draft" blocks — the To / Cc / Bcc / Subject / Body
 * table that Docs renders with a Gmail icon in the margin, so a human clicks the
 * icon and gets a pre-filled Gmail draft.
 *
 * ## Provenance
 *
 * Ported from chrome-sales' `docs_insert_email_block` (mcp/google-drive-server.ts
 * there), which Eva's `email-macros` skill drives. The Docs API has no request
 * that inserts a building block by name; this builds the same 5x2 table with the
 * native block's styling constants, and Docs gives it the Gmail icon. Operator
 * observation, 2026-09-24: clicking the icon on these blocks opens a real draft.
 *
 * ## Why the logic is here and not in the MCP server
 *
 * Same reason as `docs-bold-spans.ts`: the hard part is index arithmetic. A table
 * insert shifts every later index, cells are addressed by absolute index, and a
 * block inserted at a heading boundary inherits the heading's 18pt style (a bug
 * Eva shipped once). Anchors let the caller say WHERE a block goes without doing
 * any of that arithmetic; this module turns anchors into request batches and is
 * tested against synthetic documents. The server keeps only the I/O.
 *
 * ## The anchor contract
 *
 * The caller writes a paragraph containing ONLY `@@EMAIL_<key>@@` (key:
 * `[A-Za-z0-9_-]+`) wherever a block should go, as Normal text — e.g. a blank
 * line either side in the markdown handed to `drive_create_doc_from_markdown`.
 * The block is inserted at the anchor paragraph's start, so its cells inherit
 * Normal text, and the anchor token is then deleted.
 */

import type { DocsStructuralElement } from './docs-bold-spans.js';

export interface EmailBlockFields {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Plain text; `\n` separates paragraphs. */
  body?: string;
}

export interface EmailBlockSpec extends EmailBlockFields {
  /** The `<key>` of the `@@EMAIL_<key>@@` anchor paragraph this block replaces. */
  anchor: string;
}

export interface EmailAnchor {
  key: string;
  /** The literal token, e.g. `@@EMAIL_acme@@`. */
  token: string;
  startIndex: number;
  endIndex: number;
  namedStyleType: string;
}

export const ANCHOR_KEY_RE = /^[A-Za-z0-9_-]+$/;
const ANCHOR_PARA_RE = /^@@EMAIL_([A-Za-z0-9_-]+)@@$/;

export function anchorToken(key: string): string {
  return `@@EMAIL_${key}@@`;
}

/** Paragraph style fields the anchor walk reads (a superset of docs-bold-spans' shape). */
interface StyledParagraph {
  elements?: { textRun?: { content?: string | null } | null }[] | null;
  paragraphStyle?: { namedStyleType?: string | null } | null;
}

/**
 * Every top-level `@@EMAIL_<key>@@` paragraph, ordered LAST-TO-FIRST so a caller
 * inserting tables in this order never invalidates an anchor it has not reached.
 *
 * Top-level only: a block inside a table cell is not something a person
 * building an outreach doc wants, and nesting would change the table lookup.
 */
export function findEmailAnchors(
  bodyContent: readonly DocsStructuralElement[],
): EmailAnchor[] {
  const out: EmailAnchor[] = [];
  for (const el of bodyContent) {
    const para = el.paragraph as StyledParagraph | null | undefined;
    if (!para || el.startIndex == null || el.endIndex == null) continue;
    const text = (para.elements ?? [])
      .map((e) => e.textRun?.content ?? '')
      .join('')
      .trim();
    const m = text.match(ANCHOR_PARA_RE);
    if (!m) continue;
    out.push({
      key: m[1],
      token: anchorToken(m[1]),
      startIndex: el.startIndex,
      endIndex: el.endIndex,
      namedStyleType: para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT',
    });
  }
  out.sort((a, b) => b.startIndex - a.startIndex);
  return out;
}

/**
 * Pair requested blocks with the anchors found in the document. Refuses rather
 * than guesses: an unknown key, a duplicate key, or an anchor styled as a
 * heading (its cells would inherit the heading font) is an error the caller
 * fixes in the markdown.
 */
export function planEmailBlocks(
  anchors: readonly EmailAnchor[],
  blocks: readonly EmailBlockSpec[],
): { plan: { anchor: EmailAnchor; fields: EmailBlockFields }[]; unusedAnchors: string[] } {
  const byKey = new Map<string, EmailAnchor[]>();
  for (const a of anchors) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a]);

  const problems: string[] = [];
  const seen = new Set<string>();
  const plan: { anchor: EmailAnchor; fields: EmailBlockFields }[] = [];
  for (const { anchor: key, ...fields } of blocks) {
    if (!ANCHOR_KEY_RE.test(key)) {
      problems.push(`anchor key "${key}" must match ${ANCHOR_KEY_RE}`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`anchor key "${key}" is requested twice`);
      continue;
    }
    seen.add(key);
    const found = byKey.get(key) ?? [];
    if (found.length === 0) {
      problems.push(`no paragraph containing only ${anchorToken(key)} in the document`);
      continue;
    }
    if (found.length > 1) {
      problems.push(`${anchorToken(key)} appears ${found.length} times; each anchor must be unique`);
      continue;
    }
    if (found[0].namedStyleType !== 'NORMAL_TEXT') {
      problems.push(
        `${anchorToken(key)} is styled ${found[0].namedStyleType}; put it on its own Normal-text ` +
          'line (blank line either side), or the block inherits the heading font',
      );
      continue;
    }
    plan.push({ anchor: found[0], fields });
  }
  if (problems.length > 0) throw new Error(`email blocks refused:\n- ${problems.join('\n- ')}`);

  plan.sort((a, b) => b.anchor.startIndex - a.anchor.startIndex);
  const unusedAnchors = anchors.filter((a) => !seen.has(a.key)).map((a) => a.token);
  return { plan, unusedAnchors };
}

/** The request that creates the empty table at the anchor. */
export function insertEmailTableRequest(index: number): Record<string, unknown> {
  return { insertTable: { location: { index }, rows: 5, columns: 2 } };
}

interface CellShape {
  content?: { startIndex?: number | null; endIndex?: number | null }[] | null;
}
interface TableShape {
  tableRows?: { tableCells?: CellShape[] | null }[] | null;
}

/** The first top-level table starting at or after `index` — the one just inserted. */
export function findTableAtOrAfter(
  bodyContent: readonly DocsStructuralElement[],
  index: number,
): { startIndex: number; table: TableShape } {
  const el = bodyContent.find((e) => e.table && (e.startIndex ?? -1) >= index);
  if (!el?.table || el.startIndex == null) {
    throw new Error(`no table found at or after index ${index} after insertTable`);
  }
  return { startIndex: el.startIndex, table: el.table as TableShape };
}

function cellParaStart(table: TableShape, row: number, col: number): number {
  const start = table.tableRows?.[row]?.tableCells?.[col]?.content?.[0]?.startIndex;
  if (start == null) throw new Error(`email block table has no cell (${row},${col})`);
  return start;
}
function cellParaEnd(table: TableShape, row: number, col: number): number {
  const end = table.tableRows?.[row]?.tableCells?.[col]?.content?.[0]?.endIndex;
  if (end == null) throw new Error(`email block table has no cell (${row},${col})`);
  return end;
}

// Styling constants matched from the native @email building block (via chrome-sales).
const LABEL_BG = { color: { rgbColor: { red: 0.94509804, green: 0.9529412, blue: 0.95686275 } } };
const BORDER_COLOR = { color: { rgbColor: { red: 0.7411765, green: 0.75686276, blue: 0.7764706 } } };
const border = (magnitude: number) => ({
  color: BORDER_COLOR,
  width: { magnitude, unit: 'PT' },
  dashStyle: 'SOLID',
});
const pad = (magnitude: number) => ({ magnitude, unit: 'PT' });
export const EMAIL_LABELS = ['To', 'Cc', 'Bcc', 'Subject'] as const;

/**
 * Pass 2: column width, merged body row, cell styling, and the four label texts.
 * Label inserts go last and in reverse row order, so earlier requests in the
 * batch keep valid indices.
 */
export function emailBlockStyleRequests(tableStartIndex: number, table: TableShape): Record<string, unknown>[] {
  const tableStartLocation = { index: tableStartIndex };
  const requests: Record<string, unknown>[] = [
    {
      updateTableColumnProperties: {
        tableStartLocation,
        columnIndices: [0],
        tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: 67.35, unit: 'PT' } },
        fields: 'widthType,width',
      },
    },
    {
      mergeTableCells: {
        tableRange: {
          tableCellLocation: { tableStartLocation, rowIndex: 4, columnIndex: 0 },
          rowSpan: 1,
          columnSpan: 2,
        },
      },
    },
  ];

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 2; col++) {
      const isLabel = col === 0 && row < 4;
      const isBody = row === 4 && col === 0;
      requests.push({
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: { tableStartLocation, rowIndex: row, columnIndex: col },
            rowSpan: 1,
            columnSpan: 1,
          },
          tableCellStyle: {
            backgroundColor: isLabel ? LABEL_BG : {},
            borderTop: border(1),
            borderBottom: border(1),
            borderLeft: border(col === 0 ? 0 : 1),
            borderRight: border(col === 0 && row < 4 ? 1 : 0),
            paddingLeft: pad(7.2),
            paddingRight: pad(7.2),
            paddingTop: pad(isBody ? 12 : 7.2),
            paddingBottom: pad(7.2),
            contentAlignment: 'TOP',
          },
          fields:
            'backgroundColor,borderTop,borderBottom,borderLeft,borderRight,paddingLeft,paddingRight,paddingTop,paddingBottom,contentAlignment',
        },
      });
      if (isLabel) {
        const p = cellParaStart(table, row, 0);
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: p, endIndex: p + 1 },
            paragraphStyle: {
              alignment: 'END',
              lineSpacing: 100,
              spacingMode: 'COLLAPSE_LISTS',
              spaceAbove: { unit: 'PT' },
              spaceBelow: { unit: 'PT' },
            },
            fields: 'alignment,lineSpacing,spacingMode,spaceAbove,spaceBelow',
          },
        });
      }
    }
  }

  for (let row = EMAIL_LABELS.length - 1; row >= 0; row--) {
    requests.push({ insertText: { location: { index: cellParaStart(table, row, 0) }, text: EMAIL_LABELS[row] } });
  }
  return requests;
}

/**
 * Pass 3, against the re-read table: bold 10pt labels (the native block's label
 * size), then the field values, inserted from the highest index down.
 */
export function emailBlockFillRequests(table: TableShape, fields: EmailBlockFields): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  for (let row = 0; row < EMAIL_LABELS.length; row++) {
    const start = cellParaStart(table, row, 0);
    const end = cellParaEnd(table, row, 0) - 1; // exclude the cell's trailing newline
    if (end > start) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: end },
          textStyle: { bold: true, fontSize: { magnitude: 10, unit: 'PT' } },
          fields: 'bold,fontSize',
        },
      });
    }
  }

  // Descending cell order: body (row 4, merged into col 0), then Subject, Bcc, Cc, To (col 1).
  const values: [number, number, string | undefined][] = [
    [4, 0, fields.body],
    [3, 1, fields.subject],
    [2, 1, fields.bcc],
    [1, 1, fields.cc],
    [0, 1, fields.to],
  ];
  for (const [row, col, text] of values) {
    if (text) requests.push({ insertText: { location: { index: cellParaStart(table, row, col) }, text } });
  }
  return requests;
}

/** Final pass: delete every anchor token that received a block. */
export function deleteAnchorRequests(tokens: readonly string[]): Record<string, unknown>[] {
  return tokens.map((text) => ({
    replaceAllText: { containsText: { text, matchCase: true }, replaceText: '' },
  }));
}

/** The two Docs API calls the orchestration needs — the live client, or a test double. */
export interface EmailBlockDocsClient {
  get(documentId: string): Promise<{ body?: { content?: DocsStructuralElement[] | null } | null }>;
  batchUpdate(documentId: string, requests: Record<string, unknown>[]): Promise<unknown>;
}

export interface InsertEmailBlocksResult {
  documentId: string;
  /** Anchor tokens that became blocks, in document order. */
  inserted: string[];
  /** `@@EMAIL_*@@` tokens in the doc that no block asked for — left in place, visible. */
  unusedAnchors: string[];
}

/**
 * Replace each requested `@@EMAIL_<key>@@` anchor paragraph with a filled email
 * block, last anchor first, then delete the consumed tokens. Validates every
 * anchor BEFORE the first write, so a bad request changes nothing.
 */
export async function insertEmailBlocks(
  client: EmailBlockDocsClient,
  documentId: string,
  blocks: readonly EmailBlockSpec[],
): Promise<InsertEmailBlocksResult> {
  const initial = await client.get(documentId);
  const anchors = findEmailAnchors(initial.body?.content ?? []);
  const { plan, unusedAnchors } = planEmailBlocks(anchors, blocks);

  const inserted: InsertEmailBlocksResult['inserted'] = [];
  for (const { anchor, fields } of plan) {
    await client.batchUpdate(documentId, [insertEmailTableRequest(anchor.startIndex)]);
    const afterInsert = await client.get(documentId);
    const t1 = findTableAtOrAfter(afterInsert.body?.content ?? [], anchor.startIndex);
    await client.batchUpdate(documentId, emailBlockStyleRequests(t1.startIndex, t1.table));
    const afterStyle = await client.get(documentId);
    const t2 = findTableAtOrAfter(afterStyle.body?.content ?? [], anchor.startIndex);
    const fill = emailBlockFillRequests(t2.table, fields);
    if (fill.length > 0) await client.batchUpdate(documentId, fill);
    inserted.push(anchor.token);
  }
  if (plan.length > 0) {
    await client.batchUpdate(documentId, deleteAnchorRequests(plan.map((p) => p.anchor.token)));
  }
  return { documentId, inserted: inserted.reverse(), unusedAnchors };
}
