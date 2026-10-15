// lib/llo-directory.ts — the pure half of skills/llo-directory-add (dimagi-internal/ace#2920).
//
// The fixtures below are abridged from connect-labs 6ecaf66
// (connect_labs/marketplace/directory.py + quality.py). They are FIXTURES for the
// parser, not ACE's copy of the layout: production reads both modules from
// connect-labs main at run time.

import { describe, it, expect } from 'vitest';
import {
  DIRECTORY_MODULE,
  QUALITY_MODULE,
  DirectoryContractError,
  assertUpstreamRulesUnchanged,
  buildRow,
  columnLetter,
  diffReadBack,
  findDuplicates,
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
    });
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
