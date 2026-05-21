// dimagi_styles.js
//
// Helper library for building Dimagi-branded external .docx documents.
// Encodes every visual decision documented in references/style-guide.md.
//
// Usage:
//   const D = require('./dimagi_styles');
//   const children = [
//     D.title('Work Order Agreement #4'),
//     D.subtitle('Project Name — Country'),
//     D.metadataTable([
//       ['Work Order Number', '4'],
//       ['Work Order Date', '15 June 2026'],
//     ]),
//     D.h2('1. Background'),
//     D.body('GiveWell has issued a Request for Information...'),
//     ...
//   ];
//   const doc = D.buildDocument(children);
//   require('fs').writeFileSync('out.docx', await require('docx').Packer.toBuffer(doc));
//
// Requires: `npm install docx` (tested with docx ^9.6.1)

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, BorderStyle, WidthType, ShadingType,
  VerticalAlign, HeadingLevel,
} = require('docx');

// ============================================================
// BRAND CONSTANTS  —  See references/style-guide.md
// ============================================================

const COLORS = {
  DEEP_PURPLE: '16006D',      // H1, H2, metadata labels, data table headers, ID column numbers
  CONNECT_INDIGO: '3843D0',   // Subtitle, decorative borders under H1/H2
  BODY_GREY: '5F6A7D',        // All body text
  CHARCOAL: '434343',         // H3 sub-headings
  WHITE: 'FFFFFF',            // Text on Deep Purple table headers
  LIGHT_PURPLE: 'F2F0F7',     // Metadata label fill + alternating row shading
  BORDER_GREY: 'CCCCCC',      // All table borders
};

const FONT = 'Work Sans';     // System fallback to Arial via Word substitution

// Font sizes in OOXML half-points
const SIZE = {
  TITLE: 40,        // 20pt
  SUBTITLE: 28,     // 14pt
  H2: 28,           // 14pt
  H3: 24,           // 12pt
  BODY: 22,         // 11pt (default)
  TABLE: 20,        // 10pt
};

// Standard document widths
const PAGE = {
  WIDTH: 12240,           // US Letter 8.5"
  HEIGHT: 15840,          // 11"
  MARGIN: 1440,           // 1" margins all sides
  CONTENT_WIDTH: 9360,    // After 1" margins
};

// Standard cell padding for the two table patterns
const CELL_PADDING = {
  METADATA: { top: 80,  bottom: 80,  left: 140, right: 140 },
  DATA:     { top: 100, bottom: 100, left: 140, right: 140 },
};

// Standard border configurations
const _border = (size, color = COLORS.BORDER_GREY) =>
  ({ style: BorderStyle.SINGLE, size, color });

const BORDERS = {
  METADATA: {
    top:    _border(6), bottom: _border(6),
    left:   _border(6), right:  _border(6),
  },
  DATA: {
    top:    _border(4), bottom: _border(4),
    left:   _border(4), right:  _border(4),
  },
};

// ============================================================
// PARAGRAPH HELPERS
// ============================================================

/** Document title (e.g., "Work Order Agreement #3"). Centered, Deep Purple, bold, 20pt. */
function title(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60, line: 240, lineRule: 'auto' },
    children: [new TextRun({
      text, font: FONT, size: SIZE.TITLE, bold: true, color: COLORS.DEEP_PURPLE,
    })],
  });
}

/** Subtitle (project name). Centered, Connect Indigo, regular, 14pt, with 12pt bottom border. */
function subtitle(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240, line: 240, lineRule: 'auto' },
    border: { bottom: { color: COLORS.CONNECT_INDIGO, space: 4, style: BorderStyle.SINGLE, size: 12 } },
    children: [new TextRun({
      text, font: FONT, size: SIZE.SUBTITLE, color: COLORS.CONNECT_INDIGO,
    })],
  });
}

/** H2 numbered section heading (e.g., "1. Background"). Deep Purple, bold, 14pt, with 8pt Connect Indigo bottom border. */
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120, line: 240, lineRule: 'auto' },
    border: { bottom: { color: COLORS.CONNECT_INDIGO, space: 4, style: BorderStyle.SINGLE, size: 8 } },
    children: [new TextRun({
      text, font: FONT, size: SIZE.H2, bold: true, color: COLORS.DEEP_PURPLE,
    })],
  });
}

/** H3 sub-section heading (e.g., "4.1 Primary Deliverable"). Charcoal, bold, 12pt. */
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 80, line: 240, lineRule: 'auto' },
    children: [new TextRun({
      text, font: FONT, size: SIZE.H3, bold: true, color: COLORS.CHARCOAL,
    })],
  });
}

/** Plain body paragraph. Justified, Body Grey, 11pt, 1.5 line spacing. */
function body(text) {
  return new Paragraph({
    alignment: AlignmentType.BOTH,    // justified
    spacing: { after: 200, line: 300, lineRule: 'auto' },
    children: [new TextRun({
      text, font: FONT, size: SIZE.BODY, color: COLORS.BODY_GREY,
    })],
  });
}

/**
 * Rich body paragraph with mixed bold/regular segments.
 * Pass an array of {text, bold} segments.
 *   richBody([
 *     { text: 'This Work Order covers ' },
 *     { text: 'field collection only', bold: true },
 *     { text: '. Laboratory testing is arranged separately.' },
 *   ])
 */
function richBody(segments) {
  return new Paragraph({
    alignment: AlignmentType.BOTH,
    spacing: { after: 200, line: 300, lineRule: 'auto' },
    children: segments.map(seg => new TextRun({
      text: seg.text,
      bold: !!seg.bold,
      italics: !!seg.italics,
      font: FONT,
      size: SIZE.BODY,
      color: COLORS.BODY_GREY,
    })),
  });
}

/** Single-level bullet. Pass a string for plain text, or an array of {text, bold} segments. */
function bullet(textOrSegments, level = 0) {
  const segments = Array.isArray(textOrSegments)
    ? textOrSegments
    : [{ text: textOrSegments }];
  return new Paragraph({
    numbering: { reference: 'dimagi-bullets', level },
    alignment: AlignmentType.BOTH,
    spacing: { after: 40, line: 300, lineRule: 'auto' },
    children: segments.map(seg => new TextRun({
      text: seg.text,
      bold: !!seg.bold,
      italics: !!seg.italics,
      font: FONT,
      size: SIZE.BODY,
      color: COLORS.BODY_GREY,
    })),
  });
}

/** Empty spacer paragraph. Useful between tables and the next heading. */
function spacer() {
  return new Paragraph({ children: [new TextRun({ text: '' })] });
}

// ============================================================
// TABLE HELPERS
// ============================================================

/** Internal: build a cell with standard data-table styling. */
function _dataCell(text, opts = {}) {
  const segments = Array.isArray(text)
    ? text
    : [{ text: String(text) }];
  return new TableCell({
    width: { size: opts.width || 1000, type: WidthType.DXA },
    shading: opts.fill
      ? { fill: opts.fill, type: ShadingType.CLEAR, color: 'auto' }
      : undefined,
    margins: CELL_PADDING.DATA,
    verticalAlign: VerticalAlign.CENTER,
    borders: BORDERS.DATA,
    children: [new Paragraph({
      alignment: opts.align || AlignmentType.LEFT,
      spacing: { before: 20, after: 20 },
      children: segments.map(seg => new TextRun({
        text: seg.text,
        font: FONT,
        size: SIZE.TABLE,
        bold: !!(opts.bold || seg.bold),
        color: opts.color || seg.color || COLORS.BODY_GREY,
      })),
    })],
  });
}

/** Header-row cell. Deep Purple fill, white bold text. */
function _headerCell(text, width, align = AlignmentType.LEFT) {
  return _dataCell(text, {
    width,
    fill: COLORS.DEEP_PURPLE,
    color: COLORS.WHITE,
    bold: true,
    align,
  });
}

/**
 * Build a metadata table (Pattern A).
 *
 * @param {Array<[string, string]>} rows - [label, value] pairs
 * @param {object} opts - { labelWidth=2400, valueWidth=6960 }
 * @returns {Table}
 *
 * Example:
 *   metadataTable([
 *     ['Work Order Number', '3'],
 *     ['Work Order Date',   '20 May 2026'],
 *     ['Period of Performance', 'May 22, 2026 to July 31, 2026'],
 *   ])
 */
function metadataTable(rows, opts = {}) {
  const labelW = opts.labelWidth || 2400;
  const valueW = opts.valueWidth || 6960;

  return new Table({
    width: { size: labelW + valueW, type: WidthType.DXA },
    columnWidths: [labelW, valueW],
    rows: rows.map(([label, value]) => new TableRow({
      children: [
        new TableCell({
          width: { size: labelW, type: WidthType.DXA },
          shading: { fill: COLORS.LIGHT_PURPLE, type: ShadingType.CLEAR, color: 'auto' },
          margins: CELL_PADDING.METADATA,
          borders: BORDERS.METADATA,
          children: [new Paragraph({
            children: [new TextRun({
              text: label, font: FONT, size: SIZE.TABLE,
              bold: true, color: COLORS.DEEP_PURPLE,
            })],
          })],
        }),
        new TableCell({
          width: { size: valueW, type: WidthType.DXA },
          margins: CELL_PADDING.METADATA,
          borders: BORDERS.METADATA,
          children: [new Paragraph({
            children: [new TextRun({
              text: value, font: FONT, size: SIZE.TABLE, color: COLORS.BODY_GREY,
            })],
          })],
        }),
      ],
    })),
  });
}

/**
 * Build a data table (Pattern B): purple header row + alternating row shading.
 *
 * @param {object} config
 * @param {string[]} config.headers - column header text
 * @param {Array<Array<string|{text,bold,color}>>} config.rows - body rows
 * @param {number[]} config.columnWidths - DXA widths summing to ≤9360
 * @param {object} [config.options]
 * @param {number[]} [config.options.centerColumns] - 0-indexed column indices to center (e.g., [0] for ID column)
 * @param {number[]} [config.options.boldColumns] - 0-indexed column indices to bold (e.g., [0] for ID column)
 * @param {number[]} [config.options.deepPurpleColumns] - 0-indexed column indices to color Deep Purple (e.g., [0] for ID column)
 * @param {number[]} [config.options.headerCenterColumns] - 0-indexed column indices in HEADER to center (often the same as centerColumns)
 * @returns {Table}
 *
 * Example:
 *   dataTable({
 *     headers: ['Week', 'Dates', 'Activities'],
 *     columnWidths: [1100, 1700, 6560],
 *     rows: [
 *       ['1', 'w/c 26 May', 'Protocol finalization...'],
 *       ['2', 'w/c 1 June', 'FLW training...'],
 *     ],
 *     options: {
 *       centerColumns: [0],
 *       boldColumns: [0],
 *       deepPurpleColumns: [0],
 *       headerCenterColumns: [0],
 *     },
 *   })
 */
function dataTable({ headers, rows, columnWidths, options = {} }) {
  const opts = {
    centerColumns: options.centerColumns || [],
    boldColumns: options.boldColumns || [],
    deepPurpleColumns: options.deepPurpleColumns || [],
    headerCenterColumns: options.headerCenterColumns || options.centerColumns || [],
  };

  const totalWidth = columnWidths.reduce((a, b) => a + b, 0);

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => _headerCell(
      h,
      columnWidths[i],
      opts.headerCenterColumns.includes(i) ? AlignmentType.CENTER : AlignmentType.LEFT,
    )),
  });

  // Alternating shading: first body row white, second F2F0F7, third white, ...
  const bodyRows = rows.map((row, ridx) => {
    const altFill = (ridx % 2 === 1) ? COLORS.LIGHT_PURPLE : undefined;
    return new TableRow({
      children: row.map((cellVal, cidx) => _dataCell(cellVal, {
        width: columnWidths[cidx],
        fill: altFill,
        align: opts.centerColumns.includes(cidx) ? AlignmentType.CENTER : AlignmentType.LEFT,
        bold: opts.boldColumns.includes(cidx),
        color: opts.deepPurpleColumns.includes(cidx) ? COLORS.DEEP_PURPLE : undefined,
      })),
    });
  });

  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths,
    rows: [headerRow, ...bodyRows],
  });
}

// ============================================================
// SIGNATURE BLOCK
// ============================================================

/**
 * Two-column signature block with light-purple cell fill.
 *
 * @param {object} partner - { name, title, organization, address }
 * @param {object} [dimagi] - defaults to Lucina Tse, COO
 * @returns {Table}
 */
function signatureBlock(partner, dimagi) {
  const d = dimagi || {
    name: 'Lucina Tse',
    title: 'COO',
    organization: 'Dimagi, Inc.',
    address: '245 Main Street, 2nd Floor, Cambridge, MA 02142',
  };

  function _block(heading, party) {
    const lines = [
      new Paragraph({
        spacing: { before: 0, after: 120 },
        children: [new TextRun({
          text: heading, font: FONT, size: SIZE.BODY, bold: true, color: COLORS.DEEP_PURPLE,
        })],
      }),
      _sigLine('By', '________________________________'),
      _sigLine('Name', party?.name || '________________________________'),
      _sigLine('Title', party?.title || '________________________________'),
      _sigLine('Date', '________________________________'),
      _sigLine('Address for correspondence', party?.address || '________________________________'),
    ];

    return new TableCell({
      width: { size: 4680, type: WidthType.DXA },
      margins: { top: 140, bottom: 140, left: 160, right: 160 },
      shading: { fill: COLORS.LIGHT_PURPLE, type: ShadingType.CLEAR, color: 'auto' },
      borders: BORDERS.DATA,
      children: lines,
    });
  }

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [4680, 4680],
    rows: [new TableRow({ children: [_block('Subcontractor', partner), _block(d.organization, d)] })],
  });
}

function _sigLine(label, value) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [
      new TextRun({ text: label + ': ', font: FONT, size: SIZE.BODY, bold: true, color: COLORS.DEEP_PURPLE }),
      new TextRun({ text: value, font: FONT, size: SIZE.BODY, color: COLORS.BODY_GREY }),
    ],
  });
}

// ============================================================
// DOCUMENT ASSEMBLY
// ============================================================

/**
 * Build a complete docx Document with Dimagi defaults.
 *
 * @param {Array} children - array of paragraphs, tables, etc.
 * @param {object} [meta] - { creator, title, subject }
 * @returns {Document}
 */
function buildDocument(children, meta = {}) {
  return new Document({
    creator: meta.creator || 'Dimagi',
    title: meta.title || 'Dimagi External Document',
    subject: meta.subject,
    styles: {
      default: {
        document: { run: { font: FONT, size: SIZE.BODY, color: COLORS.BODY_GREY } },
      },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: SIZE.TITLE, bold: true, font: FONT, color: COLORS.DEEP_PURPLE },
          paragraph: { spacing: { before: 240, after: 60 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: SIZE.H2, bold: true, font: FONT, color: COLORS.DEEP_PURPLE },
          paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: SIZE.H3, bold: true, font: FONT, color: COLORS.CHARCOAL },
          paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
      ],
    },
    numbering: {
      config: [{
        reference: 'dimagi-bullets',
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: '\u25CF', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },   // ●
          { level: 1, format: LevelFormat.BULLET, text: '\u25E6', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },  // ○
          { level: 2, format: LevelFormat.BULLET, text: '\u25A0', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 2160, hanging: 360 } } } },  // ■
        ],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE.WIDTH, height: PAGE.HEIGHT },
          margin: { top: PAGE.MARGIN, right: PAGE.MARGIN, bottom: PAGE.MARGIN, left: PAGE.MARGIN },
        },
      },
      // No headers or footers — Dimagi external documents omit these on purpose.
      children,
    }],
  });
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Brand constants
  COLORS, FONT, SIZE, PAGE, CELL_PADDING, BORDERS,
  // Paragraph helpers
  title, subtitle, h2, h3, body, richBody, bullet, spacer,
  // Table helpers
  metadataTable, dataTable, signatureBlock,
  // Assembly
  buildDocument,
  // Re-exports from docx for convenience
  Packer,
  AlignmentType,
};
