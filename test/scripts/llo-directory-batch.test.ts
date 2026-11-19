// scripts/llo-directory.ts `batch-plan` / `batch-apply` against an in-memory sheet (no network).
//
// 2026-11-19: adding 30 EOI applicants one at a time took ~15 minutes (each plan/apply re-read every
// tab, ~25 s of Sheets read-quota wait between orgs). A batch reads each tab once, gives the orgs
// consecutive rows, writes each tab in one call and reads each span back once.

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


const TODAY = '2026-11-19';

const item = (name: string, site: string, email: string, submitted = '2026-11-17') => ({
  org: { 'Organization Name': name, Website: site, 'Organization Notes': `note for ${name}` },
  contact: { 'Contact Full Name': `Contact of ${name}`, 'Organization Name': name, 'Email Address': email },
  dates: {
    'Organization Name': name,
    Joined: submitted,
    'Joined — basis': 'Fixture RFI - exact submission timestamp',
    Notes: `row for ${name}`,
  },
  submitted,
});

function batchFile(items: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'llo-directory-batch-'));
  writeFileSync(join(dir, 'batch.json'), JSON.stringify(items));
  return join(dir, 'batch.json');
}

function run(cmd: string, items: unknown[], extra: string[] = []) {
  const out: string[] = [];
  const code = main([cmd, '--batch', batchFile(items), ...extra], { ...deps, log: (l) => out.push(l) });
  return { code, result: JSON.parse(out[0]) };
}

const gogCalls = (verb: string) => calls.filter((c) => c.cmd === 'gog' && c.args[1] === verb);

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

describe('batch-plan / batch-apply', () => {
  const three = () => [
    item('Alpha Trust', 'https://alpha.example.invalid', 'a@alpha.example.invalid'),
    item('Beta Network', 'https://beta.example.invalid', 'b@beta.example.invalid', '2026-11-18'),
    item('Gamma Initiative', '', 'g@gamma.example.invalid', '2026-11-19'),
  ];

  it('plans consecutive rows on every tab and writes nothing', () => {
    const { code, result } = run('batch-plan', three());
    expect(code).toBe(0);
    expect(result.ready).toBe(true);
    expect(result.rows.map((r: { organizations_row: number }) => r.organizations_row)).toEqual([4, 5, 6]);
    expect(result.rows.map((r: { contacts_row: number }) => r.contacts_row)).toEqual([3, 4, 5]);
    expect(result.rows.map((r: { dates_row: number }) => r.dates_row)).toEqual([4, 5, 6]);
    expect(gogCalls('update')).toHaveLength(0);
  });

  it('writes each tab in ONE call plus one per formula column, however many orgs', () => {
    const { code, result } = run('batch-apply', three());
    expect(code).toBe(0);
    expect(result.ok).toBe(true);
    // Organizations: 1 RAW block + 1 formula column; Contacts: 1; Dates: 1.
    expect(gogCalls('update')).toHaveLength(4);
    expect(result.write_calls).toBe(4);
    expect(sheet.Organizations.values.slice(3).map((r) => r[0])).toEqual(['Alpha Trust', 'Beta Network', 'Gamma Initiative']);
    expect(sheet.Contacts.values.slice(2).map((r) => r[2])).toEqual([
      'a@alpha.example.invalid',
      'b@beta.example.invalid',
      'g@gamma.example.invalid',
    ]);
  });

  it('dates each org by its own submission, one dates row per org', () => {
    run('batch-apply', three());
    expect(sheet['Dates Fixture'].values.slice(3).map((r) => [r[0], r[1]])).toEqual([
      ['Alpha Trust', '2026-11-17'],
      ['Beta Network', '2026-11-18'],
      ['Gamma Initiative', '2026-11-19'],
    ]);
  });

  it('copies the formula into each new row with its row number moved', () => {
    run('batch-apply', three());
    expect(sheet.Organizations.formulas.slice(3).map((r) => r[3])).toEqual([emailFormula(4), emailFormula(5), emailFormula(6)]);
  });

  it('reads far fewer ranges than one-at-a-time plan/apply would', () => {
    run('batch-apply', three());
    expect(gogCalls('get').length).toBeLessThanOrEqual(24); // fixed, not per org
  });

  it('reads back every row and reports a mismatch per org', () => {
    const { result } = run('batch-apply', three());
    expect(result.rows.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it('refuses a duplicate of an existing org, and of an EARLIER org in the same batch, naming which', () => {
    const items = [
      item('Old Org', 'https://elsewhere.example.invalid', 'x@x.example.invalid'),
      item('Delta', 'https://delta.example.invalid', 'd@d.example.invalid'),
      item('DELTA', 'https://delta2.example.invalid', 'd2@d.example.invalid'),
    ];
    const { code, result } = run('batch-apply', items);
    expect(code).toBe(1);
    expect(result.applied).toBe(false);
    expect(JSON.stringify(result.problems)).toContain('Organizations row 2');
    expect(JSON.stringify(result.problems)).toContain('earlier in this batch');
    expect(gogCalls('update')).toHaveLength(0); // all-or-nothing by default
  });

  it('with --skip-problem-items writes the clean ones and reports the rest', () => {
    const items = [item('Old Org', '', 'x@x.example.invalid'), item('Delta', '', 'd@d.example.invalid')];
    const { code, result } = run('batch-apply', items, ['--skip-problem-items']);
    expect(code).toBe(0);
    expect(result.count).toBe(1);
    expect(result.skipped_problem_items).toHaveLength(1);
    expect(sheet.Organizations.values.slice(3).map((r) => r[0])).toEqual(['Delta']);
  });

  it('refuses an item dated today, since the join date is the applicant’s own submission', () => {
    const items = [{ ...item('Today Org', '', 't@t.example.invalid', TODAY), submitted: '2026-11-17' }];
    const { code, result } = run('batch-apply', items);
    expect(code).toBe(1);
    expect(JSON.stringify(result.problems)).toMatch(/submission|today/i);
  });

  it('refuses a contact with no email, which labs could not join', () => {
    const items = [item('No Email Org', '', '')];
    const { code, result } = run('batch-apply', items);
    expect(code).toBe(1);
    expect(JSON.stringify(result.problems)).toContain('no email address');
  });

  it('aims past a stray row below the data rather than onto it', () => {
    sheet.Contacts.values[2] = ['Stray', 'Somewhere', 'stray@example.invalid'];
    sheet.Contacts.formulas[2] = ['Stray', 'Somewhere', 'stray@example.invalid'];
    // The stray row is the last filled one, so the batch starts after it.
    const { result } = run('batch-plan', three());
    expect(result.rows[0].contacts_row).toBe(4);
  });

  it('a note with quotes and backslashes reaches gog verbatim (no shell)', () => {
    const odd = item('Quote Org', '', 'q@q.example.invalid');
    odd.org['Organization Notes'] = 'HQ: "Gult Health Center" path C:\\clinic\\n and a \'quote\'.';
    run('batch-apply', [odd]);
    expect(sheet.Organizations.values[3][2]).toBe(odd.org['Organization Notes']);
  });
});
