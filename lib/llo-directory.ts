/**
 * The Connect LLO Directory, as connect-labs reads it — for `skills/llo-directory-add`.
 *
 * connect-labs is the directory's real consumer, and its parser is the contract:
 * `connect_labs/marketplace/directory.py` names the sheet, the tabs and the
 * columns it requires, finds every column by HEADER TEXT, and refuses a tab that
 * is missing one. The sheet is maintained by hand, so columns move.
 *
 * Nothing about the layout is written down here. `parseDirectoryContract` reads
 * it out of the module's source, fetched from connect-labs `main` at run time
 * (`scripts/llo-directory.ts contract`). A copy of `ORG_COLUMNS` in ACE would be
 * one more plausible guess at a value another system owns (CLAUDE.md § Close the
 * loop to the source of truth) — exactly the drift this exists to avoid.
 *
 * Two rules ARE ported, because they are logic, not layout: `_header_key` (how
 * labs matches a header) and `_fold` (what labs counts as a near-duplicate org
 * name). Each port is guarded by `assertUpstreamRulesUnchanged`, which compares
 * the upstream function bodies against the bodies these were ported from and
 * refuses when they differ — so a changed upstream rule stops the skill instead
 * of letting ACE and labs quietly disagree. dimagi-internal/ace#2920.
 */

export const CONNECT_LABS_REPO = 'dimagi-internal/connect-labs';
export const DIRECTORY_MODULE = 'connect_labs/marketplace/directory.py';
export const QUALITY_MODULE = 'connect_labs/marketplace/quality.py';
export const IMPORT_COMMAND = 'connect_labs/marketplace/management/commands/marketplace_import.py';

export class DirectoryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryContractError';
  }
}

export interface DirectoryContract {
  directoryId: string;
  organizationsTab: string;
  contactsTab: string;
  /** The org-name header both tabs key on (`ORG_NAME`). */
  orgNameHeader: string;
  /** Organizations headers labs refuses to import without (`ORG_COLUMNS`). */
  orgColumns: string[];
  /** Optional Organizations header labs reads when present (`HQ_CITY`). */
  hqCityHeader: string;
  /** Contacts headers labs refuses to import without (`CONTACT_COLUMNS`). */
  contactColumns: string[];
  /** The tab labs reads each org's join date from (`DATES_TAB`). */
  datesTab: string;
  /** Dates-tab headers labs refuses to import without (`parse_dates`' `required=`). */
  datesColumns: string[];
  /** The dates-tab header whose cell labs keeps only when it fullmatches `_ISO_DATE`. */
  datesJoinedHeader: string;
  /** The remaining required dates-tab header: where that date came from (its basis). */
  datesBasisHeader: string;
  /** `_ISO_DATE`'s pattern source; a join date labs ignores unless it fullmatches this. */
  isoDatePattern: string;
}

/** Top-level `NAME = "literal"` assignments in a Python module. */
function stringConstants(py: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of py.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/** A top-level `NAME = ( ... )` tuple whose items are string literals or constant names. */
function stringTuple(py: string, name: string, constants: Map<string, string>): string[] {
  const m = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)^\\)`, 'm').exec(py);
  if (!m) throw new DirectoryContractError(`${DIRECTORY_MODULE} no longer defines ${name} as a tuple.`);
  const items: string[] = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/#.*$/, '').trim().replace(/,$/, '').trim();
    if (!line) continue;
    const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(line);
    if (lit) {
      items.push(lit[1]);
    } else if (constants.has(line)) {
      items.push(constants.get(line)!);
    } else {
      throw new DirectoryContractError(
        `${name} in ${DIRECTORY_MODULE} has an item this reader cannot resolve: ${line}. ` +
          `Read the module and extend parseDirectoryContract rather than guessing.`,
      );
    }
  }
  if (items.length === 0) throw new DirectoryContractError(`${name} in ${DIRECTORY_MODULE} is empty.`);
  return items;
}

/** The directory's layout, read out of connect-labs' `directory.py` source. Throws, naming the symbol, if any is gone. */
export function parseDirectoryContract(directoryPy: string): DirectoryContract {
  const constants = stringConstants(directoryPy);
  const need = (name: string): string => {
    const value = constants.get(name);
    if (!value) {
      throw new DirectoryContractError(
        `${DIRECTORY_MODULE} on main no longer defines ${name}. The directory contract moved; ` +
          `read the module and update lib/llo-directory.ts before writing to the sheet.`,
      );
    }
    return value;
  };
  const orgNameHeader = need('ORG_NAME');
  return {
    directoryId: need('DIRECTORY_ID'),
    organizationsTab: need('ORGANIZATIONS_TAB'),
    contactsTab: need('CONTACTS_TAB'),
    orgNameHeader,
    orgColumns: stringTuple(directoryPy, 'ORG_COLUMNS', constants),
    hqCityHeader: need('HQ_CITY'),
    contactColumns: stringTuple(directoryPy, 'CONTACT_COLUMNS', constants),
    datesTab: need('DATES_TAB'),
    ...parseDatesContract(directoryPy, constants, orgNameHeader),
  };
}

const PY_ITEM = /"((?:[^"\\]|\\.)*)"|\b([A-Z][A-Z0-9_]*)\b/g;

/** A string literal or a module constant, resolved; throws on anything else. */
function resolveItem(m: RegExpMatchArray, constants: Map<string, string>, where: string): string {
  if (m[1] !== undefined) return m[1];
  const value = constants.get(m[2]);
  if (value === undefined) {
    throw new DirectoryContractError(
      `${where} in ${DIRECTORY_MODULE} names ${m[2]}, which this reader cannot resolve. ` +
        `Read the module and extend parseDirectoryContract rather than guessing.`,
    );
  }
  return value;
}

/**
 * The dates tab's columns, read out of `parse_dates`: the `required=` headers of
 * its `Columns(rows, DATES_TAB, …)` call, which of them holds the join date (the
 * one whose variable goes through `_ISO_DATE.fullmatch`), and the basis column
 * (the one required header left). Each piece that is not where it was found
 * throws, naming it, so a reshaped parser stops the skill rather than being
 * guessed at.
 */
function parseDatesContract(
  py: string,
  constants: Map<string, string>,
  orgNameHeader: string,
): Pick<DirectoryContract, 'datesColumns' | 'datesJoinedHeader' | 'datesBasisHeader' | 'isoDatePattern'> {
  const moved = (what: string) =>
    new DirectoryContractError(
      `${DIRECTORY_MODULE} on main: ${what}. The dates-tab contract moved; read parse_dates and ` +
        `update lib/llo-directory.ts before writing to the sheet.`,
    );
  const iso = /^_ISO_DATE\s*=\s*re\.compile\(\s*r"((?:[^"\\]|\\.)*)"\s*\)/m.exec(py);
  if (!iso) throw moved('_ISO_DATE is no longer a re.compile(r"…") constant');
  const fn = pythonFunctionSource(py, 'parse_dates');
  if (fn === null) throw moved('parse_dates is gone');
  const call = /Columns\(\s*rows\s*,\s*DATES_TAB\s*,\s*required\s*=\s*\(([^)]*)\)/.exec(fn);
  if (!call) throw moved('parse_dates no longer reads Columns(rows, DATES_TAB, required=(…))');
  const datesColumns = [...call[1].matchAll(PY_ITEM)].map((m) => resolveItem(m, constants, 'parse_dates required='));
  if (!datesColumns.some((h) => headerKey(h) === headerKey(orgNameHeader))) {
    throw moved(`parse_dates no longer requires ${orgNameHeader}, so labs no longer joins dates on the org name`);
  }
  // variable -> header, from `a = cols.get(row, X)` and `a, b = cols.get(row, X), cols.get(row, Y)`.
  const header = new Map<string, string>();
  for (const line of fn.split('\n')) {
    const m = /^\s*([A-Za-z_][\w\s,]*?)\s*=\s*(cols\.get\(.*)$/.exec(line);
    if (!m) continue;
    const names = m[1].split(',').map((v) => v.trim());
    const gets = [...m[2].matchAll(/cols\.get\(\s*row\s*,\s*("(?:[^"\\]|\\.)*"|[A-Z][A-Z0-9_]*)\s*\)/g)];
    names.forEach((v, i) => {
      const item = gets[i] && [...gets[i][1].matchAll(PY_ITEM)][0];
      if (item) header.set(v, resolveItem(item, constants, 'parse_dates cols.get'));
    });
  }
  const checked = /_ISO_DATE\.fullmatch\(\s*(\w+)\s*\)/.exec(fn);
  const datesJoinedHeader = checked ? header.get(checked[1]) : undefined;
  if (!datesJoinedHeader || !datesColumns.includes(datesJoinedHeader)) {
    throw moved('parse_dates no longer checks one required column with _ISO_DATE.fullmatch');
  }
  const rest = datesColumns.filter((h) => h !== datesJoinedHeader && headerKey(h) !== headerKey(orgNameHeader));
  if (rest.length !== 1) throw moved(`parse_dates requires ${datesColumns.length} columns; this reader expects name, date and basis`);
  return { datesColumns, datesJoinedHeader, datesBasisHeader: rest[0], isoDatePattern: iso[1] };
}

// --- Ported rules, each guarded against its upstream source ------------------

/**
 * The code lines of each upstream function these ports were made from
 * (connect-labs 6ecaf66), whitespace-collapsed, docstring removed.
 */
const PORTED_FROM: Record<string, { module: string; body: string }> = {
  _header_key: {
    module: DIRECTORY_MODULE,
    body: [
      'text = re.sub(r"\\([^)]*\\)", " ", (title or "").lower())',
      'text = re.sub(r"[?:*]+", " ", text).replace("organisation", "organization")',
      'return re.sub(r"\\s+", " ", text).strip()',
    ].join(' '),
  },
  _fold: {
    module: QUALITY_MODULE,
    body: [
      'stripped = "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))',
      'return re.sub(r"\\s+", " ", stripped).strip().lower()',
    ].join(' '),
  },
};

/** A top-level Python function's body lines, as written (docstring included). */
function pythonFunctionSource(py: string, fn: string): string | null {
  const start = new RegExp(`^def ${fn}\\(.*\\).*:\\s*$`, 'm').exec(py);
  if (!start) return null;
  const rest = py.slice(start.index + start[0].length).split('\n');
  const body: string[] = [];
  for (const line of rest.slice(1)) {
    if (line.trim() && !/^\s/.test(line)) break; // dedent back to module level
    body.push(line);
  }
  return body.join('\n');
}

/** A Python function's code with its docstring dropped and whitespace collapsed. */
export function pythonFunctionBody(py: string, fn: string): string | null {
  const source = pythonFunctionSource(py, fn);
  if (source === null) return null;
  const text = source.replace(/^\s*("""|''')[\s\S]*?\1/, '');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Refuse when connect-labs changed a rule ACE ported. Pass the module sources
 * fetched from `main`. The fix for a refusal is to re-port the function here
 * and update its `PORTED_FROM` body, never to silence this.
 */
export function assertUpstreamRulesUnchanged(sources: Record<string, string>): void {
  for (const [fn, { module, body }] of Object.entries(PORTED_FROM)) {
    const src = sources[module];
    if (src === undefined) throw new DirectoryContractError(`No source supplied for ${module}.`);
    const live = pythonFunctionBody(src, fn);
    if (live === null) {
      throw new DirectoryContractError(`${module} on main no longer defines ${fn}; lib/llo-directory.ts ports it.`);
    }
    if (live !== body) {
      throw new DirectoryContractError(
        `${module} ${fn} changed on main, and lib/llo-directory.ts ports it. Re-port it and update ` +
          `PORTED_FROM before writing — otherwise ACE and labs disagree about the sheet.\n` +
          `  ported: ${body}\n  live:   ${live}`,
      );
    }
  }
}

/** Port of directory.py `_header_key`: case, spacing, a parenthetical note and `?:*` are not part of a header's name. */
export function headerKey(title: string): string {
  let text = (title || '').toLowerCase().replace(/\([^)]*\)/g, ' ');
  text = text.replace(/[?:*]+/g, ' ').replace(/organisation/g, 'organization');
  return text.replace(/\s+/g, ' ').trim();
}

/** Port of quality.py `_fold`: case, accents and whitespace folded away, for near-duplicate detection. */
export function fold(name: string): string {
  const stripped = (name || '').normalize('NFKD').replace(/\p{M}/gu, '');
  return stripped.replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- Header mapping ----------------------------------------------------------

/** Port of directory.py `column_letter`: 0-based column index → A1 letters. */
export function columnLetter(index: number): string {
  let letters = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** header key → 0-based position; the first header with a key wins, as in labs' `Columns`. */
export function headerIndex(headerRow: string[]): Map<string, number> {
  const index = new Map<string, number>();
  headerRow.forEach((title, position) => {
    const key = headerKey(title);
    if (key && !index.has(key)) index.set(key, position);
  });
  return index;
}

/** Throw, naming every one, when the live header row lacks a header labs requires. */
export function requireHeaders(headerRow: string[], required: string[], tab: string): void {
  const index = headerIndex(headerRow);
  const missing = required.filter((h) => !index.has(headerKey(h)));
  if (missing.length) {
    throw new DirectoryContractError(
      `The '${tab}' tab has no column headed ${missing.map((h) => JSON.stringify(h)).join(', ')}. ` +
        `labs would refuse to import it; do not write until the header is restored.`,
    );
  }
}

/**
 * One row's cells, placed by header. `fields` is keyed by header text (matched
 * with `headerKey`); a key matching no live header throws rather than being
 * dropped. The row spans the whole header width, blanks where nothing is known.
 */
export function buildRow(headerRow: string[], fields: Record<string, string>, tab: string): string[] {
  const index = headerIndex(headerRow);
  const row = headerRow.map(() => '');
  const unknown: string[] = [];
  for (const [header, value] of Object.entries(fields)) {
    const position = index.get(headerKey(header));
    if (position === undefined) unknown.push(header);
    else row[position] = value ?? '';
  }
  if (unknown.length) {
    throw new DirectoryContractError(
      `No column on the '${tab}' tab matches ${unknown.map((h) => JSON.stringify(h)).join(', ')}. ` +
        `Use the live header text.`,
    );
  }
  return row;
}

/** `Tab!A<n>:<last><n>` for a row the width of the header. */
export function rowRange(tab: string, headerRow: string[], row: number): string {
  return `'${tab.replace(/'/g, "''")}'!A${row}:${columnLetter(Math.max(headerRow.length, 1) - 1)}${row}`;
}

// --- Row arithmetic ----------------------------------------------------------

function blank(cell: unknown): boolean {
  return cell === undefined || cell === null || String(cell).trim() === '';
}

/**
 * The 1-based sheet row of the last non-blank cell in a single-column read.
 *
 * `values[i]` is sheet row `startRow + i` — the Sheets API returns rows, not a
 * count, and a read of `Tab!A:A` starts at row 1. The 2026-10-14 off-by-one came
 * from treating `values.length` (a count that includes the header) as if it were
 * a 0-based index. Returns `startRow - 1` for an all-blank column.
 */
export function lastFilledRow(values: unknown[][], startRow = 1): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (!blank(values[i]?.[0])) return startRow + i;
  }
  return startRow - 1;
}

/** The row to write: one past the real last filled row. Callers still confirm it is empty. */
export function nextEmptyRow(values: unknown[][], startRow = 1): number {
  return lastFilledRow(values, startRow) + 1;
}

/** True when every cell of a row read is blank (the Sheets API omits an empty row entirely). */
export function rowIsEmpty(rowRead: unknown[][]): boolean {
  return rowRead.every((r) => (r ?? []).every(blank));
}

// --- Duplicates and read-back ------------------------------------------------

/** A website reduced to its host: no scheme, no `www.`, no path, lower-case. */
export function websiteHost(url: string): string {
  return (url || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
}

export interface DuplicateHit {
  row: number;
  name: string;
  reason: 'folded-name' | 'website';
}

/**
 * Existing Organizations rows the candidate would duplicate. `folded-name` is
 * labs' own `near_duplicate_org` rule (quality.py `_fold`), so ACE and labs agree
 * on what a duplicate is; `website` is the same host on a differently-spelled name.
 */
export function findDuplicates(
  candidate: { name: string; website?: string },
  rows: { row: number; name: string; website?: string }[],
): DuplicateHit[] {
  const key = fold(candidate.name);
  const host = websiteHost(candidate.website ?? '');
  const hits: DuplicateHit[] = [];
  for (const r of rows) {
    if (!r.name) continue;
    if (fold(r.name) === key) hits.push({ row: r.row, name: r.name, reason: 'folded-name' });
    else if (host && websiteHost(r.website ?? '') === host) hits.push({ row: r.row, name: r.name, reason: 'website' });
  }
  return hits;
}

/** Cells whose read-back differs from what was written (trailing blanks are omitted by the API). */
export function diffReadBack(written: string[], readBack: unknown[][]): { column: string; wrote: string; read: string }[] {
  const got = (readBack[0] ?? []).map((c) => (c === undefined || c === null ? '' : String(c)));
  const out: { column: string; wrote: string; read: string }[] = [];
  written.forEach((wrote, i) => {
    const read = got[i] ?? '';
    if (wrote !== read) out.push({ column: columnLetter(i), wrote, read });
  });
  return out;
}

// --- Formula columns (dimagi-internal/ace#2957) -------------------------------
//
// Some columns of the hand-maintained sheet are FORMULAS, not data — on
// Organizations, the contact-email column is a TEXTJOIN(FILTER(Contacts!…)) over
// the Contacts tab. A RAW write of a value there replaces the formula with a
// frozen snapshot that never picks up a later contact. Which columns are
// formulas is the sheet's own fact, so it is read, never listed here: the
// precedent row (the last filled row) read with `--render FORMULA`.

/** 0-based column → formula, for every cell of a `--render FORMULA` row read that holds one. */
export function formulaColumns(precedentFormulaRow: unknown[]): Map<number, string> {
  const out = new Map<number, string>();
  (precedentFormulaRow ?? []).forEach((cell, i) => {
    if (typeof cell === 'string' && cell.startsWith('=')) out.set(i, cell);
  });
  return out;
}

/**
 * A formula copied from `fromRow` to `toRow` the way Sheets copies one: every
 * RELATIVE row reference shifts by the same offset. Absolute rows (`A$2`),
 * whole-column ranges (`E:E`), quoted strings and quoted sheet names are left
 * alone, and a function name such as `LOG10(` is not a cell reference.
 */
export function rowFormula(formula: string, fromRow: number, toRow: number): string {
  const delta = toRow - fromRow;
  const ref = /(^|[^A-Za-z0-9_.$])(\$?[A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g;
  const shift = (code: string) =>
    code.replace(ref, (all, pre: string, col: string, abs: string, row: string) => {
      if (abs) return all;
      const shifted = Number(row) + delta;
      if (shifted < 1) throw new DirectoryContractError(`Copying ${formula} to row ${toRow} moves ${col}${row} above row 1.`);
      return `${pre}${col}${shifted}`;
    });
  // Quoted segments ("…" strings, '…' sheet names, a doubled quote escapes) pass through; code shifts.
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const q = formula[i];
    if (q === '"' || q === "'") {
      let j = i + 1;
      while (j < formula.length && !(formula[j] === q && formula[j + 1] !== q)) j += formula[j] === q ? 2 : 1;
      out += formula.slice(i, j + 1);
      i = j + 1;
    } else {
      let j = i;
      while (j < formula.length && formula[j] !== '"' && formula[j] !== "'") j++;
      out += shift(formula.slice(i, j));
      i = j;
    }
  }
  return out;
}

export interface RowWrite {
  range: string;
  /** RAW for data (a `+234 …` phone must not parse as a formula); USER_ENTERED only for a copied formula. */
  input: 'RAW' | 'USER_ENTERED';
  values: string[][];
}

/**
 * The exact-range writes for one new row: one RAW write across the header width
 * (formula cells left blank), then one USER_ENTERED single-cell write per formula
 * column, carrying the precedent row's formula moved to the target row. Refuses a
 * drafted value in a formula column rather than overwrite the formula.
 */
export function planRowWrites(args: {
  tab: string;
  headerRow: string[];
  row: string[];
  targetRow: number;
  precedentRow: number;
  formulas: Map<number, string>;
}): RowWrite[] {
  const { tab, headerRow, row, targetRow, precedentRow, formulas } = args;
  const inRow = [...formulas.keys()].filter((i) => i < headerRow.length).sort((a, b) => a - b);
  const clash = inRow.filter((i) => (row[i] ?? '').trim() !== '');
  if (clash.length) {
    throw new DirectoryContractError(
      `On the '${tab}' tab, ${clash.map((i) => JSON.stringify(headerRow[i])).join(', ')} holds a formula ` +
        `(row ${precedentRow}). Leave it out of the drafted row; the formula is copied in.`,
    );
  }
  const quoted = `'${tab.replace(/'/g, "''")}'`;
  const writes: RowWrite[] = [{ range: rowRange(tab, headerRow, targetRow), input: 'RAW', values: [row] }];
  for (const i of inRow) {
    const cell = `${columnLetter(i)}${targetRow}`;
    writes.push({
      range: `${quoted}!${cell}:${cell}`,
      input: 'USER_ENTERED',
      values: [[rowFormula(formulas.get(i)!, precedentRow, targetRow)]],
    });
  }
  return writes;
}

/** The precedent's formulas, moved to `targetRow` — what each formula cell of the new row must read back as. */
export function expectedFormulas(formulas: Map<number, string>, precedentRow: number, targetRow: number): Map<number, string> {
  return new Map([...formulas].map(([i, f]) => [i, rowFormula(f, precedentRow, targetRow)]));
}

/**
 * `diffReadBack` for a row with formula columns: data cells compare against the
 * formatted read, formula cells against the `--render FORMULA` read (a formula's
 * computed value belongs to the tab it reads, not to what was written).
 */
export function diffRowReadBack(
  written: string[],
  formattedRead: unknown[][],
  expected: Map<number, string>,
  formulaRead: unknown[][],
): { column: string; wrote: string; read: string }[] {
  const cells = (read: unknown[][]) => (read[0] ?? []).map((c) => (c === undefined || c === null ? '' : String(c)));
  const formatted = cells(formattedRead);
  const formulas = cells(formulaRead);
  const out: { column: string; wrote: string; read: string }[] = [];
  written.forEach((value, i) => {
    const formula = expected.get(i);
    const wrote = formula ?? value;
    const read = (formula === undefined ? formatted[i] : formulas[i]) ?? '';
    if (wrote !== read) out.push({ column: columnLetter(i), wrote, read });
  });
  return out;
}

// --- Join date (the dates tab) ------------------------------------------------
//
// labs reads each org's join date from the dates tab, keyed on the org name, and
// `marketplace_import` stamps an org with NO dated row there with the day the
// import first sees it. On 2026-10-15 ACE added 19 ULAB EOI applicants with no
// dates row, so all 19 joined the network on 2026-10-16 instead of their own
// 2–7 October submission dates. The join date is the org's OWN submission date —
// for an EOI/RFP applicant the date of its earliest submission timestamp to that
// round, for an inbound lead the date the lead was submitted — never the day ACE
// writes the row and never the round's publication date.

/** The calendar date `YYYY-MM-DD`, rejecting a month or day that does not exist. */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

export interface JoinDateCheck {
  ok: boolean;
  /** The org's own submission date, or null when none is available. */
  submitted: string | null;
  joined: string;
  problems: string[];
  /** Set when there is no submission date: what the reply and approval summary must say. */
  missing?: string;
}

/**
 * Whether the drafted dates row's join date is the org's own submission date.
 * `submitted` is `YYYY-MM-DD`, or `none` when no submission date is available
 * (the date is then left blank, never guessed). `isoPattern` is labs' live
 * `_ISO_DATE` source: a date that does not fullmatch it is ignored by labs, which
 * would stamp the org with today all the same.
 */
export function checkJoinDate(args: { joined: string; submitted: string; today: string; isoPattern: string }): JoinDateCheck {
  const joined = (args.joined ?? '').trim();
  const submittedArg = (args.submitted ?? '').trim();
  if (submittedArg !== 'none' && !isCalendarDate(submittedArg)) {
    throw new DirectoryContractError(
      `--submitted must be the org's own submission date as YYYY-MM-DD, or "none" when there is no submission date; got ${JSON.stringify(args.submitted)}.`,
    );
  }
  const problems: string[] = [];
  if (submittedArg === 'none') {
    if (joined) problems.push(`The join date is ${joined} but there is no submission date. Leave it blank; a date with no source is a guess.`);
    return {
      ok: problems.length === 0,
      submitted: null,
      joined,
      problems,
      missing:
        'No submission date is available, so the join date is blank. labs will stamp the org with the day the import first sees it; say so, and fill the date if it turns up.',
    };
  }
  const submitted = submittedArg;
  if (submitted > args.today) problems.push(`The submission date ${submitted} is after today (${args.today}).`);
  if (!joined) {
    problems.push(`The join date is blank but the org submitted on ${submitted}. Write ${submitted}, or labs stamps it with the import day.`);
  } else if (joined !== submitted) {
    problems.push(
      joined === args.today
        ? `The join date ${joined} is today, the day ACE writes the row, not the org's own submission date (${submitted}).`
        : `The join date ${joined} is not the org's own submission date (${submitted}).`,
    );
  }
  if (joined && !(new RegExp(`^(?:${args.isoPattern})$`).test(joined) && isCalendarDate(joined))) {
    problems.push(`The join date ${JSON.stringify(joined)} is not an ISO date labs reads; labs would ignore it and stamp the import day.`);
  }
  return { ok: problems.length === 0, submitted, joined, problems };
}
