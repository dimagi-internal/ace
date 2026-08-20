/**
 * Do the scoring constants in a digitised `[FIXED]` instrument match the
 * published source that fixes them?
 *
 * Why this exists (dimagi-internal/ace#1527). On
 * `hh-poverty-targeting/20260819-1435` the Deliver app digitised the official
 * Nigeria PPI 2020 scorecard — a `[FIXED]` instrument whose workbook sat in
 * the run's own frozen `inputs/` — and **every scoring constant was invented**:
 * 9 of 17 point values wrong, and all 101 poverty-likelihood values placed by
 * shape rather than transcribed.
 *
 * Nothing caught it, because every gate on the path is structurally blind to
 * constant VALUES:
 *
 *  - `validate_app` (Nova) validates expression structure and references, not
 *    whether a literal matches a published table;
 *  - `pdd-to-deliver-app-eval` grades the build against the PDD, which
 *    describes the instrument narratively — a wrong constant is
 *    PDD-conformant prose;
 *  - `app-release-qa` checks form counts, Connect markers and install-time
 *    behaviour, not arithmetic;
 *  - the architect brief carries the point values as PROSE, so the architect
 *    transcribes from a model-authored brief rather than from the workbook.
 *
 * A wrong scorecard produces a complete, plausible, fully-verified dataset
 * that ranks the wrong households, and every Evidence Model control passes it.
 * There is no downstream symptom. (The PPI licence also permits digitising the
 * scorecard and its lookup tables only UNMODIFIED, so this is a compliance
 * question as well as a quality one.)
 *
 * ## The extraction is itself a hazard — hence `assertExtractionTrusted`
 *
 * The first repair-round extraction of the lookup table produced
 * `score 4 -> 79.0`: a header row leaking in, because shared strings had not
 * been decoded in the `.xlsx`. An `xlsx` cell carrying `t="s"` stores an INDEX
 * into `xl/sharedStrings.xml`, and that index is a perfectly plausible number.
 * Read undecoded, a header cell becomes a datum and the series still looks like
 * a table. So `readXlsxColumn` decodes `t="s"` THROUGH sharedStrings and never
 * returns an unresolved index as a number, and an extracted series is only an
 * oracle once `assertExtractionTrusted` has cleared it on three independent
 * assertions: endpoints, strict monotonicity, and row count.
 *
 * ## Second-order symptom: a dead clamp
 *
 * The built instrument's maximum was 96, not the official 102. The PDD mandates
 * a `min(ppi_score, 100)` clamp precisely because the official values overshoot
 * the 100-row lookup — so the clamp was dead code, and the overshoot condition
 * the PDD wants observable could never fire. `compareMaxScore` encodes that:
 * an instrument that cannot reach its own clamp is announcing that its
 * constants are not the published ones.
 *
 * Pure — no network, no filesystem, no Drive. The caller fetches the bytes
 * (`drive_download_binary` + `writeToPath`) and reads the built literals from
 * Nova; this module only compares.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * A cell value. `string` is deliberate and load-bearing: a `t="s"` index that
 * could not be resolved is returned as a STRING so it can never be mistaken
 * for a datum (ace#1527 — `score 4 -> 79.0`).
 */
export type CellValue = number | string | null;

export type ExtractionProblemKind =
  /** The bytes are not a readable xlsx package. */
  | 'unreadable-workbook'
  /** The named/indexed worksheet is not in the package. */
  | 'sheet-not-found'
  /** A `t="s"` cell's index is not in `xl/sharedStrings.xml`. */
  | 'unresolved-shared-string'
  /** A row in the requested range carries no cell in the requested column. */
  | 'missing-cell';

export interface ExtractionProblem {
  kind: ExtractionProblemKind;
  detail: string;
  row?: number;
}

export interface XlsxCell {
  /** 1-based worksheet row. */
  row: number;
  /** The cell reference as written, e.g. `D11`. */
  ref: string;
  /** The `t` attribute as written (`''` when absent, i.e. numeric). */
  type: string;
  /** The literal `<v>` text, BEFORE sharedStrings decoding. */
  raw: string | null;
  /** The decoded value. */
  value: CellValue;
}

export interface XlsxColumnResult {
  /** One entry per row in `[firstRow, lastRow]`, in order. */
  values: CellValue[];
  cells: XlsxCell[];
  /** The zip entry the values were read from, or `null` when not found. */
  sheetPath: string | null;
  sharedStringCount: number;
  problems: ExtractionProblem[];
}

export interface ReadXlsxColumnOptions {
  /**
   * Worksheet to read: a 1-based index, or the sheet's display NAME as it
   * appears in `xl/workbook.xml`. Defaults to the first worksheet.
   */
  sheet?: number | string;
  /** Column letter(s), e.g. `'D'` or `'AB'`. Case-insensitive. */
  column: string;
  /** First worksheet row to read, 1-based and inclusive. */
  firstRow: number;
  /** Last worksheet row to read, 1-based and inclusive. */
  lastRow: number;
}

/** xmldom's Document is structurally narrower than the DOM lib's; cast once. */
function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

/** Every element in the document with this local name, namespace-agnostic. */
function elementsByLocalName(root: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as unknown as Element;
    const local = el.localName ?? el.nodeName.replace(/^.*:/, '');
    if (local === name) out.push(el);
  }
  return out;
}

function firstChildTextByLocalName(el: Element, name: string): string | null {
  for (const child of elementsByLocalName(el, name)) {
    return child.textContent ?? '';
  }
  return null;
}

/**
 * `xl/sharedStrings.xml` -> the string table, in index order.
 *
 * An `<si>` may be a single `<t>` or a run of `<r><t>` fragments; phonetic
 * `<rPh>` runs are not part of the displayed string and are skipped.
 */
export function parseSharedStrings(xml: string): string[] {
  const doc = parseXml(xml);
  return elementsByLocalName(doc, 'si').map((si) => {
    let text = '';
    for (const t of elementsByLocalName(si, 't')) {
      let node: Node | null = t.parentNode;
      let phonetic = false;
      while (node && node !== si) {
        const local =
          (node as Element).localName ?? node.nodeName.replace(/^.*:/, '');
        if (local === 'rPh') {
          phonetic = true;
          break;
        }
        node = node.parentNode;
      }
      if (!phonetic) text += t.textContent ?? '';
    }
    return text;
  });
}

/** Resolve the zip entry for the requested worksheet. */
function resolveSheetPath(
  entries: Record<string, Uint8Array>,
  sheet: number | string | undefined,
): { path: string | null; detail: string } {
  const worksheets = Object.keys(entries)
    .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb || a.localeCompare(b);
    });

  if (worksheets.length === 0) {
    return { path: null, detail: 'the package contains no xl/worksheets/*.xml entry' };
  }

  if (typeof sheet === 'string') {
    const workbookXml = entries['xl/workbook.xml'];
    if (!workbookXml) {
      return { path: null, detail: 'no xl/workbook.xml, so a sheet NAME cannot be resolved' };
    }
    const doc = parseXml(strFromU8(workbookXml));
    const decl = elementsByLocalName(doc, 'sheet').find(
      (s) => s.getAttribute('name') === sheet,
    );
    if (!decl) {
      const names = elementsByLocalName(doc, 'sheet')
        .map((s) => s.getAttribute('name'))
        .join(', ');
      return { path: null, detail: `no sheet named "${sheet}" (workbook declares: ${names})` };
    }
    const rid =
      decl.getAttribute('r:id') ?? decl.getAttribute('id') ?? decl.getAttribute('relId');
    const relsXml = entries['xl/_rels/workbook.xml.rels'];
    if (rid && relsXml) {
      const rels = parseXml(strFromU8(relsXml));
      const rel = elementsByLocalName(rels, 'Relationship').find(
        (r) => r.getAttribute('Id') === rid,
      );
      const target = rel?.getAttribute('Target');
      if (target) {
        const path = target.startsWith('/')
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, '')}`;
        if (entries[path]) return { path, detail: '' };
      }
    }
    // Fall back to positional order, which is how single-sheet workbooks and
    // most generators lay out anyway.
    const index = elementsByLocalName(doc, 'sheet').indexOf(decl);
    const path = worksheets[index];
    return path
      ? { path, detail: '' }
      : { path: null, detail: `sheet "${sheet}" declared but its part is missing` };
  }

  const index = (typeof sheet === 'number' ? sheet : 1) - 1;
  if (index < 0 || index >= worksheets.length) {
    return {
      path: null,
      detail: `sheet index ${index + 1} is outside the ${worksheets.length} worksheet(s) in the package`,
    };
  }
  const numbered = `xl/worksheets/sheet${index + 1}.xml`;
  return { path: entries[numbered] ? numbered : worksheets[index], detail: '' };
}

/**
 * Read one column of one worksheet out of an `.xlsx` package.
 *
 * **`t="s"` cells are decoded THROUGH `xl/sharedStrings.xml`.** An index that
 * does not resolve is returned as its raw text as a STRING and recorded as an
 * `unresolved-shared-string` problem — never coerced to a number. That single
 * rule is what stops a header row from becoming `score 4 -> 79.0` (ace#1527).
 */
export function readXlsxColumn(
  bytes: Uint8Array,
  options: ReadXlsxColumnOptions,
): XlsxColumnResult {
  const problems: ExtractionProblem[] = [];
  const column = options.column.toUpperCase();
  const { firstRow, lastRow } = options;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    return {
      values: [],
      cells: [],
      sheetPath: null,
      sharedStringCount: 0,
      problems: [
        {
          kind: 'unreadable-workbook',
          detail: `fflate could not open the bytes as a zip package: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }

  const sharedStrings = entries['xl/sharedStrings.xml']
    ? parseSharedStrings(strFromU8(entries['xl/sharedStrings.xml']))
    : [];

  const { path: sheetPath, detail } = resolveSheetPath(entries, options.sheet);
  if (!sheetPath) {
    return {
      values: [],
      cells: [],
      sheetPath: null,
      sharedStringCount: sharedStrings.length,
      problems: [{ kind: 'sheet-not-found', detail }],
    };
  }

  const doc = parseXml(strFromU8(entries[sheetPath]));
  const refPattern = new RegExp(`^${column}(\\d+)$`);
  const byRow = new Map<number, XlsxCell>();

  for (const c of elementsByLocalName(doc, 'c')) {
    const ref = c.getAttribute('r') ?? '';
    const m = refPattern.exec(ref);
    if (!m) continue;
    const row = Number(m[1]);
    if (row < firstRow || row > lastRow) continue;

    const type = c.getAttribute('t') ?? '';
    const raw = firstChildTextByLocalName(c, 'v');
    let value: CellValue;

    if (type === 's') {
      // The whole point. The `<v>` here is an INDEX, not a datum.
      const index = Number(raw);
      if (raw !== null && Number.isInteger(index) && index >= 0 && index < sharedStrings.length) {
        value = sharedStrings[index];
      } else {
        value = raw ?? '';
        problems.push({
          kind: 'unresolved-shared-string',
          row,
          detail:
            `${ref} carries t="s" with index ${raw ?? '(none)'}, which is not in the ` +
            `${sharedStrings.length}-entry shared-string table. Returned as the string ` +
            `"${value}" — an undecoded index is a header leak, not a value (ace#1527).`,
        });
      }
    } else if (type === 'inlineStr') {
      const is = elementsByLocalName(c, 'is')[0];
      value = is ? (is.textContent ?? '') : '';
    } else if (type === 'str' || type === 'e' || type === 'b') {
      value = raw ?? '';
    } else if (raw === null || raw.trim() === '') {
      value = null;
    } else {
      const n = Number(raw);
      value = Number.isFinite(n) ? n : raw;
    }

    byRow.set(row, { row, ref, type, raw, value });
  }

  const cells: XlsxCell[] = [];
  const values: CellValue[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const cell = byRow.get(row);
    if (cell) {
      cells.push(cell);
      values.push(cell.value);
    } else {
      cells.push({ row, ref: `${column}${row}`, type: '', raw: null, value: null });
      values.push(null);
      problems.push({
        kind: 'missing-cell',
        row,
        detail: `${column}${row} is empty or absent in ${sheetPath}`,
      });
    }
  }

  return { values, cells, sheetPath, sharedStringCount: sharedStrings.length, problems };
}

// ---------------------------------------------------------------------------
// Trusting the extraction
// ---------------------------------------------------------------------------

export type ExtractionFailureKind =
  /** First or last value does not match the declared endpoint. */
  | 'endpoint'
  /** The series is not strictly monotonic in the declared direction. */
  | 'monotonicity'
  /** The series is not the declared length. */
  | 'row-count'
  /** A cell in the series is not a number at all (the header-leak signature). */
  | 'non-numeric';

export interface ExtractionFailure {
  kind: ExtractionFailureKind;
  detail: string;
  /** Index into the series, where the failure is positional. */
  index?: number;
}

export interface ExtractionVerdict {
  trusted: boolean;
  failures: ExtractionFailure[];
  /** Direction the monotonicity assertion was run in. */
  direction: 'ascending' | 'descending';
}

export interface ExtractionExpectations {
  /** The value the source document itself states for the first row. */
  expectedFirst: number;
  /** The value the source document itself states for the last row. */
  expectedLast: number;
  /** How many rows the source document says the table has. */
  expectedRowCount: number;
  /** Absolute tolerance on the endpoint comparison. Default 1e-9. */
  tolerance?: number;
  /** Override the direction inferred from the endpoints. */
  direction?: 'ascending' | 'descending';
}

/**
 * Three INDEPENDENT assertions — all three always run, so a caller sees every
 * way the extraction is wrong rather than the first one.
 *
 * `trusted: false` means the series must not be used as an oracle. There is no
 * partial credit here: an unchecked extraction is a second way to ship a wrong
 * instrument while reporting success (ace#1527).
 */
export function assertExtractionTrusted(
  series: readonly CellValue[],
  expectations: ExtractionExpectations,
): ExtractionVerdict {
  const tolerance = expectations.tolerance ?? 1e-9;
  const direction =
    expectations.direction ??
    (expectations.expectedFirst >= expectations.expectedLast ? 'descending' : 'ascending');
  const failures: ExtractionFailure[] = [];

  // (1) Row count.
  if (series.length !== expectations.expectedRowCount) {
    failures.push({
      kind: 'row-count',
      detail:
        `extracted ${series.length} rows, the source declares ` +
        `${expectations.expectedRowCount}`,
    });
  }

  // (2) Endpoints. A non-numeric endpoint is BOTH a non-numeric finding and an
  // endpoint finding — it is exactly the header-leak shape.
  const checkEndpoint = (index: number, expected: number, label: string) => {
    const actual = series[index];
    if (typeof actual !== 'number' || !Number.isFinite(actual)) {
      failures.push({
        kind: 'endpoint',
        index,
        detail:
          `${label} endpoint is ${JSON.stringify(actual)}, not a number — the source ` +
          `declares ${expected}. A non-numeric endpoint is the header-leak signature.`,
      });
      return;
    }
    if (Math.abs(actual - expected) > tolerance) {
      failures.push({
        kind: 'endpoint',
        index,
        detail: `${label} endpoint is ${actual}, the source declares ${expected}`,
      });
    }
  };
  if (series.length === 0) {
    failures.push({ kind: 'endpoint', detail: 'the extracted series is empty' });
  } else {
    checkEndpoint(0, expectations.expectedFirst, 'first');
    checkEndpoint(series.length - 1, expectations.expectedLast, 'last');
  }

  // (3) Strict monotonicity, plus the non-numeric scan it depends on.
  let previous: number | null = null;
  for (let i = 0; i < series.length; i++) {
    const value = series[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      failures.push({
        kind: 'non-numeric',
        index: i,
        detail: `row ${i} is ${JSON.stringify(value)}, not a number`,
      });
      failures.push({
        kind: 'monotonicity',
        index: i,
        detail:
          `row ${i} is ${JSON.stringify(value)}, so the series cannot be shown ` +
          `strictly ${direction}`,
      });
      previous = null;
      continue;
    }
    if (previous !== null) {
      const ok = direction === 'descending' ? value < previous : value > previous;
      if (!ok) {
        failures.push({
          kind: 'monotonicity',
          index: i,
          detail: `row ${i} is ${value}, which is not strictly ${direction} from ${previous}`,
        });
      }
    }
    previous = value;
  }

  return { trusted: failures.length === 0, failures, direction };
}

// ---------------------------------------------------------------------------
// Diffing the built constants against the source
// ---------------------------------------------------------------------------

/** Flat `key -> point value` table, as read from the source and from the build. */
export type ScoringTable = Readonly<Record<string, number>>;

export interface ScoringMismatch {
  key: string;
  source: number;
  built: number;
}

export interface ScoringDiff {
  mismatches: ScoringMismatch[];
  /** Keys the source fixes that the build never shipped. */
  missingInBuild: string[];
  /** Keys the build shipped that the source does not fix — invented constants. */
  extraInBuild: string[];
  /** Convenience: `mismatches.length + missingInBuild.length + extraInBuild.length`. */
  total: number;
}

/**
 * Every difference between the published table and the built literals.
 *
 * Order is deterministic: source key order for `mismatches`/`missingInBuild`,
 * built key order for `extraInBuild`, so a memo diff is stable run to run.
 */
export function diffScoringConstants(input: {
  source: ScoringTable;
  built: ScoringTable;
  /** Absolute tolerance. Default 0 — these are published integers. */
  tolerance?: number;
}): ScoringDiff {
  const tolerance = input.tolerance ?? 0;
  const mismatches: ScoringMismatch[] = [];
  const missingInBuild: string[] = [];

  for (const key of Object.keys(input.source)) {
    if (!Object.prototype.hasOwnProperty.call(input.built, key)) {
      missingInBuild.push(key);
      continue;
    }
    const source = input.source[key];
    const built = input.built[key];
    if (!(Math.abs(source - built) <= tolerance)) {
      mismatches.push({ key, source, built });
    }
  }

  const extraInBuild = Object.keys(input.built).filter(
    (key) => !Object.prototype.hasOwnProperty.call(input.source, key),
  );

  return {
    mismatches,
    missingInBuild,
    extraInBuild,
    total: mismatches.length + missingInBuild.length + extraInBuild.length,
  };
}

// ---------------------------------------------------------------------------
// The self-concealing second-order symptom: a clamp that can never fire
// ---------------------------------------------------------------------------

/**
 * `indicator -> { option -> points }`. The maximum attainable score is the sum
 * of each indicator's best option, so the grouping is required — a flat sum
 * over every option is not a score any respondent can obtain.
 */
export type IndicatorTable = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface IndicatorMax {
  indicator: string;
  sourceMax: number;
  builtMax: number;
}

export interface MaxScoreComparison {
  sourceMax: number;
  builtMax: number;
  /** The ceiling the PDD's `min(score, N)` clamp applies. Default 100. */
  clampAt: number;
  /**
   * TRUE when the BUILT instrument cannot reach the clamp, so `min(score, N)`
   * is dead code and the overshoot condition the PDD wants observable can
   * never fire (ace#1527).
   */
  clampDead: boolean;
  /** TRUE when the SOURCE instrument can exceed the clamp — i.e. it is needed. */
  clampReachableInSource: boolean;
  /** `builtMax - sourceMax`. Negative means the build under-scores. */
  delta: number;
  perIndicator: IndicatorMax[];
}

function maxOf(options: Readonly<Record<string, number>> | undefined): number {
  const values = Object.values(options ?? {});
  return values.length === 0 ? 0 : Math.max(...values);
}

/**
 * Compare attainable maxima, and say whether the PDD's clamp is dead code.
 *
 * The built Nigeria PPI 2020 maxed at 96 against an official 102 (ace#1527).
 * The PDD mandates `min(ppi_score, 100)` precisely BECAUSE the official values
 * overshoot the 100-row lookup — so a build that cannot reach 100 is not
 * merely under-scoring, it is announcing that its constants are not the
 * published ones, and the instrument stays internally consistent with its own
 * wrong numbers.
 */
export function compareMaxScore(input: {
  sourcePoints: IndicatorTable;
  builtPoints: IndicatorTable;
  clampAt?: number;
}): MaxScoreComparison {
  const clampAt = input.clampAt ?? 100;
  const indicators = [
    ...Object.keys(input.sourcePoints),
    ...Object.keys(input.builtPoints).filter(
      (k) => !Object.prototype.hasOwnProperty.call(input.sourcePoints, k),
    ),
  ];

  const perIndicator: IndicatorMax[] = indicators.map((indicator) => ({
    indicator,
    sourceMax: maxOf(input.sourcePoints[indicator]),
    builtMax: maxOf(input.builtPoints[indicator]),
  }));

  const sourceMax = perIndicator.reduce((a, i) => a + i.sourceMax, 0);
  const builtMax = perIndicator.reduce((a, i) => a + i.builtMax, 0);

  return {
    sourceMax,
    builtMax,
    clampAt,
    clampDead: builtMax <= clampAt,
    clampReachableInSource: sourceMax > clampAt,
    delta: builtMax - sourceMax,
    perIndicator,
  };
}
