import { describe, it, expect, vi } from 'vitest';
import {
  cellHyperlinks,
  columnLetters,
  extractSheetHyperlinks,
  parseHyperlinkFormula,
  quoteSheetTitle,
} from '../../lib/sheets-hyperlinks.js';
import { handleSheetsReadHyperlinks } from '../../mcp/google-drive-server.js';

/**
 * ace#2390 — `sheets_read` returns only displayed text; the Connect LLO
 * Directory stores EOI provenance in the LINK TARGET. These pin the three
 * ways a link reaches a cell (whole-cell, partial run, =HYPERLINK) using the
 * grid-data shapes the Sheets API documents for `CellData`.
 */

describe('columnLetters / quoteSheetTitle', () => {
  it('maps 0-based indices to A1 letters', () => {
    expect([0, 9, 25, 26, 27, 51, 52, 701, 702].map(columnLetters)).toEqual([
      'A', 'J', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA',
    ]);
  });

  it('quotes non-identifier sheet titles', () => {
    expect(quoteSheetTitle('Sheet1')).toBe('Sheet1');
    expect(quoteSheetTitle('EOI/RFP')).toBe("'EOI/RFP'");
    expect(quoteSheetTitle("Bob's tab")).toBe("'Bob''s tab'");
  });
});

describe('parseHyperlinkFormula', () => {
  it('parses url + label', () => {
    expect(parseHyperlinkFormula('=HYPERLINK("https://x.test/a", "Label")')).toEqual({
      url: 'https://x.test/a',
      label: 'Label',
    });
  });
  it('parses url only, case-insensitive, with ; separator and escaped quotes', () => {
    expect(parseHyperlinkFormula('=hyperlink("https://x.test/b")')).toEqual({ url: 'https://x.test/b' });
    expect(parseHyperlinkFormula('=HYPERLINK("https://x.test/c";"say ""hi""")')).toEqual({
      url: 'https://x.test/c',
      label: 'say "hi"',
    });
  });
  it('returns null for a cell-reference url or another formula', () => {
    expect(parseHyperlinkFormula('=HYPERLINK(A1, "x")')).toBeNull();
    expect(parseHyperlinkFormula('=SUM(A1:A2)')).toBeNull();
  });
});

describe('cellHyperlinks', () => {
  it('reads a whole-cell rich-text link (cell.hyperlink)', () => {
    const cell = {
      formattedValue: '[PUBLIC] Request for EOI for Implementing Connect KMC in Nigeria',
      userEnteredValue: { stringValue: '[PUBLIC] Request for EOI for Implementing Connect KMC in Nigeria' },
      hyperlink: 'https://docs.google.com/document/d/EOI-KMC/edit',
    };
    expect(cellHyperlinks(cell, "'EOI/RFP'!J7")).toEqual([
      {
        a1: "'EOI/RFP'!J7",
        displayText: '[PUBLIC] Request for EOI for Implementing Connect KMC in Nigeria',
        url: 'https://docs.google.com/document/d/EOI-KMC/edit',
        kind: 'cell',
      },
    ]);
  });

  it('reads a link on PART of the text (textFormatRuns), one entry per linked span', () => {
    const cell = {
      formattedValue: 'See EOI one and EOI two',
      userEnteredValue: { stringValue: 'See EOI one and EOI two' },
      // hyperlink is empty when a cell holds more than one link
      textFormatRuns: [
        { format: {} },
        { startIndex: 4, format: { link: { uri: 'https://x.test/one' } } },
        { startIndex: 11, format: {} },
        { startIndex: 16, format: { link: { uri: 'https://x.test/two' } } },
      ],
    };
    expect(cellHyperlinks(cell, 'S!A1')).toEqual([
      { a1: 'S!A1', displayText: 'EOI one', url: 'https://x.test/one', kind: 'run' },
      { a1: 'S!A1', displayText: 'EOI two', url: 'https://x.test/two', kind: 'run' },
    ]);
  });

  it('reads an =HYPERLINK formula, preferring the evaluated target', () => {
    const cell = {
      formattedValue: 'Global CCC-CHC EOI',
      userEnteredValue: { formulaValue: '=HYPERLINK("https://x.test/ccc", "Global CCC-CHC EOI")' },
      hyperlink: 'https://x.test/ccc',
    };
    expect(cellHyperlinks(cell, 'S!B2')).toEqual([
      { a1: 'S!B2', displayText: 'Global CCC-CHC EOI', url: 'https://x.test/ccc', kind: 'formula' },
    ]);
  });

  it('falls back to the formula literal when Sheets did not populate hyperlink', () => {
    const cell = { userEnteredValue: { formulaValue: '=HYPERLINK("https://x.test/f","Lbl")' } };
    expect(cellHyperlinks(cell, 'S!C3')).toEqual([
      { a1: 'S!C3', displayText: 'Lbl', url: 'https://x.test/f', kind: 'formula' },
    ]);
  });

  it('does not double-report a single-run link that Sheets also put in cell.hyperlink', () => {
    const cell = {
      formattedValue: 'Doc',
      hyperlink: 'https://x.test/d',
      textFormatRuns: [{ format: { link: { uri: 'https://x.test/d' } } }],
    };
    expect(cellHyperlinks(cell, 'S!A1')).toHaveLength(1);
  });

  it('returns nothing for plain text', () => {
    expect(cellHyperlinks({ formattedValue: 'plain' }, 'S!A1')).toEqual([]);
  });
});

describe('extractSheetHyperlinks', () => {
  it('computes A1 from the grid offset and skips unlinked cells', () => {
    const data = {
      sheets: [
        {
          properties: { title: 'EOI/RFP' },
          data: [
            {
              startRow: 5,
              startColumn: 9,
              rowData: [
                { values: [{ formattedValue: 'no link' }] },
                { values: [{ formattedValue: 'KMC', hyperlink: 'https://x.test/kmc' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(extractSheetHyperlinks(data)).toEqual([
      { a1: "'EOI/RFP'!J7", displayText: 'KMC', url: 'https://x.test/kmc', kind: 'cell' },
    ]);
  });
});

describe('handleSheetsReadHyperlinks', () => {
  it('requests grid data narrowed to the link fields, on the shortcut TARGET', async () => {
    const driveApi = {
      files: {
        get: vi.fn().mockResolvedValue({
          data: { mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'ss-1' } },
        }),
      },
    };
    const sheetsApi = {
      spreadsheets: {
        get: vi.fn().mockResolvedValue({
          data: {
            sheets: [
              {
                properties: { title: 'Orgs' },
                data: [{ rowData: [{ values: [{ formattedValue: 'X', hyperlink: 'https://x.test/x' }] }] }],
              },
            ],
          },
        }),
      },
    };
    const r = await handleSheetsReadHyperlinks(
      { spreadsheetId: 'sc-1', range: 'Orgs!A1:A1' },
      sheetsApi as any,
      driveApi as any,
      { sleep: async () => {} },
    );
    const call = sheetsApi.spreadsheets.get.mock.calls[0][0];
    expect(call.spreadsheetId).toBe('ss-1');
    expect(call.ranges).toEqual(['Orgs!A1:A1']);
    expect(call.includeGridData).toBe(true);
    for (const f of ['hyperlink', 'textFormatRuns', 'userEnteredValue']) expect(call.fields).toContain(f);
    expect(r).toMatchObject({
      spreadsheet_id: 'ss-1',
      requested_file_id: 'sc-1',
      shortcut_resolved: true,
      total: 1,
      links: [{ a1: 'Orgs!A1', url: 'https://x.test/x', kind: 'cell' }],
    });
  });
});
