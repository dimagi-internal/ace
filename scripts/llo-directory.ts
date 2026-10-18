#!/usr/bin/env -S npx tsx
/**
 * llo-directory — the script half of `skills/llo-directory-add` (dimagi-internal/ace#2920).
 *
 * Every subcommand reads connect-labs `main` FIRST — the sheet id, tab names and
 * required columns come from `connect_labs/marketplace/directory.py` at run time,
 * never from ACE — then reads the live sheet as ACE's gog identity. `contract`,
 * `plan` and `verify` only read. `apply` is the one writer, and runs only after the
 * operator approved the plan.
 *
 *   npx tsx scripts/llo-directory.ts contract
 *   npx tsx scripts/llo-directory.ts plan   --org org.json --contact contact.json --dates dates.json --submitted 2026-10-05
 *   npx tsx scripts/llo-directory.ts apply  --org org.json --contact contact.json --dates dates.json --submitted 2026-10-05
 *   npx tsx scripts/llo-directory.ts verify --org org.json --org-row 242 --contact contact.json --contact-row 205 --dates dates.json --dates-row 261
 *
 * `org.json` / `contact.json` / `dates.json` map LIVE header text → cell value, e.g.
 * `{"Organization Name": "…", "Website": "…"}`. Unknown headers are refused, and
 * so is a value for a column the sheet fills with a formula (ace#2957).
 *
 * `dates.json` is the org's row on the dates tab (connect-labs `DATES_TAB`): labs
 * reads the join date from there, and stamps an org with no dated row with the day
 * its import first sees it. `--submitted` is the org's OWN submission date — the
 * earliest submission timestamp's date for an EOI/RFP applicant, the lead's
 * submission date for an inbound lead — or `none` when there is none. `plan`
 * refuses a join date that is not that date (today's date included).
 *
 * `apply` re-plans, refuses unless `ready`, runs the writes as argument arrays
 * (`execFileSync`, no shell — a note containing `"` or `\` reaches the sheet
 * verbatim; ace#2956), then verifies both rows itself.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGogIdentity } from '../lib/gog-identity.js';
import {
  CONNECT_LABS_REPO,
  DIRECTORY_MODULE,
  IMPORT_COMMAND,
  QUALITY_MODULE,
  assertUpstreamRulesUnchanged,
  buildRow,
  checkJoinDate,
  columnLetter,
  diffRowReadBack,
  expectedFormulas,
  findDuplicates,
  fold,
  formulaColumns,
  headerIndex,
  headerKey,
  nextEmptyRow,
  parseDirectoryContract,
  planRowWrites,
  requireHeaders,
  rowIsEmpty,
  rowRange,
  type DirectoryContract,
  type RowWrite,
} from '../lib/llo-directory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Deps {
  /** Run one command with an argument array — never a shell. */
  exec: (cmd: string, args: string[]) => string;
  identity: () => { account: string; client: string };
  log: (line: string) => void;
  /** Today's date, YYYY-MM-DD — the day ACE writes, which a join date must not default to. */
  today: () => string;
}

const defaultDeps: Deps = {
  exec: (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }),
  identity: () => resolveGogIdentity({ repoRoot: REPO_ROOT }),
  log: (line) => console.log(line),
  today: () => new Date().toLocaleDateString('en-CA'),
};

/** The `gog sheets update` argument array for one exact-range write. */
export function gogUpdateArgs(id: string, w: RowWrite, who: { account: string; client: string }): string[] {
  return ['sheets', 'update', id, w.range, '--values-json', JSON.stringify(w.values), '--input', w.input, '-a', who.account, '--client', who.client];
}

const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

function readJson(file: string | undefined, flag: string): Record<string, string> {
  if (!file) throw new Error(`${flag} <file.json> is required`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fieldFor(fields: Record<string, string>, header: string): string {
  const hit = Object.entries(fields).find(([k]) => headerKey(k) === headerKey(header));
  return hit ? hit[1] : '';
}

export function main(argv: string[], deps: Deps = defaultDeps): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  /** Reads only, so a retry cannot double-write; this network drops TLS handshakes. */
  const read = (cmd: string, args: string[]): string => {
    for (let attempt = 1; ; attempt++) {
      try {
        return deps.exec(cmd, args);
      } catch (err) {
        if (attempt >= 3) throw err;
      }
    }
  };
  const fetchUpstream = (file: string) =>
    read('gh', ['api', `repos/${CONNECT_LABS_REPO}/contents/${file}?ref=main`, '-H', 'Accept: application/vnd.github.raw']);
  const liveContract = (): { contract: DirectoryContract; sha: string } => {
    const sha = read('gh', ['api', `repos/${CONNECT_LABS_REPO}/commits/main`, '--jq', '.sha']).trim();
    const directoryPy = fetchUpstream(DIRECTORY_MODULE);
    const qualityPy = fetchUpstream(QUALITY_MODULE);
    fetchUpstream(IMPORT_COMMAND); // must still exist: the reply names it as the path into labs
    assertUpstreamRulesUnchanged({ [DIRECTORY_MODULE]: directoryPy, [QUALITY_MODULE]: qualityPy });
    return { contract: parseDirectoryContract(directoryPy), sha };
  };
  const sheetGet = (id: string, range: string, render: 'FORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE'): string[][] => {
    const { account, client } = deps.identity();
    const out = read('gog', ['sheets', 'get', id, range, '-a', account, '--client', client, '-j', '--results-only', '--render', render]).trim();
    const parsed = out ? JSON.parse(out) : [];
    return Array.isArray(parsed) ? parsed : (parsed.values ?? []);
  };
  const print = (obj: unknown) => deps.log(JSON.stringify(obj, null, 2));

  const cmd = argv[0];
  const { contract, sha } = liveContract();
  const id = contract.directoryId;
  const orgTab = contract.organizationsTab;
  const contactTab = contract.contactsTab;
  const datesTab = contract.datesTab;

  if (cmd === 'contract') {
    print({ connectLabsSha: sha, ...contract });
    return 0;
  }

  const orgFields = readJson(arg('--org'), '--org');
  const contactFields = readJson(arg('--contact'), '--contact');
  // Every org this skill adds gets its join date written too; there is no run without it.
  const datesFields = readJson(arg('--dates'), '--dates');
  const orgHeader = sheetGet(id, `${quoteTab(orgTab)}!1:1`)[0] ?? [];
  const contactHeader = sheetGet(id, `${quoteTab(contactTab)}!1:1`)[0] ?? [];
  const datesHeader = sheetGet(id, `${quoteTab(datesTab)}!1:1`)[0] ?? [];
  requireHeaders(orgHeader, [...contract.orgColumns], orgTab);
  requireHeaders(contactHeader, [...contract.contactColumns], contactTab);
  requireHeaders(datesHeader, [...contract.datesColumns], datesTab);
  const orgRow = buildRow(orgHeader, orgFields, orgTab);
  const contactRow = buildRow(contactHeader, contactFields, contactTab);
  const datesRow = buildRow(datesHeader, datesFields, datesTab);

  /** Formula columns of `tab`, read from the row above `target` (the precedent). Header row has none. */
  const formulasAbove = (tab: string, header: string[], target: number) =>
    target > 2 ? formulaColumns(sheetGet(id, rowRange(tab, header, target - 1), 'FORMULA')[0] ?? []) : new Map<number, string>();

  const verify = (orgN: number, contactN: number, datesN: number) => {
    const check = (tab: string, header: string[], row: string[], n: number) =>
      diffRowReadBack(
        row,
        sheetGet(id, rowRange(tab, header, n)),
        expectedFormulas(formulasAbove(tab, header, n), n - 1, n),
        sheetGet(id, rowRange(tab, header, n), 'FORMULA'),
      );
    const orgDiff = check(orgTab, orgHeader, orgRow, orgN);
    const contactDiff = check(contactTab, contactHeader, contactRow, contactN);
    const datesDiff = check(datesTab, datesHeader, datesRow, datesN);
    return {
      ok: orgDiff.length === 0 && contactDiff.length === 0 && datesDiff.length === 0,
      organizations: { row: orgN, diff: orgDiff },
      contacts: { row: contactN, diff: contactDiff },
      dates: { row: datesN, diff: datesDiff },
    };
  };

  if (cmd === 'plan' || cmd === 'apply') {
    const name = fieldFor(orgFields, contract.orgNameHeader);
    if (!name) throw new Error(`--org must set "${contract.orgNameHeader}"`);
    if (headerKey(fieldFor(contactFields, contract.orgNameHeader)) !== headerKey(name)) {
      throw new Error(`The contact's "${contract.orgNameHeader}" must equal the org row's, or labs cannot join them.`);
    }
    // labs looks the join date up by the exact org name (`dates.get(row.name)`), so no folding here.
    if (fieldFor(datesFields, contract.orgNameHeader).trim() !== name.trim()) {
      throw new Error(`The dates row's "${contract.orgNameHeader}" must equal the org row's exactly, or labs never finds the join date.`);
    }
    const submitted = arg('--submitted');
    if (!submitted) throw new Error('--submitted <YYYY-MM-DD|none> is required: the org\'s own submission date, or none');
    const joinDate = checkJoinDate({
      joined: fieldFor(datesFields, contract.datesJoinedHeader),
      submitted,
      today: deps.today(),
      isoPattern: contract.isoDatePattern,
    });
    if (!fieldFor(datesFields, contract.datesBasisHeader).trim()) {
      joinDate.ok = false;
      joinDate.problems.push(`"${contract.datesBasisHeader}" is blank; say where the date came from, following the precedent rows.`);
    }

    // The whole Organizations tab, for the duplicate check by labs' own fold.
    const orgAll = sheetGet(id, `${quoteTab(orgTab)}!A:ZZ`);
    const idx = headerIndex(orgHeader);
    const nameCol = idx.get(headerKey(contract.orgNameHeader))!;
    const siteCol = idx.get(headerKey('Website'));
    const existing = orgAll.slice(1).map((r, i) => ({
      row: i + 2,
      name: String(r[nameCol] ?? '').trim(),
      website: siteCol === undefined ? '' : String(r[siteCol] ?? ''),
    }));
    const duplicates = findDuplicates({ name, website: fieldFor(orgFields, 'Website') }, existing);

    // Target rows from the real last filled row of each tab's name column.
    const orgTarget = nextEmptyRow(orgAll.map((r) => [r[nameCol]]));
    const cIdx = headerIndex(contactHeader).get(headerKey(contract.contactColumns[0]))!;
    const contactTarget = nextEmptyRow(sheetGet(id, `${quoteTab(contactTab)}!A:ZZ`).map((r) => [r[cIdx]]));
    const dIdx = headerIndex(datesHeader).get(headerKey(contract.orgNameHeader))!;
    const datesAll = sheetGet(id, `${quoteTab(datesTab)}!A:ZZ`);
    const datesTarget = nextEmptyRow(datesAll.map((r) => [r[dIdx]]));
    // A dates row already naming this org (labs keeps the last one) is the sheet owner's to resolve.
    const existingDates = datesAll
      .map((r, i) => ({ row: i + 1, name: String(r[dIdx] ?? '').trim() }))
      .filter((r) => r.row > 1 && r.name && fold(r.name) === fold(name));

    const orgRange = rowRange(orgTab, orgHeader, orgTarget);
    const contactRange = rowRange(contactTab, contactHeader, contactTarget);
    const orgEmpty = rowIsEmpty(sheetGet(id, orgRange));
    const contactEmpty = rowIsEmpty(sheetGet(id, contactRange));
    const datesRange = rowRange(datesTab, datesHeader, datesTarget);
    const datesEmpty = rowIsEmpty(sheetGet(id, datesRange));
    const writes = [
      ...planRowWrites({ tab: orgTab, headerRow: orgHeader, row: orgRow, targetRow: orgTarget, precedentRow: orgTarget - 1, formulas: formulasAbove(orgTab, orgHeader, orgTarget) }),
      ...planRowWrites({ tab: contactTab, headerRow: contactHeader, row: contactRow, targetRow: contactTarget, precedentRow: contactTarget - 1, formulas: formulasAbove(contactTab, contactHeader, contactTarget) }),
      ...planRowWrites({ tab: datesTab, headerRow: datesHeader, row: datesRow, targetRow: datesTarget, precedentRow: datesTarget - 1, formulas: formulasAbove(datesTab, datesHeader, datesTarget) }),
    ];
    const ready = duplicates.length === 0 && orgEmpty && contactEmpty && datesEmpty && existingDates.length === 0 && joinDate.ok;
    const plan = {
      connectLabsSha: sha,
      directory_id: id,
      name_column: columnLetter(nameCol),
      duplicates,
      organizations: { target_row: orgTarget, range: orgRange, target_row_empty: orgEmpty, row: orgRow },
      contacts: { target_row: contactTarget, range: contactRange, target_row_empty: contactEmpty, row: contactRow },
      dates: { target_row: datesTarget, range: datesRange, target_row_empty: datesEmpty, existing_rows: existingDates, row: datesRow },
      join_date: joinDate,
      ready,
      writes,
    };

    if (cmd === 'plan') {
      print(plan);
      return 0;
    }
    if (!ready) {
      print({ applied: false, reason: 'plan is not ready: a duplicate, a target row that is not empty, an existing dates row, or a join date that is not the org\'s own submission date', plan });
      return 1;
    }
    const who = deps.identity();
    for (const w of writes) deps.exec('gog', gogUpdateArgs(id, w, who)); // one attempt each: a write is not retried blind
    const result = verify(orgTarget, contactTarget, datesTarget);
    print({ applied: true, writes, verify: result });
    return result.ok ? 0 : 1;
  }

  if (cmd === 'verify') {
    const orgN = Number(arg('--org-row'));
    const contactN = Number(arg('--contact-row'));
    const datesN = Number(arg('--dates-row'));
    if (!orgN || !contactN || !datesN) throw new Error('--org-row, --contact-row and --dates-row are required');
    const result = verify(orgN, contactN, datesN);
    print(result);
    return result.ok ? 0 : 1;
  }

  throw new Error(
    'usage: llo-directory.ts contract | plan --org f --contact f --dates f --submitted YYYY-MM-DD|none | apply (same as plan) | ' +
      'verify --org f --org-row n --contact f --contact-row n --dates f --dates-row n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 2;
  }
}
