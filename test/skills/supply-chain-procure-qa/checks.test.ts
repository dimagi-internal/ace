/**
 * Controls for skills/supply-chain-procure-qa/checks.ts.
 *
 * Grounded on a LIVE labs capture (program 10605, tender 60, read-only,
 * 2026-10-18; see the fixture's `_provenance`). That capture is a real award to
 * the NON-cheapest quote with a stated reason (the cheaper kit fails the item
 * specification), so it is the positive control for the rule that an award may
 * go to a dearer quote when it says why, and the negative control is the same
 * award with its rationale stripped.
 *
 * Commissioned by the optional labs track spec + plan (ace#3152, § F3), whose
 * irreversibility rule (§ F6: no tender, award or contract can be deleted) is
 * why a mismatched contract must be caught here, before goods and money move.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  checkAwardComparisonRankable,
  checkBuyerMatchesRunner,
  checkContractMatchesAward,
  checkNoProcurementConflicts,
  checkNonCheapestAwardExplained,
  checkOneAwardPerLine,
  checkQuotesPerLine,
  checkSuppliersSynthetic,
  checkTenderAwarded,
  decimalEq,
  normalizeReadback,
  type ProcurePlan,
  type ProcureReadback,
  type RawReadback,
} from '../../../skills/supply-chain-procure-qa/checks';

const LIVE = readFileSync(new URL('./fixtures/labs-program-10605-tender-60.json', import.meta.url), 'utf-8');

function live(capture: string): ProcureReadback {
  return normalizeReadback(JSON.parse(capture) as RawReadback, 60);
}

/** A plan consistent with what the live programme holds (so every check passes on it). */
function planMatching(): ProcurePlan {
  return {
    program_id: 10605,
    lines: [{ commodity_slug: 'chlorine-test-kit', quantity: '20', quantity_unit: 'kit' }],
    buyer_of_record: 'programme_org',
    buyer_org_id: 2,
    min_quotes_per_line: 2,
    simulated: false,
  };
}

function doc(capture: string, mut?: (plan: ProcurePlan, readback: ProcureReadback) => void): string {
  const readback = live(capture);
  const plan = planMatching();
  mut?.(plan, readback);
  return JSON.stringify({ plan, readback });
}

describe('normalizeReadback on the live capture', () => {
  it("reads labs' shapes: the award's frozen ranking column, live quotes, the contract", () => {
    const rb = live(LIVE);
    expect(rb.tender).toEqual({
      id: 60,
      status: 'awarded',
      lines: [{ commodity_slug: 'chlorine-test-kit', quantity: '20', quantity_unit: 'kit' }],
    });
    expect(rb.quotes.map((q) => q.id).sort()).toEqual([166, 167]);
    expect(rb.quotes.every((q) => q.live)).toBe(true);
    expect(rb.awards[0]).toMatchObject({ id: 95, quote_id: 166, provisional: false, unrankable_columns: [] });
    expect(rb.awards[0].ranked).toEqual([
      { quote_id: 167, amount: '590' },
      { quote_id: 166, amount: '760' },
    ]);
    expect(rb.contracts[0]).toMatchObject({ id: 187, award_id: 95, unit_price: '38', buyer_of_record: 'programme_org' });
    expect(rb.supplier_names['chlorine-test-kit']).toEqual(['Harmattan Health Supplies', 'Harmattan Health Supplies']);
  });

  it('a voided or superseded quote is not live', () => {
    const raw = JSON.parse(LIVE) as RawReadback;
    raw.quote_list.value[0].voided = true;
    raw.quote_list.value[1].superseded_by_quote_id = 999;
    expect(normalizeReadback(raw, 60).quotes.every((q) => !q.live)).toBe(true);
  });
});

describe('decimalEq', () => {
  it('treats "38" and "38.00" as one price, and 38 vs 38.01 as two', () => {
    expect(decimalEq('38', '38.00')).toBe(true);
    expect(decimalEq('29.5', '29.50')).toBe(true);
    expect(decimalEq('38', '38.01')).toBe(false);
  });
});

describe('supply-chain-procure-qa checks, grounded on program 10605 tender 60', () => {
  it('checkTenderAwarded: awarded passes, closed passes, open fails', () => {
    expect(checkTenderAwarded(doc(LIVE)).pass).toBe(true);
    expect(checkTenderAwarded(doc(LIVE, (_p, rb) => (rb.tender.status = 'closed'))).pass).toBe(true);
    expect(checkTenderAwarded(doc(LIVE, (_p, rb) => (rb.tender.status = 'open'))).pass).toBe(false);
  });

  it('checkOneAwardPerLine: one passes; none and two fail', () => {
    expect(checkOneAwardPerLine(doc(LIVE)).pass).toBe(true);
    expect(checkOneAwardPerLine(doc(LIVE, (_p, rb) => (rb.awards = []))).pass).toBe(false);
    expect(checkOneAwardPerLine(doc(LIVE, (_p, rb) => rb.awards.push({ ...rb.awards[0], id: 96 }))).pass).toBe(false);
  });

  it('checkAwardComparisonRankable: the live frozen comparison passes; a blocked column fails', () => {
    expect(checkAwardComparisonRankable(doc(LIVE)).pass).toBe(true);
    const r = checkAwardComparisonRankable(doc(LIVE, (_p, rb) => (rb.awards[0].unrankable_columns = ['landed_total_for_round_quantity'])));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('landed_total_for_round_quantity');
  });

  it('checkContractMatchesAward: the live contract carries the awarded quote; the cheaper quote\'s price fails', () => {
    expect(checkContractMatchesAward(doc(LIVE)).pass).toBe(true);
    const price = checkContractMatchesAward(doc(LIVE, (_p, rb) => (rb.contracts[0].unit_price = '29.5')));
    expect(price.pass).toBe(false);
    expect(price.detail).toContain('unit price 29.5');
    expect(checkContractMatchesAward(doc(LIVE, (_p, rb) => (rb.contracts[0].item_id = 221))).pass).toBe(false);
    expect(checkContractMatchesAward(doc(LIVE, (_p, rb) => (rb.contracts[0].quantity = '25'))).pass).toBe(false);
    expect(checkContractMatchesAward(doc(LIVE, (_p, rb) => (rb.contracts = []))).pass).toBe(false);
  });

  it('checkBuyerMatchesRunner: programme_org/2 passes; partner_org fails', () => {
    expect(checkBuyerMatchesRunner(doc(LIVE)).pass).toBe(true);
    expect(checkBuyerMatchesRunner(doc(LIVE, (p) => (p.buyer_of_record = 'partner_org'))).pass).toBe(false);
  });

  it('checkQuotesPerLine: 2 live quotes meets 2; the spec’s simulated minimum of 3 fails on this tender', () => {
    expect(checkQuotesPerLine(doc(LIVE)).pass).toBe(true);
    expect(checkQuotesPerLine(doc(LIVE, (p) => (p.min_quotes_per_line = 3))).pass).toBe(false);
  });

  it('checkNonCheapestAwardExplained: the live dearer award with its stated reason passes; stripped of the reason it fails', () => {
    const ok = checkNonCheapestAwardExplained(doc(LIVE));
    expect(ok.pass).toBe(true);
    expect(ok.detail).toContain('not the cheapest');
    const r = checkNonCheapestAwardExplained(doc(LIVE, (_p, rb) => (rb.awards[0].rationale = 'best')));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('760 vs 590');
  });

  it('checkNonCheapestAwardExplained: an award to the cheapest needs no rationale length', () => {
    const r = checkNonCheapestAwardExplained(
      doc(LIVE, (_p, rb) => {
        rb.awards[0].quote_id = 167;
        rb.awards[0].rationale = 'ok';
      }),
    );
    expect(r.pass).toBe(true);
  });

  it('checkSuppliersSynthetic: off the simulated track passes; on it, the real supplier name fails', () => {
    expect(checkSuppliersSynthetic(doc(LIVE)).pass).toBe(true);
    const r = checkSuppliersSynthetic(doc(LIVE, (p) => (p.simulated = true)));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('Harmattan Health Supplies');
    expect(
      checkSuppliersSynthetic(
        doc(LIVE, (p, rb) => {
          p.simulated = true;
          rb.supplier_names = { 'chlorine-test-kit': ['Lake Kits Ltd [Synthetic]'] };
        }),
      ).pass,
    ).toBe(true);
  });

  it('checkNoProcurementConflicts: none passes; award_not_contracted fails', () => {
    expect(checkNoProcurementConflicts(doc(LIVE)).pass).toBe(true);
    expect(checkNoProcurementConflicts(doc(LIVE, (_p, rb) => rb.checks.push({ category: 'conflict', kind: 'award_not_contracted' }))).pass).toBe(false);
  });

  it('every failure carries an auto-fix hint, and a malformed artifact never passes', () => {
    const allBad = doc(LIVE, (p, rb) => {
      p.simulated = true;
      p.min_quotes_per_line = 5;
      p.buyer_of_record = 'partner_org';
      rb.tender.status = 'draft';
      rb.awards.push({ ...rb.awards[0], id: 96 });
      rb.awards[0].unrankable_columns = ['x'];
      rb.awards[0].rationale = '';
      rb.contracts[0].unit_price = '1';
      rb.checks.push({ category: 'conflict', kind: 'award_not_contracted' });
    });
    for (const c of CHECKS) {
      const r = c.run(allBad) as { pass: boolean; auto_fix_hint?: string };
      expect(r.pass, c.id).toBe(false);
      expect(r.auto_fix_hint, c.id).toBeTruthy();
      expect((c.run('not json') as { pass: boolean }).pass, c.id).toBe(false);
      expect((c.run('{}') as { pass: boolean }).pass, c.id).toBe(false);
    }
  });
});
