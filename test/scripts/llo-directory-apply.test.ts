// scripts/llo-directory.ts `apply` against an in-memory sheet (no network).
//
// ace#2956: `plan` used to print shell-quoted `gog sheets update` strings and the
// skill told the operator to run them. On turn 57c4c5f9 (thread 1a140249a31ee901,
// 2026-10-15) an HQ Basis note containing `"Gult Health Center"` broke the
// hand-extraction (`echo` reinterpreted the backslashes) and nothing was written.
// `apply` now runs the writes as argument arrays; this pins that a note with `"`
// and `\` reaches gog verbatim and that no shell is involved.
//
// ace#2957: Organizations' contact-email column is a Contacts-derived FORMULA; a
// RAW write of the row replaced it with a literal (rows 240–242). The formula
// cell must be copied from the precedent row, row number moved, USER_ENTERED.
//
// 2026-10-15: ACE added 19 ULAB EOI applicants with no dates-tab row, so labs'
// import stamped every one with the day it first saw them (2026-10-16) instead of
// its own 2–7 October submission date. Every add now writes a dates row whose
// join date is the org's own submission date, and `plan` refuses one dated today.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type Deps } from '../../scripts/llo-directory.js';

const DIRECTORY_PY = `
DIRECTORY_ID = "sheet-id-fixture"
ORGANIZATIONS_TAB = "Organizations"
CONTACTS_TAB = "Contacts"
DATES_TAB = "Dates Fixture"

_ISO_DATE = re.compile(r"\\d{4}-\\d{2}-\\d{2}")


def _header_key(title: str) -> str:
    """Docstring."""
    text = re.sub(r"\\([^)]*\\)", " ", (title or "").lower())
    text = re.sub(r"[?:*]+", " ", text).replace("organisation", "organization")
    return re.sub(r"\\s+", " ", text).strip()


ORG_NAME = "Organization Name"
ORG_COLUMNS = (
    ORG_NAME,
    "Website",
)
HQ_CITY = "HQ City"

CONTACT_COLUMNS = (
    "Contact Full Name",
    ORG_NAME,
    "Email Address",
)


def parse_dates(rows):
    """name -> (ISO join date, basis)."""
    cols = Columns(rows, DATES_TAB, required=(ORG_NAME, "Joined", "Joined — basis"))
    out = {}
    for row in rows[1:]:
        name = cols.get(row, ORG_NAME)
        joined, basis = cols.get(row, "Joined"), cols.get(row, "Joined — basis")
        if name and _ISO_DATE.fullmatch(joined):
            out[name] = (joined, basis[:200])
    return out
`;

const QUALITY_PY = `
def _fold(name: str) -> str:
    """Docstring."""
    stripped = "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))
    return re.sub(r"\\s+", " ", stripped).strip().lower()
`;

const emailFormula = (n: number) =>
  `=IFERROR(TEXTJOIN("; ", TRUE, UNIQUE(FILTER(Contacts!C:C, Contacts!B:B=A${n}, Contacts!C:C<>""))), "")`;

type Grid = { values: string[][]; formulas: string[][] };
let sheet: Record<string, Grid>;
let calls: { cmd: string; args: string[] }[];

function colIndex(letters: string): number {
  return [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
}

/** `'Tab'!A4:E4`, `'Tab'!1:1`, `'Tab'!A:ZZ` → tab + inclusive row/col bounds. */
function parseRange(range: string) {
  const m = /^'((?:[^']|'')*)'!(.*)$/.exec(range)!;
  const tab = m[1].replace(/''/g, "'");
  const [a, b] = m[2].split(':');
  const part = (s: string) => /^([A-Z]*)(\d*)$/.exec(s)!;
  const [, c1, r1] = part(a);
  const [, c2, r2] = part(b);
  return {
    tab,
    r1: r1 ? Number(r1) : 1,
    r2: r2 ? Number(r2) : Infinity,
    c1: c1 ? colIndex(c1) : 0,
    c2: c2 ? colIndex(c2) : Infinity,
  };
}

function fakeExec(cmd: string, args: string[]): string {
  calls.push({ cmd, args });
  if (cmd === 'gh') {
    const path = args[1];
    if (path.endsWith('/commits/main')) return 'abc123\n';
    if (path.includes('directory.py')) return DIRECTORY_PY;
    if (path.includes('quality.py')) return QUALITY_PY;
    return '# import command\n';
  }
  if (cmd !== 'gog') throw new Error(`unexpected command ${cmd}`);
  const [, verb, , range] = args;
  const r = parseRange(range);
  const grid = sheet[r.tab];
  if (verb === 'get') {
    const src = args[args.indexOf('--render') + 1] === 'FORMULA' ? grid.formulas : grid.values;
    const out: string[][] = [];
    for (let row = r.r1; row <= Math.min(r.r2, src.length); row++) {
      out.push((src[row - 1] ?? []).slice(r.c1, r.c2 === Infinity ? undefined : r.c2 + 1));
    }
    while (out.length && out[out.length - 1].every((c) => !c)) out.pop();
    return JSON.stringify(out);
  }
  if (verb === 'update') {
    const values: string[][] = JSON.parse(args[args.indexOf('--values-json') + 1]);
    const userEntered = args[args.indexOf('--input') + 1] === 'USER_ENTERED';
    values.forEach((rowVals, dr) => {
      const row = r.r1 + dr - 1;
      grid.values[row] ??= [];
      grid.formulas[row] ??= [];
      rowVals.forEach((v, dc) => {
        const col = r.c1 + dc;
        const isFormula = userEntered && v.startsWith('=');
        grid.formulas[row][col] = v;
        grid.values[row][col] = isFormula ? 'computed@example.org' : v;
      });
    });
    return '';
  }
  throw new Error(`unexpected gog verb ${verb}`);
}

const deps: Deps = {
  exec: fakeExec,
  identity: () => ({ account: 'ace@dimagi-ai.com', client: 'canopy' }),
  log: () => {},
  today: () => TODAY,
};

const TODAY = '2026-10-16';
const SUBMITTED = '2026-10-05';

const NOTE = 'HQ Basis: "Gult Health Center" per site; path C:\\clinic\\n and a \'quote\'.';

function files(org: Record<string, string>, contact: Record<string, string>, dates: Record<string, string> | null = DATES) {
  const dir = mkdtempSync(join(tmpdir(), 'llo-directory-apply-'));
  writeFileSync(join(dir, 'org.json'), JSON.stringify(org));
  writeFileSync(join(dir, 'contact.json'), JSON.stringify(contact));
  const out = ['--org', join(dir, 'org.json'), '--contact', join(dir, 'contact.json')];
  if (dates) {
    writeFileSync(join(dir, 'dates.json'), JSON.stringify(dates));
    out.push('--dates', join(dir, 'dates.json'));
  }
  return out;
}

/** plan/apply args: the three row files plus the org's own submission date. */
const planArgs = (org = ORG, contact = CONTACT, dates: Record<string, string> | null = DATES, submitted = SUBMITTED) => [
  ...files(org, contact, dates),
  '--submitted',
  submitted,
];

function planOf(args: string[]) {
  const out: string[] = [];
  main(['plan', ...args], { ...deps, log: (l) => out.push(l) });
  return JSON.parse(out[0]);
}

const ORG = { 'Organization Name': 'New Org', Website: 'https://new.example.org', 'Organization Notes': NOTE };
const CONTACT = { 'Contact Full Name': 'Ada Obi', 'Organization Name': 'New Org', 'Email Address': 'ada@new.example.org' };
const DATES = {
  'Organization Name': 'New Org',
  Joined: SUBMITTED,
  'Joined — basis': 'Fixture Scoping EOI - exact submission timestamp',
  Notes: 'Fixture Scoping EOI response, earliest submission timestamp 2026-10-05.',
};

beforeEach(() => {
  calls = [];
  const orgHeader = ['Organization Name', 'Website', 'Organization Notes', 'Email addresses from Contacts sheet'];
  const orgRows = [
    ['Old Org', 'https://old.example.org', 'n', 'old@old.example.org'],
    ['Other Org', 'https://other.example.org', 'n', 'o@other.example.org'],
  ];
  const contactHeader = ['Contact Full Name', 'Organization Name', 'Email Address'];
  const contactRows = [['Bo', 'Old Org', 'old@old.example.org']];
  const datesHeader = ['Organization Name', 'Joined', 'Joined — basis', 'Notes'];
  const datesRows = [
    ['Old Org', '2025-02-05', 'Old EOI - exact submission timestamp', 'n'],
    ['Other Org', '', 'no EOI link: inbound email', 'n'],
  ];
  sheet = {
    Organizations: {
      values: [orgHeader, ...orgRows].map((r) => [...r]),
      formulas: [orgHeader, ...orgRows.map((r, i) => [...r.slice(0, 3), emailFormula(i + 2)])],
    },
    Contacts: {
      values: [contactHeader, ...contactRows].map((r) => [...r]),
      formulas: [contactHeader, ...contactRows].map((r) => [...r]),
    },
    'Dates Fixture': {
      values: [datesHeader, ...datesRows].map((r) => [...r]),
      formulas: [datesHeader, ...datesRows].map((r) => [...r]),
    },
  };
});

describe('llo-directory apply', () => {
  it('writes through an argument array: a note with " and \\ reaches gog verbatim, then verifies clean', () => {
    const code = main(['apply', ...planArgs()], deps);
    expect(code).toBe(0);
    const updates = calls.filter((c) => c.args[1] === 'update');
    expect(updates.every((c) => c.cmd === 'gog' && Array.isArray(c.args))).toBe(true);
    expect(calls.some((c) => /^(sh|bash|zsh)$/.test(c.cmd))).toBe(false);
    const orgWrite = updates.find((c) => c.args[3] === "'Organizations'!A4:D4")!;
    expect(orgWrite.args[orgWrite.args.indexOf('--input') + 1]).toBe('RAW');
    const row = JSON.parse(orgWrite.args[orgWrite.args.indexOf('--values-json') + 1])[0];
    expect(row[2]).toBe(NOTE);
    expect(sheet.Organizations.values[3][2]).toBe(NOTE);
  });

  it('copies the formula column from the precedent row, row moved, USER_ENTERED — never a literal', () => {
    main(['apply', ...planArgs()], deps);
    const updates = calls.filter((c) => c.args[1] === 'update');
    const raw = updates.find((c) => c.args[3] === "'Organizations'!A4:D4")!;
    expect(JSON.parse(raw.args[raw.args.indexOf('--values-json') + 1])[0][3]).toBe('');
    const formula = updates.find((c) => c.args[3] === "'Organizations'!D4:D4")!;
    expect(formula.args[formula.args.indexOf('--input') + 1]).toBe('USER_ENTERED');
    expect(JSON.parse(formula.args[formula.args.indexOf('--values-json') + 1])).toEqual([[emailFormula(4)]]);
    // RAW lands before the formula, or the RAW blank would overwrite it.
    expect(updates.indexOf(raw)).toBeLessThan(updates.indexOf(formula));
    expect(sheet.Organizations.formulas[3][3]).toBe(emailFormula(4));
  });

  it('refuses a drafted value in a formula column, writing nothing', () => {
    const org = { ...ORG, 'Email addresses from Contacts sheet': 'ada@new.example.org' };
    expect(() => main(['apply', ...planArgs(org, CONTACT, { ...DATES })], deps)).toThrow(/holds a formula/);
    expect(calls.some((c) => c.args[1] === 'update')).toBe(false);
  });

  it('exits non-zero and writes nothing when the plan is not ready (duplicate)', () => {
    const org = { ...ORG, 'Organization Name': 'OLD ORG' };
    const contact = { ...CONTACT, 'Organization Name': 'OLD ORG' };
    expect(main(['apply', ...planArgs(org, contact, { ...DATES, 'Organization Name': 'OLD ORG' })], deps)).toBe(1);
    expect(calls.some((c) => c.args[1] === 'update')).toBe(false);
  });

  it('verify fails when the formula cell holds a literal', () => {
    main(['apply', ...planArgs()], deps);
    sheet.Organizations.formulas[3][3] = 'ada@new.example.org';
    expect(main(['verify', ...files(ORG, CONTACT), '--org-row', '4', '--contact-row', '3', '--dates-row', '4'], deps)).toBe(1);
  });

  it('plan prints the writes as data, with no shell command strings', () => {
    const plan = planOf(planArgs());
    expect(plan.ready).toBe(true);
    expect(plan.commands).toBeUndefined();
    expect(plan.writes.map((w: { range: string; input: string }) => [w.range, w.input])).toEqual([
      ["'Organizations'!A4:D4", 'RAW'],
      ["'Organizations'!D4:D4", 'USER_ENTERED'],
      ["'Contacts'!A3:C3", 'RAW'],
      ["'Dates Fixture'!A4:D4", 'RAW'],
    ]);
  });
});

describe('llo-directory join date (the dates tab)', () => {
  it('a plan without a dates row is refused: every org added gets its join date', () => {
    expect(() => main(['plan', ...files(ORG, CONTACT, null), '--submitted', SUBMITTED], deps)).toThrow(/--dates/);
  });

  it('a plan without the submission date is refused', () => {
    expect(() => main(['plan', ...files(ORG, CONTACT)], deps)).toThrow(/--submitted/);
  });

  it('writes the dates row at the real last filled row + 1, RAW, and reads it back', () => {
    const out: string[] = [];
    expect(main(['apply', ...planArgs()], { ...deps, log: (l) => out.push(l) })).toBe(0);
    const write = calls.find((c) => c.args[1] === 'update' && c.args[3] === "'Dates Fixture'!A4:D4")!;
    expect(write.args[write.args.indexOf('--input') + 1]).toBe('RAW');
    expect(sheet['Dates Fixture'].values[3]).toEqual(['New Org', SUBMITTED, DATES['Joined — basis'], DATES.Notes]);
    const result = JSON.parse(out[0]);
    expect(result.verify.dates).toEqual({ row: 4, diff: [] });
  });

  it('a dates row dated today instead of the submission date fails the plan, and apply writes nothing', () => {
    const today = { ...DATES, Joined: TODAY };
    const plan = planOf(planArgs(ORG, CONTACT, today));
    expect(plan.ready).toBe(false);
    expect(plan.join_date.problems.join(' ')).toMatch(/is today, the day ACE writes the row/);
    expect(main(['apply', ...planArgs(ORG, CONTACT, today)], deps)).toBe(1);
    expect(calls.some((c) => c.args[1] === 'update')).toBe(false);
  });

  it('a join date that is not the submission date fails, and so does a blank one when a date exists', () => {
    expect(planOf(planArgs(ORG, CONTACT, { ...DATES, Joined: '2026-10-01' })).ready).toBe(false);
    expect(planOf(planArgs(ORG, CONTACT, { ...DATES, Joined: '' })).ready).toBe(false);
  });

  it('a non-ISO join date fails: labs would ignore it and stamp the import day', () => {
    const plan = planOf(planArgs(ORG, CONTACT, { ...DATES, Joined: '10/5/2026' }, '2026-10-05'));
    expect(plan.ready).toBe(false);
  });

  it('with no submission date the join date stays blank and the plan says so', () => {
    const plan = planOf(planArgs(ORG, CONTACT, { ...DATES, Joined: '' }, 'none'));
    expect(plan.ready).toBe(true);
    expect(plan.join_date.missing).toMatch(/No submission date/);
    expect(planOf(planArgs(ORG, CONTACT, { ...DATES }, 'none')).ready).toBe(false); // a date with no source is a guess
  });

  it('a blank basis fails the plan', () => {
    expect(planOf(planArgs(ORG, CONTACT, { ...DATES, 'Joined — basis': '' })).ready).toBe(false);
  });

  it("refuses a dates row whose name is not the org row's exactly", () => {
    expect(() => main(['plan', ...planArgs(ORG, CONTACT, { ...DATES, 'Organization Name': 'new org' })], deps)).toThrow(/exactly/);
  });

  it('an existing dates row for the org stops the plan', () => {
    sheet['Dates Fixture'].values.push(['New Org', '2026-10-05', 'b', 'n']);
    sheet['Dates Fixture'].formulas.push(['New Org', '2026-10-05', 'b', 'n']);
    const plan = planOf(planArgs());
    expect(plan.dates.existing_rows).toEqual([{ row: 4, name: 'New Org' }]);
    expect(plan.ready).toBe(false);
  });

  it('verify fails when the dates row does not read back as written', () => {
    main(['apply', ...planArgs()], deps);
    sheet['Dates Fixture'].values[3][1] = TODAY;
    sheet['Dates Fixture'].formulas[3][1] = TODAY;
    expect(main(['verify', ...files(ORG, CONTACT), '--org-row', '4', '--contact-row', '3', '--dates-row', '4'], deps)).toBe(1);
  });
});
