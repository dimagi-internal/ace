import { describe, expect, it } from 'vitest';
import { batchDuplicates, planBatchWrites } from '../../lib/llo-directory.js';

const HEADER = ['Organization Name', 'Website', 'Notes', 'Emails from Contacts'];
const emailFormula = (n: number) => `=IFERROR(TEXTJOIN("; ", TRUE, FILTER(Contacts!C:C, Contacts!B:B=A${n})), "")`;

describe('planBatchWrites', () => {
  const rows = [
    ['Alpha', 'https://a.example.invalid', 'n1', ''],
    ['Beta', '', 'n2', ''],
    ['Gamma', '', 'n3', ''],
  ];
  const formulas = new Map([[3, emailFormula(9)]]);
  const writes = planBatchWrites({ tab: 'Organizations', headerRow: HEADER, rows, firstRow: 10, precedentRow: 9, formulas });

  it('writes the whole block in ONE RAW call and each formula column in ONE call', () => {
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ range: "'Organizations'!A10:D12", input: 'RAW' });
    expect(writes[0].values).toEqual(rows);
    expect(writes[1]).toMatchObject({ range: "'Organizations'!D10:D12", input: 'USER_ENTERED' });
  });

  it('moves the precedent formula down to each row', () => {
    expect(writes[1].values.map((v) => v[0])).toEqual([emailFormula(10), emailFormula(11), emailFormula(12)]);
  });

  it('refuses a drafted value in a formula column rather than overwrite the formula', () => {
    const bad = [['Alpha', '', '', 'literal@example.invalid']];
    expect(() => planBatchWrites({ tab: 'Organizations', headerRow: HEADER, rows: bad, firstRow: 10, precedentRow: 9, formulas })).toThrow(
      /holds a formula/,
    );
  });

  it('writes nothing for an empty batch and no formula writes where the tab has none', () => {
    expect(planBatchWrites({ tab: 'Organizations', headerRow: HEADER, rows: [], firstRow: 10, precedentRow: 9, formulas })).toEqual([]);
    const plain = planBatchWrites({ tab: 'Contacts', headerRow: HEADER, rows, firstRow: 4, precedentRow: 3, formulas: new Map() });
    expect(plain).toHaveLength(1);
    expect(plain[0].range).toBe("'Contacts'!A4:D6");
  });
});

describe('batchDuplicates', () => {
  const existing = [{ row: 2, name: 'Old Org', website: 'https://old.example.invalid' }];

  it('finds a duplicate already on the tab', () => {
    expect(batchDuplicates({ name: 'OLD  org' }, existing, [], 10)).toEqual([{ row: 2, name: 'Old Org', reason: 'folded-name' }]);
  });

  it('finds a duplicate of an EARLIER org in the same batch, reporting the row it would get', () => {
    const hits = batchDuplicates({ name: 'new org' }, existing, [{ name: 'Other' }, { name: 'New Org' }], 10);
    expect(hits).toEqual([{ row: 11, name: 'New Org', reason: 'folded-name' }]);
  });

  it('finds the same site under a different name', () => {
    const hits = batchDuplicates({ name: 'Different Name', website: 'https://old.example.invalid/' }, existing, [], 10);
    expect(hits.map((h) => h.reason)).toEqual(['website']);
  });

  it('is clear for a genuinely new org', () => {
    expect(batchDuplicates({ name: 'Brand New', website: 'https://new.example.invalid' }, existing, [{ name: 'Other' }], 10)).toEqual([]);
  });
});
