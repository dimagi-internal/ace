/**
 * Controls for skills/supply-chain-operate-qa/checks.ts.
 *
 * Grounded on a LIVE labs capture (program 10605, store 149, item 220,
 * read-only, 2026-10-18; see the fixture's `_provenance`). The capture is what
 * set the unit rule: stock_flow carries 1000 TESTS into the store while
 * stock_position says 20 KITS, at 50 tests a kit, and a naive comparison fails
 * a correct ledger. Consignments, distributions and counts are empty in that
 * programme, so their rows are built in the shapes the live tool SCHEMAS
 * declare (a named residual).
 *
 * Commissioned by the optional labs track spec + plan (ace#3152, § F5).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  checkConsignmentsReceived,
  checkCountsReadBack,
  checkDistributionsReadBack,
  checkFindingsListedByAudience,
  checkFlowsBalance,
  checkNoStockConflicts,
  checkStockoutRecorded,
  normalizeReadback,
  onHandInFlowUnit,
  type OperatePlan,
  type OperateReadback,
  type RawReadback,
} from '../../../skills/supply-chain-operate-qa/checks';

const LIVE = readFileSync(new URL('./fixtures/labs-program-10605-store-149.json', import.meta.url), 'utf-8');

function live(capture: string): OperateReadback {
  return normalizeReadback(JSON.parse(capture) as RawReadback);
}

function plan(capture: string): OperatePlan {
  const item = (JSON.parse(capture) as { item: { id: number; base_unit: string; pack_unit: string; base_per_pack: number } }).item;
  return {
    program_id: 10605,
    week: 1,
    item: { id: item.id, base_unit: item.base_unit, pack_unit: item.pack_unit, base_per_pack: item.base_per_pack },
    consignments: [],
    distributions: [],
    counts: [],
    stockout_week: false,
  };
}

function doc(capture: string, mut?: (p: OperatePlan, rb: OperateReadback) => void): string {
  const rb = live(capture);
  const p = plan(capture);
  mut?.(p, rb);
  return JSON.stringify({ plan: p, readback: rb });
}

describe('normalizeReadback on the live capture', () => {
  it("keeps the flow in its base unit and on-hand in the store's unit", () => {
    const rb = live(LIVE);
    expect(rb.flow).toEqual({ unit: 'test', adjusted: 0, stores: ['p149'], links: [{ source: 'c187', target: 'p149', total: 1000 }] });
    expect(rb.on_hand).toEqual({ '149': { amount: '20', unit: 'kit' } });
  });

  it('onHandInFlowUnit converts packs to base units with base_per_pack, and refuses an unrelated unit', () => {
    const item = plan(LIVE).item;
    expect(onHandInFlowUnit({ amount: '20', unit: 'kit' }, item, 'test')).toBe('1000');
    expect(onHandInFlowUnit({ amount: '1000', unit: 'test' }, item, 'test')).toBe('1000');
    expect(onHandInFlowUnit({ amount: '3', unit: 'case' }, item, 'test')).toBeNull();
  });
});

describe('supply-chain-operate-qa checks, grounded on program 10605 store 149', () => {
  it('checkFlowsBalance: the live 1000 tests in = 20 kits on hand passes; a naive comparison is what it must NOT do', () => {
    expect(checkFlowsBalance(doc(LIVE)).pass).toBe(true);
    // 20 tests on hand would mean 980 left with no movement recorded.
    const r = checkFlowsBalance(doc(LIVE, (_p, rb) => (rb.on_hand['149'] = { amount: '20', unit: 'test' })));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('1000 test');
  });

  it('checkFlowsBalance: an outflow to a worker is subtracted; an unrecorded one fails', () => {
    const withOut = (onHandKits: string) =>
      doc(LIVE, (_p, rb) => {
        rb.flow.links.push({ source: 'p149', target: 'w-flw-001', total: 250 });
        rb.on_hand['149'] = { amount: onHandKits, unit: 'kit' };
      });
    expect(checkFlowsBalance(withOut('15')).pass).toBe(true);
    expect(checkFlowsBalance(withOut('20')).pass).toBe(false);
  });

  it('checkFlowsBalance: with adjustments labs does not draw per store, a mismatch is reported, not failed', () => {
    const r = checkFlowsBalance(
      doc(LIVE, (_p, rb) => {
        rb.flow.adjusted = 50;
        rb.on_hand['149'] = { amount: '19', unit: 'kit' };
      }),
    );
    expect(r.pass).toBe(true);
    expect(r.detail).toContain('adjusted');
  });

  it('checkConsignmentsReceived: a received consignment at the planned quantity passes; one still dispatched, or short of plan, fails', () => {
    const planned = { key: 'w1-central-regional', from_supply_point_id: 149, to_supply_point_id: 150, quantity: '10', quantity_received: '9' };
    const mk = (status: string, received: string | null) =>
      doc(LIVE, (p, rb) => {
        p.consignments = [planned];
        rb.consignments = [{ id: 1, reference: planned.key, status, quantity: '10', quantity_received: received }];
      });
    expect(checkConsignmentsReceived(mk('received', '9')).pass).toBe(true);
    expect(checkConsignmentsReceived(mk('dispatched', null)).pass).toBe(false);
    expect(checkConsignmentsReceived(mk('received', '10')).pass).toBe(false);
    expect(checkConsignmentsReceived(doc(LIVE, (p) => (p.consignments = [planned]))).pass).toBe(false);
  });

  it('checkDistributionsReadBack: lines summing to the plan per worker pass; a missing worker fails', () => {
    const d = doc(LIVE, (p, rb) => {
      p.distributions = [{ connect_username: 'syn-flw-001', quantity: '5' }];
      rb.distribution_lines = [
        { connect_username: 'syn-flw-001', quantity: '3' },
        { connect_username: 'syn-flw-001', quantity: '2' },
      ];
    });
    expect(checkDistributionsReadBack(d).pass).toBe(true);
    expect(checkDistributionsReadBack(doc(LIVE, (p) => (p.distributions = [{ connect_username: 'syn-flw-002', quantity: '5' }]))).pass).toBe(false);
  });

  it('checkCountsReadBack and checkStockoutRecorded: the planned zero must read back', () => {
    const zero = (recorded: boolean) =>
      doc(LIVE, (p, rb) => {
        p.counts = [{ supply_point_id: 301, quantity: '0' }];
        p.stockout_week = true;
        if (recorded) rb.counts = [{ supply_point_id: 301, quantity: '0' }];
      });
    expect(checkCountsReadBack(zero(true)).pass).toBe(true);
    expect(checkStockoutRecorded(zero(true)).pass).toBe(true);
    expect(checkCountsReadBack(zero(false)).pass).toBe(false);
    expect(checkStockoutRecorded(zero(false)).pass).toBe(false);
    expect(checkStockoutRecorded(doc(LIVE)).pass).toBe(true);
  });

  it('checkFindingsListedByAudience: every open finding listed passes; a dropped one fails, by kind and audience', () => {
    const open = [
      { category: 'threshold', kind: 'stock_stockout', audience: 'partner' },
      { category: 'missing', kind: 'payment_unconfirmed', audience: 'ours' },
    ];
    expect(
      checkFindingsListedByAudience(
        doc(LIVE, (_p, rb) => {
          rb.checks = open;
          rb.listed = open.map(({ kind, audience }) => ({ kind, audience }));
        }),
      ).pass,
    ).toBe(true);
    const r = checkFindingsListedByAudience(
      doc(LIVE, (_p, rb) => {
        rb.checks = open;
        rb.listed = [{ kind: 'stock_stockout', audience: 'partner' }];
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('payment_unconfirmed|ours');
  });

  it('checkNoStockConflicts: none passes; stock_negative fails', () => {
    expect(checkNoStockConflicts(doc(LIVE)).pass).toBe(true);
    expect(checkNoStockConflicts(doc(LIVE, (_p, rb) => rb.checks.push({ category: 'conflict', kind: 'stock_negative', audience: 'ours' }))).pass).toBe(false);
  });

  it('every failure carries an auto-fix hint, and a malformed artifact never passes', () => {
    const allBad = doc(LIVE, (p, rb) => {
      rb.on_hand['149'] = { amount: '1', unit: 'kit' };
      p.consignments = [{ key: 'k', from_supply_point_id: 1, to_supply_point_id: 2, quantity: '1', quantity_received: '1' }];
      p.distributions = [{ connect_username: 'x', quantity: '1' }];
      p.counts = [{ supply_point_id: 9, quantity: '0' }];
      p.stockout_week = true;
      rb.checks = [{ category: 'conflict', kind: 'stock_negative', audience: 'ours' }];
      rb.listed = [];
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
