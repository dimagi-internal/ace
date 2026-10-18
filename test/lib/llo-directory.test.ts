// lib/llo-directory.ts — the pure half of skills/llo-directory-add (dimagi-internal/ace#2920).
//
// The fixtures below are abridged from connect-labs 6ecaf66
// (connect_labs/marketplace/directory.py + quality.py). They are FIXTURES for the
// parser, not ACE's copy of the layout: production reads both modules from
// connect-labs main at run time.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIRECTORY_MODULE,
  QUALITY_MODULE,
  DirectoryContractError,
  assertUpstreamRulesUnchanged,
  buildRow,
  checkJoinDate,
  columnLetter,
  isCalendarDate,
  diffReadBack,
  diffRowReadBack,
  expectedFormulas,
  findDuplicates,
  formulaColumns,
  planRowWrites,
  rowFormula,
  fold,
  headerKey,
  lastFilledRow,
  nextEmptyRow,
  parseDirectoryContract,
  pythonFunctionBody,
  requireHeaders,
  rowIsEmpty,
  rowRange,
  websiteHost,
} from '../../lib/llo-directory.js';

const DIRECTORY_PY = `
DIRECTORY_ID = "sheet-id-fixture"

ORGANIZATIONS_TAB = "Organizations"
CONTACTS_TAB = "Contacts"
MAPPING_TAB = "Connect Org Mapping"
DATES_TAB = "AI Enrichment - Connect Dates"

_ISO_DATE = re.compile(r"\\d{4}-\\d{2}-\\d{2}")


def _header_key(title: str) -> str:
    """A header as people retitle it: case, spacing, a parenthetical note and
    trailing punctuation are not part of its name."""
    text = re.sub(r"\\([^)]*\\)", " ", (title or "").lower())
    text = re.sub(r"[?:*]+", " ", text).replace("organisation", "organization")
    return re.sub(r"\\s+", " ", text).strip()


ORG_NAME = "Organization Name"
ORG_COLUMNS = (
    ORG_NAME,
    "Short Name",
    "Website",
)
# Optional: the head office's town, when someone has written one down.
HQ_CITY = "HQ City"

CONTACT_COLUMNS = (
    "Contact Full Name",
    ORG_NAME,
    "Main POC",
    "Email Address",
)


def parse_dates(rows: list[list[str]]) -> dict[str, tuple[str, str]]:
    """name -> (ISO join date, basis). Non-ISO cells are free text and ignored."""
    cols = Columns(rows, DATES_TAB, required=(ORG_NAME, "Joined Connect Network", "Joined — basis"))
    out: dict[str, tuple[str, str]] = {}
    for row in rows[1:]:
        name = cols.get(row, ORG_NAME)
        joined, basis = cols.get(row, "Joined Connect Network"), cols.get(row, "Joined — basis")
        if name and _ISO_DATE.fullmatch(joined):
            out[name] = (joined, basis[:200])
    return out
`;

const QUALITY_PY = `
def _fold(name: str) -> str:
    """Case, accent and whitespace folded away, for near-duplicate detection."""
    stripped = "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))
    return re.sub(r"\\s+", " ", stripped).strip().lower()


def audit(org_rows, contact_rows, orgs, contacts, skipped) -> list[Finding]:
    return []
`;

describe('parseDirectoryContract', () => {
  it('reads the id, tabs and column tuples out of the module source, resolving ORG_NAME', () => {
    expect(parseDirectoryContract(DIRECTORY_PY)).toEqual({
      directoryId: 'sheet-id-fixture',
      organizationsTab: 'Organizations',
      contactsTab: 'Contacts',
      orgNameHeader: 'Organization Name',
      orgColumns: ['Organization Name', 'Short Name', 'Website'],
      hqCityHeader: 'HQ City',
      contactColumns: ['Contact Full Name', 'Organization Name', 'Main POC', 'Email Address'],
      datesTab: 'AI Enrichment - Connect Dates',
      datesColumns: ['Organization Name', 'Joined Connect Network', 'Joined — basis'],
      datesJoinedHeader: 'Joined Connect Network',
      datesBasisHeader: 'Joined — basis',
      isoDatePattern: '\\d{4}-\\d{2}-\\d{2}',
    });
  });

  it('reads the dates tab and its columns from parse_dates, so a renamed column follows labs', () => {
    const renamed = DIRECTORY_PY.replaceAll('"Joined Connect Network"', '"Joined Network"');
    expect(parseDirectoryContract(renamed).datesJoinedHeader).toBe('Joined Network');
  });

  it('refuses when parse_dates no longer reads the dates tab the way this reader knows', () => {
    expect(() => parseDirectoryContract(DIRECTORY_PY.replace(/^DATES_TAB.*$/m, ''))).toThrow(/DATES_TAB/);
    expect(() => parseDirectoryContract(DIRECTORY_PY.replace('_ISO_DATE.fullmatch(joined)', 'joined'))).toThrow(/_ISO_DATE\.fullmatch/);
    expect(() => parseDirectoryContract(DIRECTORY_PY.replace(/^_ISO_DATE.*$/m, ''))).toThrow(/_ISO_DATE/);
    expect(() =>
      parseDirectoryContract(DIRECTORY_PY.replace('"Joined — basis"))', '"Joined — basis", "Source"))')),
    ).toThrow(/expects name, date and basis/);
  });

  it('refuses, naming the symbol, when upstream drops a constant', () => {
    expect(() => parseDirectoryContract(DIRECTORY_PY.replace(/^CONTACTS_TAB.*$/m, ''))).toThrow(/CONTACTS_TAB/);
  });

  it('refuses a tuple item it cannot resolve rather than guessing', () => {
    const changed = DIRECTORY_PY.replace('"Short Name",', 'SHORT_NAME,');
    expect(() => parseDirectoryContract(changed)).toThrow(/SHORT_NAME/);
  });
});

describe('assertUpstreamRulesUnchanged', () => {
  const sources = { [DIRECTORY_MODULE]: DIRECTORY_PY, [QUALITY_MODULE]: QUALITY_PY };

  it('passes when the upstream bodies match what was ported (docstrings ignored)', () => {
    expect(() => assertUpstreamRulesUnchanged(sources)).not.toThrow();
    expect(pythonFunctionBody(QUALITY_PY, '_fold')).not.toMatch(/near-duplicate/);
  });

  it('refuses when labs changes the duplicate rule', () => {
    const changed = QUALITY_PY.replace('.strip().lower()', '.strip().casefold()');
    expect(() => assertUpstreamRulesUnchanged({ ...sources, [QUALITY_MODULE]: changed })).toThrow(/_fold changed/);
  });

  it('refuses when labs changes header matching', () => {
    const changed = DIRECTORY_PY.replace('[?:*]+', '[?:*.]+');
    expect(() => assertUpstreamRulesUnchanged({ ...sources, [DIRECTORY_MODULE]: changed })).toThrow(/_header_key changed/);
  });
});

describe('ported rules', () => {
  it('headerKey matches labs: case, bracketed notes, ?:* and Organisation spelling', () => {
    expect(headerKey('Main POC?')).toBe(headerKey('Main POC'));
    expect(headerKey('Contact Notes (e.g. best way to contact)')).toBe('contact notes');
    expect(headerKey('Organisation Name')).toBe(headerKey('Organization Name'));
  });

  it('fold matches labs: case, accents, spacing', () => {
    expect(fold('  Espérance  Mères et Enfants en RDC ')).toBe('esperance meres et enfants en rdc');
  });

  it('columnLetter matches labs column_letter past Z', () => {
    expect([0, 18, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'S', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
});

describe('row arithmetic — the 2026-10-14 off-by-one', () => {
  // A read of Tab!A:A: header + 3 orgs → sheet rows 1..4 filled.
  const column = [['Organization Name'], ['A'], ['B'], ['C']];

  it('the last filled row is 1-based, so the next empty row is count + 1', () => {
    expect(lastFilledRow(column)).toBe(4);
    expect(nextEmptyRow(column)).toBe(5);
  });

  it('trailing blanks do not move the target', () => {
    expect(nextEmptyRow([...column, [''], []])).toBe(5);
  });

  it('honours a read that does not start at row 1', () => {
    expect(nextEmptyRow([['X'], ['Y']], 200)).toBe(202);
  });

  it('rowIsEmpty: the API omits an empty row; a formula or value is not empty', () => {
    expect(rowIsEmpty([])).toBe(true);
    expect(rowIsEmpty([['', '  ']])).toBe(true);
    expect(rowIsEmpty([['', 'x']])).toBe(false);
  });
});

describe('header mapping', () => {
  const header = ['Organization Name', 'Short Name', 'Website', 'HQ City'];

  it('places each value by header text, whatever the column order', () => {
    expect(buildRow(header, { website: 'https://x.org', 'Organisation Name': 'X' }, 'Organizations')).toEqual([
      'X',
      '',
      'https://x.org',
      '',
    ]);
    expect(buildRow([...header].reverse(), { Website: 'w' }, 'Organizations')).toEqual(['', 'w', '', '']);
  });

  it('refuses a field naming no live header instead of dropping it', () => {
    expect(() => buildRow(header, { 'Team Size': '5' }, 'Organizations')).toThrow(DirectoryContractError);
  });

  it('requireHeaders names every missing header', () => {
    expect(() => requireHeaders(header, ['Website', 'Office Address', 'Org Team Size'], 'Organizations')).toThrow(
      /"Office Address", "Org Team Size"/,
    );
  });

  it('rowRange spans the header width at an exact row', () => {
    expect(rowRange('Organizations', header, 242)).toBe("'Organizations'!A242:D242");
  });
});

describe('duplicates', () => {
  const rows = [
    { row: 240, name: 'Espérance Mères et Enfants en RDC', website: 'www.emerdcongo.org' },
    { row: 241, name: 'Heart for Humanity Initiative', website: 'https://www.heart4humanityinitiative.org' },
  ];

  it("labs' fold: a re-cased, re-accented name is the same org", () => {
    expect(findDuplicates({ name: 'esperance meres et enfants  en RDC' }, rows)).toEqual([
      { row: 240, name: rows[0].name, reason: 'folded-name' },
    ]);
  });

  it('the same website host under another name is flagged', () => {
    expect(findDuplicates({ name: 'HHI Nigeria', website: 'http://heart4humanityinitiative.org/contact' }, rows)).toEqual([
      { row: 241, name: rows[1].name, reason: 'website' },
    ]);
    expect(websiteHost('HTTPS://WWW.Example.org/a?b')).toBe('example.org');
  });

  it('a new org is clean', () => {
    expect(findDuplicates({ name: 'New Org', website: 'new.org' }, rows)).toEqual([]);
  });
});

describe('diffReadBack', () => {
  it('passes an exact read-back, tolerating the trailing blanks the API omits', () => {
    expect(diffReadBack(['a', 'b', '', ''], [['a', 'b']])).toEqual([]);
  });

  it('names each cell that did not land', () => {
    expect(diffReadBack(['a', '+234 1'], [['a', '#ERROR!']])).toEqual([{ column: 'B', wrote: '+234 1', read: '#ERROR!' }]);
    expect(diffReadBack(['a'], [])).toEqual([{ column: 'A', wrote: 'a', read: '' }]);
  });
});

// ace#2957: the live Organizations contact-email formula, as `--render FORMULA`
// returned it for rows 84–97 on 2026-10-15 (issue body).
const LIVE_L = (n: number) =>
  `=IFERROR(TEXTJOIN("; ", TRUE, UNIQUE(FILTER(Contacts!E:E, Contacts!B:B=A${n}, Contacts!E:E<>"", NOT(ISNA(Contacts!E:E))))), "")`;

describe('formula columns', () => {
  it('formulaColumns finds only cells that hold a formula', () => {
    expect([...formulaColumns(['Org', '', 'x=1', LIVE_L(241)])]).toEqual([[3, LIVE_L(241)]]);
    expect(formulaColumns([]).size).toBe(0);
  });

  it('rowFormula moves the live formula from row 241 to 243', () => {
    expect(rowFormula(LIVE_L(241), 241, 243)).toBe(LIVE_L(243));
  });

  it('rowFormula leaves absolute rows, whole columns, strings, sheet names and function names alone', () => {
    expect(rowFormula('=A$2+B5', 5, 9)).toBe('=A$2+B9');
    expect(rowFormula('=IF(A5="A5",LOG10(C5),\'Tab 5\'!D5)', 5, 6)).toBe('=IF(A6="A5",LOG10(C6),\'Tab 5\'!D6)');
    expect(rowFormula('=SUM($A$1:$A4)', 4, 5)).toBe('=SUM($A$1:$A5)');
    expect(rowFormula('="a""B2"""&B2', 2, 3)).toBe('="a""B2"""&B3');
    expect(() => rowFormula('=A1', 3, 2)).toThrow(DirectoryContractError);
  });

  it('planRowWrites: RAW row with the formula cell blank, then the moved formula USER_ENTERED', () => {
    const headerRow = ['Organization Name', 'Notes', 'Email addresses from Contacts sheet'];
    const writes = planRowWrites({
      tab: 'Organizations',
      headerRow,
      row: ['HHI', 'say "hi"', ''],
      targetRow: 243,
      precedentRow: 242,
      formulas: new Map([[2, LIVE_L(242)]]),
    });
    expect(writes).toEqual([
      { range: "'Organizations'!A243:C243", input: 'RAW', values: [['HHI', 'say "hi"', '']] },
      { range: "'Organizations'!C243:C243", input: 'USER_ENTERED', values: [[LIVE_L(243)]] },
    ]);
  });

  it('planRowWrites refuses a drafted value in a formula column', () => {
    expect(() =>
      planRowWrites({
        tab: 'Organizations',
        headerRow: ['Organization Name', 'Email addresses from Contacts sheet'],
        row: ['HHI', 'sani@example.org'],
        targetRow: 243,
        precedentRow: 242,
        formulas: new Map([[1, LIVE_L(242)]]),
      }),
    ).toThrow(/"Email addresses from Contacts sheet" holds a formula/);
  });

  it('diffRowReadBack compares data to the formatted read and formulas to the FORMULA read', () => {
    const expected = expectedFormulas(new Map([[1, LIVE_L(242)]]), 242, 243);
    expect(diffRowReadBack(['HHI', ''], [['HHI', 'sani@example.org']], expected, [['HHI', LIVE_L(243)]])).toEqual([]);
    expect(diffRowReadBack(['HHI', ''], [['HHI', 'sani@example.org']], expected, [['HHI', 'sani@example.org']])).toEqual([
      { column: 'B', wrote: LIVE_L(243), read: 'sani@example.org' },
    ]);
  });
});

describe('checkJoinDate', () => {
  const base = { today: '2026-10-16', isoPattern: '\\d{4}-\\d{2}-\\d{2}' };

  it("passes the org's own submission date", () => {
    expect(checkJoinDate({ ...base, joined: '2026-10-05', submitted: '2026-10-05' }).ok).toBe(true);
  });

  it('fails today when the org submitted earlier: the day ACE writes is not a join date', () => {
    const r = checkJoinDate({ ...base, joined: '2026-10-16', submitted: '2026-10-05' });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/is today/);
  });

  it('allows today only when the org itself submitted today', () => {
    expect(checkJoinDate({ ...base, joined: '2026-10-16', submitted: '2026-10-16' }).ok).toBe(true);
  });

  it('fails a blank date when a submission date exists, and a future submission date', () => {
    expect(checkJoinDate({ ...base, joined: '', submitted: '2026-10-05' }).ok).toBe(false);
    expect(checkJoinDate({ ...base, joined: '2026-11-01', submitted: '2026-11-01' }).ok).toBe(false);
  });

  it('with no submission date, requires a blank date and says so', () => {
    const r = checkJoinDate({ ...base, joined: '', submitted: 'none' });
    expect(r.ok).toBe(true);
    expect(r.missing).toMatch(/blank/);
    expect(checkJoinDate({ ...base, joined: '2026-10-05', submitted: 'none' }).ok).toBe(false);
  });

  it('refuses a --submitted that is not a calendar date', () => {
    expect(() => checkJoinDate({ ...base, joined: '', submitted: '2026-02-30' })).toThrow(/--submitted/);
    expect(() => checkJoinDate({ ...base, joined: '', submitted: '' })).toThrow(/--submitted/);
    expect(isCalendarDate('2026-10-05')).toBe(true);
  });
});

describe('checkJoinDate on the real dates tab (the 2026-10-15 ULAB adds)', () => {
  // Captured read-only from the live dates tab and connect-labs main; see the fixture's _source.
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'llo-directory', 'dates-tab-2026-10-18.json'), 'utf8'),
  ) as { stamped_by_import: string; added_by_ace: string; directory_py: string; rows: { joined: string; basis: string }[] };
  // The fixture's real _ISO_DATE + parse_dates in place of this file's abridged ones.
  const realPy = DIRECTORY_PY.split('\n\ndef parse_dates')[0].replace(/^_ISO_DATE.*$/m, '') + '\n\n' + fixture.directory_py;
  const contract = parseDirectoryContract(realPy);
  const eoiRows = fixture.rows.filter((r) => r.joined);
  const isoPattern = contract.isoDatePattern;

  it('reads the join-date column and ISO rule out of the real parse_dates', () => {
    expect(contract.datesColumns).toHaveLength(3);
    expect(contract.datesColumns).toContain(contract.datesJoinedHeader);
    expect(eoiRows).toHaveLength(19);
  });

  it("passes each org's own submission date, as the hand-fixed rows carry it", () => {
    for (const r of eoiRows) {
      expect(checkJoinDate({ joined: r.joined, submitted: r.joined, today: fixture.added_by_ace, isoPattern }).ok).toBe(true);
    }
  });

  it('fails every one of the 19 when dated the day the import stamped instead of its submission date', () => {
    for (const r of eoiRows) {
      const check = checkJoinDate({ joined: fixture.stamped_by_import, submitted: r.joined, today: fixture.stamped_by_import, isoPattern });
      expect(check.ok, r.joined).toBe(false);
      expect(check.problems.join(' ')).toMatch(/is today/);
    }
  });

  it('fails a blank date (no dates row) for an org that has a submission date', () => {
    for (const r of eoiRows) {
      expect(checkJoinDate({ joined: '', submitted: r.joined, today: fixture.added_by_ace, isoPattern }).ok).toBe(false);
    }
  });

  it('the inbound row with no recoverable date stays blank under --submitted none', () => {
    const inbound = fixture.rows.find((r) => !r.joined)!;
    expect(checkJoinDate({ joined: inbound.joined, submitted: 'none', today: fixture.added_by_ace, isoPattern }).ok).toBe(true);
  });
});
