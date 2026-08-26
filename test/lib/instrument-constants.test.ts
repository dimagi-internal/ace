/**
 * dimagi-internal/ace#1527 — a digitised `[FIXED]` instrument shipped with 9 of
 * 17 point values wrong and all 101 poverty-likelihood values invented, and no
 * gate on the path could see it.
 *
 * The three things pinned here are the three ways that failed:
 *
 *  1. **The extraction lied.** A `t="s"` cell stores an INDEX into
 *     `xl/sharedStrings.xml`, and read undecoded it is a plausible number —
 *     `score 4 -> 79.0`, which is a header row wearing a datum's clothes.
 *  2. **Nothing diffed the built literals against the published table.**
 *  3. **The clamp was dead.** Built max 96 against an official 102 means the
 *     PDD's `min(ppi_score, 100)` can never fire, so the instrument stayed
 *     internally consistent with its own wrong numbers.
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  readXlsxColumn,
  assertExtractionTrusted,
  diffScoringConstants,
  compareMaxScore,
  parseSharedStrings,
  resolveInstrumentSource,
} from '../../lib/instrument-constants.js';

// ---------------------------------------------------------------------------
// Fixture workbook builder — a minimal but real xlsx package.
// ---------------------------------------------------------------------------

interface FixtureCell {
  row: number;
  /** Omit for a plain numeric cell. `'s'` makes it a shared-string index. */
  type?: string;
  raw: string;
}

function buildWorkbook(cells: FixtureCell[], sharedStrings: string[]): Uint8Array {
  const rows = cells
    .map(
      (c) =>
        `<row r="${c.row}"><c r="D${c.row}"${c.type ? ` t="${c.type}"` : ''}>` +
        `<v>${c.raw}</v></c></row>`,
    )
    .join('');

  const sheet =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows}</sheetData></worksheet>`;

  const sst =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
    sharedStrings.map((s) => `<si><t>${s}</t></si>`).join('') +
    '</sst>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Lookup Table" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/sharedStrings.xml': strToU8(sst),
  });
}

/**
 * The official Nigeria PPI 2020 National Poverty Line column, as the issue
 * states it: 101 rows (score 0..100), first 0.9329, last 0.0015, strictly
 * descending. The interior values are a linear fill — this fixture pins the
 * EXTRACTION machinery, not the published table (which is licensed and lives
 * in the run's `inputs/`, not in this repo).
 */
const FIRST = 0.9329;
const LAST = 0.0015;
function likelihoodSeries(): string[] {
  const step = (FIRST - LAST) / 100;
  return Array.from({ length: 101 }, (_, i) => {
    if (i === 0) return String(FIRST);
    if (i === 100) return String(LAST);
    return String(FIRST - i * step);
  });
}

describe('readXlsxColumn — shared strings', () => {
  it('decodes a t="s" cell THROUGH sharedStrings instead of leaking its index (ace#1527)', () => {
    // sharedStrings[79] is a HEADER, and 79 is what the undecoded read returns.
    const sharedStrings = Array.from({ length: 80 }, (_, i) =>
      i === 79 ? 'National Poverty Line' : `filler-${i}`,
    );
    const cells: FixtureCell[] = [
      { row: 11, type: 's', raw: '79' }, // the header leak
      { row: 12, raw: '0.9235' },
      { row: 13, raw: '0.9142' },
      { row: 14, raw: '0.9048' },
      { row: 15, raw: '0.8955' },
    ];

    const result = readXlsxColumn(buildWorkbook(cells, sharedStrings), {
      column: 'D',
      firstRow: 11,
      lastRow: 15,
    });

    // The digit that WOULD have leaked is still visible on the cell record…
    expect(result.cells[0].raw).toBe('79');
    expect(result.cells[0].type).toBe('s');
    // …but the value is the decoded STRING, never the number 79.
    expect(result.values[0]).toBe('National Poverty Line');
    expect(typeof result.values[0]).not.toBe('number');
    expect(result.sharedStringCount).toBe(80);
  });

  it('returns an UNRESOLVED t="s" index as a string, never as a number', () => {
    // No entry 79 in a 3-string table — the exact shape that produced 79.0.
    const result = readXlsxColumn(
      buildWorkbook([{ row: 11, type: 's', raw: '79' }], ['a', 'b', 'c']),
      { column: 'D', firstRow: 11, lastRow: 11 },
    );
    expect(typeof result.values[0]).toBe('string');
    expect(result.values[0]).toBe('79');
    expect(result.problems.map((p) => p.kind)).toContain('unresolved-shared-string');
  });

  it('reports BOTH an endpoint and a monotonicity failure on the leaked header', () => {
    const sharedStrings = Array.from({ length: 80 }, (_, i) =>
      i === 79 ? 'National Poverty Line' : `filler-${i}`,
    );
    const raws = likelihoodSeries();
    const cells: FixtureCell[] = raws.map((raw, i) =>
      i === 0 ? { row: 11, type: 's', raw: '79' } : { row: 11 + i, raw },
    );

    const result = readXlsxColumn(buildWorkbook(cells, sharedStrings), {
      column: 'D',
      firstRow: 11,
      lastRow: 111,
    });
    const verdict = assertExtractionTrusted(result.values, {
      expectedFirst: FIRST,
      expectedLast: LAST,
      expectedRowCount: 101,
    });

    expect(verdict.trusted).toBe(false);
    const kinds = verdict.failures.map((f) => f.kind);
    expect(kinds).toContain('endpoint');
    expect(kinds).toContain('monotonicity');
  });

  it('resolves a worksheet by NAME as well as by index', () => {
    const wb = buildWorkbook([{ row: 11, raw: '0.9329' }], []);
    expect(
      readXlsxColumn(wb, { sheet: 'Lookup Table', column: 'D', firstRow: 11, lastRow: 11 })
        .values[0],
    ).toBe(0.9329);
    expect(
      readXlsxColumn(wb, { sheet: 9, column: 'D', firstRow: 11, lastRow: 11 }).problems[0].kind,
    ).toBe('sheet-not-found');
  });

  it('does not throw on bytes that are not a workbook', () => {
    const result = readXlsxColumn(strToU8('this is not a zip'), {
      column: 'D',
      firstRow: 11,
      lastRow: 111,
    });
    expect(result.problems[0].kind).toBe('unreadable-workbook');
    expect(result.values).toEqual([]);
  });

  it('joins shared-string runs and skips phonetic rPh fragments', () => {
    const xml =
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<si><r><t>National </t></r><r><t>Poverty Line</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si>' +
      '</sst>';
    expect(parseSharedStrings(xml)).toEqual(['National Poverty Line']);
  });
});

describe('assertExtractionTrusted', () => {
  it('trusts a clean 101-row, strictly-descending series with matching endpoints', () => {
    const result = readXlsxColumn(
      buildWorkbook(
        likelihoodSeries().map((raw, i) => ({ row: 11 + i, raw })),
        [],
      ),
      { column: 'D', firstRow: 11, lastRow: 111 },
    );
    expect(result.problems).toEqual([]);
    expect(result.values).toHaveLength(101);

    const verdict = assertExtractionTrusted(result.values, {
      expectedFirst: FIRST,
      expectedLast: LAST,
      expectedRowCount: 101,
      tolerance: 1e-9,
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.trusted).toBe(true);
    expect(verdict.direction).toBe('descending');
  });

  it('runs the three assertions INDEPENDENTLY — one series can fail all three', () => {
    // Too short, wrong endpoints, and not monotonic.
    const verdict = assertExtractionTrusted([0.5, 0.9, 0.7], {
      expectedFirst: FIRST,
      expectedLast: LAST,
      expectedRowCount: 101,
    });
    const kinds = new Set(verdict.failures.map((f) => f.kind));
    expect(kinds).toContain('row-count');
    expect(kinds).toContain('endpoint');
    expect(kinds).toContain('monotonicity');
    expect(verdict.trusted).toBe(false);
  });

  it('rejects a series that merely PLATEAUS — monotonicity is strict', () => {
    const flat = [FIRST, 0.5, 0.5, LAST];
    const verdict = assertExtractionTrusted(flat, {
      expectedFirst: FIRST,
      expectedLast: LAST,
      expectedRowCount: 4,
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict.failures.map((f) => f.kind)).toContain('monotonicity');
  });

  it('reads an ascending declaration without an explicit direction', () => {
    const verdict = assertExtractionTrusted([1, 2, 3], {
      expectedFirst: 1,
      expectedLast: 3,
      expectedRowCount: 3,
    });
    expect(verdict.direction).toBe('ascending');
    expect(verdict.trusted).toBe(true);
  });
});

describe('diffScoringConstants', () => {
  /**
   * The nine wrong point values ace#1527 records, verbatim from the issue body:
   * built value vs the official Nigeria PPI 2020 value.
   */
  const SOURCE = {
    south_east: 0,
    north_central: 10,
    north_west: 2,
    bread: 9,
    eggs: 10,
    milk: 6,
    sachet_bottled_water: 6,
    fan: 5,
    iron: 6,
  };
  const BUILT = {
    south_east: 12,
    north_central: 6,
    north_west: 0,
    bread: 6,
    eggs: 6,
    milk: 5,
    sachet_bottled_water: 8,
    fan: 6,
    iron: 5,
  };

  it('finds all nine fabricated point values', () => {
    const diff = diffScoringConstants({ source: SOURCE, built: BUILT });
    expect(diff.mismatches).toHaveLength(9);
    expect(diff.missingInBuild).toEqual([]);
    expect(diff.extraInBuild).toEqual([]);
    expect(diff.total).toBe(9);
    expect(diff.mismatches[0]).toEqual({ key: 'south_east', source: 0, built: 12 });
    expect(diff.mismatches.find((m) => m.key === 'eggs')).toEqual({
      key: 'eggs',
      source: 10,
      built: 6,
    });
  });

  it('reports zero on an exact transcription', () => {
    const diff = diffScoringConstants({ source: SOURCE, built: { ...SOURCE } });
    expect(diff.mismatches).toEqual([]);
    expect(diff.total).toBe(0);
  });

  it('separates a constant the build never shipped from one it invented', () => {
    const diff = diffScoringConstants({
      source: { roof_iron: 4, floor_cement: 3 },
      built: { floor_cement: 3, tv_owned: 7 },
    });
    expect(diff.mismatches).toEqual([]);
    expect(diff.missingInBuild).toEqual(['roof_iron']);
    expect(diff.extraInBuild).toEqual(['tv_owned']);
    expect(diff.total).toBe(2);
  });

  it('treats a zero source value as a value, not as absent', () => {
    // `south_east` is officially 0 and shipped as 12 — a falsy source value is
    // the single most likely thing a naive diff drops.
    const diff = diffScoringConstants({ source: { south_east: 0 }, built: { south_east: 12 } });
    expect(diff.mismatches).toEqual([{ key: 'south_east', source: 0, built: 12 }]);
  });
});

describe('compareMaxScore', () => {
  /**
   * DELIBERATELY SYNTHETIC grouping. ace#1527 states the two TOTALS (official
   * 102, built 96) and nine wrong point values, but not the indicator grouping
   * the maxima are summed over — so a "real-looking" fixture here would be
   * exactly the fabrication this helper exists to catch. The zone options are
   * the issue's real numbers; the rest is transparent filler chosen so the
   * totals land on the two figures the issue does state.
   */
  const sourcePoints = {
    zone: { south_east: 0, north_central: 10, north_west: 2 },
    assets: { none: 0, some: 40, many: 60 },
    household_size: { small: 32, large: 0 },
  };
  const builtPoints = {
    zone: { south_east: 12, north_central: 6, north_west: 0 },
    assets: { none: 0, some: 40, many: 52 },
    household_size: { small: 32, large: 0 },
  };

  it('exposes the dead min(ppi_score, 100) clamp behind an under-scoring build', () => {
    const result = compareMaxScore({ sourcePoints, builtPoints });
    expect(result.sourceMax).toBe(102);
    expect(result.builtMax).toBe(96);
    expect(result.clampDead).toBe(true);
    expect(result.clampReachableInSource).toBe(true);
    expect(result.delta).toBe(-6);
    expect(result.clampAt).toBe(100);
  });

  it('reports a live clamp when the build transcribes the source exactly', () => {
    const result = compareMaxScore({ sourcePoints, builtPoints: sourcePoints });
    expect(result.builtMax).toBe(102);
    expect(result.clampDead).toBe(false);
    expect(result.delta).toBe(0);
  });

  it('sums the BEST option per indicator, not every option', () => {
    const result = compareMaxScore({
      sourcePoints: { a: { x: 1, y: 9 }, b: { x: 3, y: 4 } },
      builtPoints: { a: { x: 1, y: 9 }, b: { x: 3, y: 4 } },
      clampAt: 10,
    });
    expect(result.sourceMax).toBe(13); // 9 + 4, not 1+9+3+4
    expect(result.clampDead).toBe(false);
  });

  it('scores an indicator the build dropped entirely as 0, not as absent', () => {
    const result = compareMaxScore({
      sourcePoints: { a: { x: 10 }, b: { x: 5 } },
      builtPoints: { a: { x: 10 } },
    });
    expect(result.sourceMax).toBe(15);
    expect(result.builtMax).toBe(10);
    expect(result.perIndicator.find((i) => i.indicator === 'b')?.builtMax).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1648 — the skip that disabled the check
// ---------------------------------------------------------------------------
//
// Step 4k's trigger ANDed two conditions into ONE silent skip: the PDD marks
// an instrument `[FIXED]`, AND `inputs-manifest.yaml` carries a source file
// for it. So "no [FIXED] instrument on this opp" and "the [FIXED] instrument's
// source is unreachable" produced the same outcome — a clean skip and a green
// phase — and because the manifest's `inputs[]` records direct child FILES
// only, a vendor bundle sitting in a SUBFOLDER of `inputs/` always took the
// second branch. On `hh-poverty-targeting/20260824-1404` the workbook was in
// `official-nigeria-ppi-2020 (povertyindex.org)/`, none of the five `inputs[]`
// entries was it, and a 4k run following its documented path checks nothing.
//
// A skip that disables a correctness check is worse than one that degrades an
// output, because the run still says green.

describe('resolveInstrumentSource (ace#1648)', () => {
  const workbook = {
    file_id: '1JdkrvaFTGq_jJ2g7gAnpyvcbUL05Eish',
    name: 'nigeria-ppi-2020-scorecard-and-lookup-table.xlsx',
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };

  it('HALTS — never skips — for a [FIXED] instrument with no manifest entry', () => {
    const result = resolveInstrumentSource({ fixedInstrument: true, manifestEntry: null });
    expect(result.disposition).toBe('halt');
    expect(result.disposition).not.toBe('skipped');
    expect(result.reason).toBe('unresolvable');
    expect(result.source).toBeNull();
    expect(result.memo).toMatch(/HALT/);
  });

  it('still HALTS when the subfolder walk ran and found nothing', () => {
    const result = resolveInstrumentSource({
      fixedInstrument: true,
      manifestEntry: null,
      subfolderCandidates: [],
      manifestRecordsSubfolders: true,
      instrumentName: 'Nigeria PPI 2020',
    });
    expect(result.disposition).toBe('halt');
    expect(result.detail).toContain('Nigeria PPI 2020');
  });

  it('names the manifest repair when the manifest recorded no subfolder ids', () => {
    const result = resolveInstrumentSource({
      fixedInstrument: true,
      manifestEntry: null,
      manifestRecordsSubfolders: false,
    });
    expect(result.disposition).toBe('halt');
    expect(result.detail).toMatch(/Step 5c/);
  });

  it('skips silently — and only here — when the PDD declares no [FIXED] instrument', () => {
    const result = resolveInstrumentSource({ fixedInstrument: false, manifestEntry: null });
    expect(result.disposition).toBe('skipped');
    expect(result.reason).toBe('no-fixed-instrument');
    expect(result.memo).toMatch(/^instrument_constants: skipped — /);
  });

  it('proceeds from a direct inputs[] entry', () => {
    const result = resolveInstrumentSource({ fixedInstrument: true, manifestEntry: workbook });
    expect(result.disposition).toBe('proceed');
    expect(result.reason).toBe('resolved-from-inputs');
    expect(result.source?.file_id).toBe(workbook.file_id);
  });

  it('proceeds from a manifest-recorded subfolder — the shape #1648 could not reach', () => {
    const result = resolveInstrumentSource({
      fixedInstrument: true,
      manifestEntry: null,
      manifestRecordsSubfolders: true,
      subfolderCandidates: [
        { ...workbook, folder_id: '1b4f1tXT1YYyROelmt761oUX7XOsAqtut' },
      ],
    });
    expect(result.disposition).toBe('proceed');
    expect(result.reason).toBe('resolved-from-subfolder');
    expect(result.source?.file_id).toBe(workbook.file_id);
    expect(result.source?.folder_id).toBe('1b4f1tXT1YYyROelmt761oUX7XOsAqtut');
  });

  it('HALTS rather than guessing when two candidates match', () => {
    const result = resolveInstrumentSource({
      fixedInstrument: true,
      manifestEntry: null,
      manifestRecordsSubfolders: true,
      subfolderCandidates: [
        { ...workbook, folder_id: 'f1' },
        {
          file_id: '1AmdDRLylHYaCFuM-wRXUjr6dPRUyRrTj',
          name: 'nigeria-ppi-2020-data-analysis-tool.xlsx',
          folder_id: 'f1',
        },
      ],
    });
    expect(result.disposition).toBe('halt');
    expect(result.reason).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(result.detail).toContain('nigeria-ppi-2020-data-analysis-tool.xlsx');
  });
});
