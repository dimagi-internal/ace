#!/usr/bin/env -S npx tsx
/**
 * llo-directory — the read side of `skills/llo-directory-add` (dimagi-internal/ace#2920).
 *
 * Every subcommand reads connect-labs `main` FIRST — the sheet id, tab names and
 * required columns come from `connect_labs/marketplace/directory.py` at run time,
 * never from ACE — then reads the live sheet as ACE's gog identity. Nothing here
 * writes: `plan` prints the exact `gog sheets update` commands for the operator to
 * approve, and the skill runs them.
 *
 *   npx tsx scripts/llo-directory.ts contract
 *   npx tsx scripts/llo-directory.ts plan --org org.json --contact contact.json
 *   npx tsx scripts/llo-directory.ts verify --org org.json --org-row 242 --contact contact.json --contact-row 205
 *
 * `org.json` / `contact.json` map LIVE header text → cell value, e.g.
 * `{"Organization Name": "…", "Website": "…"}`. Unknown headers are refused.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGogIdentity } from '../lib/gog-identity.js';
import {
  CONNECT_LABS_REPO,
  DIRECTORY_MODULE,
  IMPORT_COMMAND,
  QUALITY_MODULE,
  assertUpstreamRulesUnchanged,
  buildRow,
  columnLetter,
  diffReadBack,
  findDuplicates,
  headerIndex,
  headerKey,
  nextEmptyRow,
  parseDirectoryContract,
  requireHeaders,
  rowIsEmpty,
  rowRange,
  type DirectoryContract,
} from '../lib/llo-directory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reads only, so a retry cannot double-write; this network drops TLS handshakes. */
function run(cmd: string, args: string[]): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

function fetchUpstream(file: string): string {
  return run('gh', ['api', `repos/${CONNECT_LABS_REPO}/contents/${file}?ref=main`, '-H', 'Accept: application/vnd.github.raw']);
}

function liveContract(): { contract: DirectoryContract; sha: string } {
  const sha = run('gh', ['api', `repos/${CONNECT_LABS_REPO}/commits/main`, '--jq', '.sha']).trim();
  const directoryPy = fetchUpstream(DIRECTORY_MODULE);
  const qualityPy = fetchUpstream(QUALITY_MODULE);
  fetchUpstream(IMPORT_COMMAND); // must still exist: the reply names it as the path into labs
  assertUpstreamRulesUnchanged({ [DIRECTORY_MODULE]: directoryPy, [QUALITY_MODULE]: qualityPy });
  return { contract: parseDirectoryContract(directoryPy), sha };
}

function sheetGet(id: string, range: string): string[][] {
  const { account, client } = resolveGogIdentity({ repoRoot: REPO_ROOT });
  const out = run('gog', [
    'sheets', 'get', id, range, '-a', account, '--client', client, '-j', '--results-only', '--render', 'FORMATTED_VALUE',
  ]).trim();
  const parsed = out ? JSON.parse(out) : [];
  return Array.isArray(parsed) ? parsed : (parsed.values ?? []);
}

const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

function readJson(file: string | undefined, flag: string): Record<string, string> {
  if (!file) throw new Error(`${flag} <file.json> is required`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fieldFor(fields: Record<string, string>, header: string): string {
  const hit = Object.entries(fields).find(([k]) => headerKey(k) === headerKey(header));
  return hit ? hit[1] : '';
}

function main(): void {
  const cmd = process.argv[2];
  const { contract, sha } = liveContract();
  const id = contract.directoryId;
  const orgTab = contract.organizationsTab;
  const contactTab = contract.contactsTab;

  if (cmd === 'contract') {
    console.log(JSON.stringify({ connectLabsSha: sha, ...contract }, null, 2));
    return;
  }

  const orgFields = readJson(arg('--org'), '--org');
  const contactFields = readJson(arg('--contact'), '--contact');
  const orgHeader = sheetGet(id, `${quoteTab(orgTab)}!1:1`)[0] ?? [];
  const contactHeader = sheetGet(id, `${quoteTab(contactTab)}!1:1`)[0] ?? [];
  requireHeaders(orgHeader, [...contract.orgColumns], orgTab);
  requireHeaders(contactHeader, [...contract.contactColumns], contactTab);
  const orgRow = buildRow(orgHeader, orgFields, orgTab);
  const contactRow = buildRow(contactHeader, contactFields, contactTab);

  if (cmd === 'plan') {
    const name = fieldFor(orgFields, contract.orgNameHeader);
    if (!name) throw new Error(`--org must set "${contract.orgNameHeader}"`);
    if (headerKey(fieldFor(contactFields, contract.orgNameHeader)) !== headerKey(name)) {
      throw new Error(`The contact's "${contract.orgNameHeader}" must equal the org row's, or labs cannot join them.`);
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
    const orgNameLetter = columnLetter(nameCol);
    const orgTarget = nextEmptyRow(orgAll.map((r) => [r[nameCol]]));
    const cIdx = headerIndex(contactHeader).get(headerKey(contract.contactColumns[0]))!;
    const contactCol = sheetGet(id, `${quoteTab(contactTab)}!A:ZZ`).map((r) => [r[cIdx]]);
    const contactTarget = nextEmptyRow(contactCol);

    const orgRange = rowRange(orgTab, orgHeader, orgTarget);
    const contactRange = rowRange(contactTab, contactHeader, contactTarget);
    const orgEmpty = rowIsEmpty(sheetGet(id, orgRange));
    const contactEmpty = rowIsEmpty(sheetGet(id, contactRange));
    const { account, client } = resolveGogIdentity({ repoRoot: REPO_ROOT });
    const update = (range: string, row: string[]) =>
      ['gog', 'sheets', 'update', id, range, '--values-json', JSON.stringify([row]), '--input', 'RAW', '-a', account, '--client', client]
        .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
        .join(' ');

    console.log(
      JSON.stringify(
        {
          connectLabsSha: sha,
          directory_id: id,
          name_column: orgNameLetter,
          duplicates,
          organizations: { target_row: orgTarget, range: orgRange, target_row_empty: orgEmpty, row: orgRow },
          contacts: { target_row: contactTarget, range: contactRange, target_row_empty: contactEmpty, row: contactRow },
          ready: duplicates.length === 0 && orgEmpty && contactEmpty,
          commands: [update(orgRange, orgRow), update(contactRange, contactRow)],
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === 'verify') {
    const orgN = Number(arg('--org-row'));
    const contactN = Number(arg('--contact-row'));
    if (!orgN || !contactN) throw new Error('--org-row and --contact-row are required');
    const orgDiff = diffReadBack(orgRow, sheetGet(id, rowRange(orgTab, orgHeader, orgN)));
    const contactDiff = diffReadBack(contactRow, sheetGet(id, rowRange(contactTab, contactHeader, contactN)));
    const ok = orgDiff.length === 0 && contactDiff.length === 0;
    console.log(JSON.stringify({ ok, organizations: { row: orgN, diff: orgDiff }, contacts: { row: contactN, diff: contactDiff } }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  throw new Error('usage: llo-directory.ts contract | plan --org f --contact f | verify --org f --org-row n --contact f --contact-row n');
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
