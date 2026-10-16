/**
 * Extract hyperlink TARGETS from a Sheets `spreadsheets.get` grid-data
 * response (ace#2390).
 *
 * `sheets_read` returns only what a cell DISPLAYS. A human-maintained sheet
 * can carry its meaning in the link behind the text — the Connect LLO
 * Directory joins an org to its EOI "on the LINK TARGET behind Organizations
 * column M, never on the text it displays" — and the values API gives no hint
 * that a link exists at all. A link reaches a cell three ways, and each
 * surfaces in a different field of the grid data:
 *
 *   - whole-cell rich-text link   → `cell.hyperlink`
 *     (also `userEnteredFormat.textFormat.link.uri` on some cells)
 *   - partial rich-text link      → `cell.textFormatRuns[].format.link.uri`,
 *     one run per linked span; `cell.hyperlink` is EMPTY when the cell holds
 *     more than one link
 *   - `=HYPERLINK("url", "label")`→ `userEnteredValue.formulaValue`
 *     (`cell.hyperlink` is usually populated for these too)
 *
 * The xlsx-export workaround in the issue only sees the first kind, so this
 * covers strictly more. Pure: no API calls, unit-tested against hand-built
 * grid data in `test/lib/sheets-hyperlinks.test.ts`.
 */

export type HyperlinkKind = 'cell' | 'run' | 'formula';

export interface CellHyperlink {
  /** Sheet-qualified A1 address of the cell, e.g. `'EOI/RFP'!J7`. */
  a1: string;
  /** The text the link is attached to: the whole cell, or the linked span. */
  displayText: string;
  url: string;
  kind: HyperlinkKind;
}

/** 0-based column index → A1 column letters (0 → A, 25 → Z, 26 → AA). */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Quote a sheet title for an A1 reference when it is not a bare identifier. */
export function quoteSheetTitle(title: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`;
}

/**
 * Parse the URL (and the label, when it is a literal) out of a
 * `=HYPERLINK("url"[, "label"])` formula. Returns null for anything else,
 * including a HYPERLINK whose URL is a cell reference — that target is not
 * knowable from the formula text, and `cell.hyperlink` covers it when Sheets
 * evaluated it.
 */
export function parseHyperlinkFormula(formula: string): { url: string; label?: string } | null {
  const m = /^\s*=\s*HYPERLINK\s*\(\s*"((?:[^"]|"")*)"\s*(?:[,;]\s*"((?:[^"]|"")*)"\s*)?\)\s*$/i.exec(
    formula,
  );
  if (!m) return null;
  const unq = (s: string) => s.replace(/""/g, '"');
  return { url: unq(m[1]), ...(m[2] !== undefined ? { label: unq(m[2]) } : {}) };
}

function displayOf(cell: any): string {
  if (typeof cell.formattedValue === 'string') return cell.formattedValue;
  const v = cell.userEnteredValue ?? {};
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (v.numberValue !== undefined) return String(v.numberValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  return '';
}

/** Every hyperlink inside ONE cell, in reading order. */
export function cellHyperlinks(cell: any, a1: string): CellHyperlink[] {
  if (!cell) return [];
  const text = displayOf(cell);
  const out: CellHyperlink[] = [];

  // Partial links: one entry per linked run. A run spans from its startIndex
  // to the next run's (or the end of the text).
  const runs: any[] = Array.isArray(cell.textFormatRuns) ? cell.textFormatRuns : [];
  runs.forEach((run, i) => {
    const uri = run?.format?.link?.uri;
    if (!uri) return;
    const start = run.startIndex ?? 0;
    const end = i + 1 < runs.length ? (runs[i + 1].startIndex ?? text.length) : text.length;
    out.push({ a1, displayText: text.slice(start, end), url: uri, kind: 'run' });
  });

  const formula = cell.userEnteredValue?.formulaValue;
  const parsed = typeof formula === 'string' ? parseHyperlinkFormula(formula) : null;
  const isHyperlinkFormula = typeof formula === 'string' && /^\s*=\s*HYPERLINK\s*\(/i.test(formula);
  const whole = cell.hyperlink || cell.userEnteredFormat?.textFormat?.link?.uri || null;

  if (isHyperlinkFormula && (whole || parsed)) {
    // Prefer the target Sheets evaluated; fall back to the literal in the formula.
    out.push({ a1, displayText: text || parsed?.label || '', url: whole || parsed!.url, kind: 'formula' });
  } else if (whole && !out.some((l) => l.url === whole)) {
    out.push({ a1, displayText: text, url: whole, kind: 'cell' });
  }
  return out;
}

/**
 * Walk a `spreadsheets.get` response (with grid data) and return every
 * linked cell. Cells with no link are omitted — the caller reads display
 * text with `sheets_read`.
 */
export function extractSheetHyperlinks(spreadsheet: any): CellHyperlink[] {
  const out: CellHyperlink[] = [];
  for (const sheet of spreadsheet?.sheets ?? []) {
    const title = quoteSheetTitle(sheet?.properties?.title ?? '');
    for (const grid of sheet?.data ?? []) {
      const row0 = grid.startRow ?? 0;
      const col0 = grid.startColumn ?? 0;
      (grid.rowData ?? []).forEach((row: any, r: number) => {
        (row?.values ?? []).forEach((cell: any, c: number) => {
          const a1 = `${title}!${columnLetters(col0 + c)}${row0 + r + 1}`;
          out.push(...cellHyperlinks(cell, a1));
        });
      });
    }
  }
  return out;
}
