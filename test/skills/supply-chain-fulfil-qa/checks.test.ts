/**
 * Controls for skills/supply-chain-fulfil-qa/checks.ts.
 *
 * Grounded on a LIVE labs capture (program 10605, contract 187, read-only,
 * 2026-10-18; see the fixture's `_provenance`): a goods received note for 20
 * of 20 kits and labs' three-way match reading fully_received, nothing
 * invoiced, payable_now USD 760 (what ARRIVED). The programme holds no
 * shipments, invoices or payments, so the negative controls add rows in the
 * shapes the live tool SCHEMAS declare; that is a named residual.
 *
 * Commissioned by the optional labs track spec + plan (ace#3152, § F4).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  checkAdvancesMatched,
  checkDisputesResolved,
  checkNoFulfilmentFindings,
  checkNotOverInvoiced,
  checkPaidWithinArrived,
  checkReceivedEqualsAccepted,
  checkRejectionsAsPlanned,
  checkShipmentsReceived,
  normalizeChecks,
  normalizeContract,
  type FulfilPlan,
  type FulfilReadback,
  type RawContractReadback,
} from '../../../skills/supply-chain-fulfil-qa/checks';

const LIVE = readFileSync(new URL('./fixtures/labs-program-10605-contract-187.json', import.meta.url), 'utf-8');

function live(capture: string): FulfilReadback {
  const raw = JSON.parse(capture) as RawContractReadback & { checks_list: { checks: [] } };
  return { contracts: [normalizeContract(187, raw)], checks: normalizeChecks(raw.checks_list) };
}

function plan(): FulfilPlan {
  return { program_id: 10605, contracts: [{ contract_id: 187, planned_rejected: '0', advance: false }] };
}

function doc(capture: string, mut?: (p: FulfilPlan, rb: FulfilReadback) => void): string {
  const rb = live(capture);
  const p = plan();
  mut?.(p, rb);
  return JSON.stringify({ plan: p, readback: rb });
}

describe('normalizeContract on the live capture', () => {
  it("reads labs' three-way match amounts and the receipt lines", () => {
    const c = live(LIVE).contracts[0];
    expect(c.receipts).toEqual([{ id: 94, shipment_id: null, lines: [{ quantity_accepted: '20', quantity_rejected: '0', rejection_reason: '' }] }]);
    expect(c.match).toEqual({
      status: 'fully_received',
      ordered: '20',
      received: '20',
      refused: '0',
      over_invoiced: '-20',
      paid_amount: '0',
      payable_now: '760',
      payment_terms: 'on_delivery',
      advance_state: null,
    });
  });
});

describe('supply-chain-fulfil-qa checks, grounded on program 10605 contract 187', () => {
  it('checkReceivedEqualsAccepted: 20 accepted = 20 received passes; a receipt short of the match fails', () => {
    expect(checkReceivedEqualsAccepted(doc(LIVE)).pass).toBe(true);
    expect(checkReceivedEqualsAccepted(doc(LIVE, (_p, rb) => (rb.contracts[0].match.received = '22'))).pass).toBe(false);
    expect(checkReceivedEqualsAccepted(doc(LIVE, (_p, rb) => (rb.contracts[0].receipts = []))).pass).toBe(false);
  });

  it('checkRejectionsAsPlanned: none planned, none made passes; the planned partial rejection must be there with a reason', () => {
    expect(checkRejectionsAsPlanned(doc(LIVE)).pass).toBe(true);
    expect(checkRejectionsAsPlanned(doc(LIVE, (p) => (p.contracts[0].planned_rejected = '2'))).pass).toBe(false);
    const withReason = (reason: string) =>
      doc(LIVE, (p, rb) => {
        p.contracts[0].planned_rejected = '2';
        rb.contracts[0].receipts[0].lines.push({ quantity_accepted: '0', quantity_rejected: '2', rejection_reason: reason });
      });
    expect(checkRejectionsAsPlanned(withReason('crushed cartons')).pass).toBe(true);
    expect(checkRejectionsAsPlanned(withReason('')).pass).toBe(false);
  });

  it('checkShipmentsReceived: the live receipt-without-shipment passes; an undelivered or unreceipted shipment fails', () => {
    expect(checkShipmentsReceived(doc(LIVE)).pass).toBe(true);
    expect(checkShipmentsReceived(doc(LIVE, (_p, rb) => rb.contracts[0].shipments.push({ id: 5, status: 'in_transit' }))).pass).toBe(false);
    expect(
      checkShipmentsReceived(
        doc(LIVE, (_p, rb) => {
          rb.contracts[0].shipments.push({ id: 5, status: 'delivered' });
          rb.contracts[0].receipts[0].shipment_id = 5;
        }),
      ).pass,
    ).toBe(true);
  });

  it('checkDisputesResolved: no invoice passes; a queried invoice fails, an approved one passes', () => {
    expect(checkDisputesResolved(doc(LIVE)).pass).toBe(true);
    expect(checkDisputesResolved(doc(LIVE, (_p, rb) => rb.contracts[0].invoices.push({ id: 7, status: 'queried' }))).pass).toBe(false);
    expect(checkDisputesResolved(doc(LIVE, (_p, rb) => rb.contracts[0].invoices.push({ id: 7, status: 'approved' }))).pass).toBe(true);
  });

  it("checkNotOverInvoiced: labs' -20 (nothing billed) passes; a positive over-invoice fails", () => {
    expect(checkNotOverInvoiced(doc(LIVE)).pass).toBe(true);
    expect(checkNotOverInvoiced(doc(LIVE, (_p, rb) => (rb.contracts[0].match.over_invoiced = '2'))).pass).toBe(false);
    expect(checkNotOverInvoiced(doc(LIVE, (_p, rb) => (rb.contracts[0].match.over_invoiced = '0'))).pass).toBe(true);
  });

  it('normalizeContract reads the contract unit_price, and leaves it null when the caller passes no contract', () => {
    expect(live(LIVE).contracts[0].unit_price).toBe('38');
    const raw = JSON.parse(LIVE) as RawContractReadback;
    delete raw.contract;
    expect(normalizeContract(187, raw).unit_price).toBeNull();
    expect(normalizeContract(187, { ...raw, contract: { value: { unit_price: '41500' } } }).unit_price).toBe('41500');
  });

  it('checkPaidWithinArrived: 0 of 760 passes, exactly 760 passes, 800 fails', () => {
    expect(checkPaidWithinArrived(doc(LIVE)).pass).toBe(true);
    expect(checkPaidWithinArrived(doc(LIVE, (_p, rb) => (rb.contracts[0].match.paid_amount = '760.00'))).pass).toBe(true);
    expect(checkPaidWithinArrived(doc(LIVE, (_p, rb) => (rb.contracts[0].match.paid_amount = '800'))).pass).toBe(false);
  });

  it('checkAdvancesMatched: off when no advance is planned; a planned advance on on_delivery terms with no payment fails', () => {
    expect(checkAdvancesMatched(doc(LIVE)).pass).toBe(true);
    expect(checkAdvancesMatched(doc(LIVE, (p) => (p.contracts[0].advance = true))).pass).toBe(false);
    const advanced = doc(LIVE, (p, rb) => {
      p.contracts[0].advance = true;
      rb.contracts[0].match.payment_terms = 'advance';
      rb.contracts[0].match.advance_state = 'paid';
    });
    expect(checkAdvancesMatched(advanced).pass).toBe(true);
  });

  it('checkNoFulfilmentFindings: none passes; payment_unconfirmed (missing) and invoice_over_billed (conflict) fail', () => {
    expect(checkNoFulfilmentFindings(doc(LIVE)).pass).toBe(true);
    expect(checkNoFulfilmentFindings(doc(LIVE, (_p, rb) => rb.checks.push({ category: 'missing', kind: 'payment_unconfirmed' }))).pass).toBe(false);
    expect(checkNoFulfilmentFindings(doc(LIVE, (_p, rb) => rb.checks.push({ category: 'conflict', kind: 'invoice_over_billed' }))).pass).toBe(false);
    expect(checkNoFulfilmentFindings(doc(LIVE, (_p, rb) => rb.checks.push({ category: 'missing', kind: 'stock_unconfirmed' }))).pass).toBe(true);
  });

  it('every failure carries an auto-fix hint, and a malformed artifact never passes', () => {
    const allBad = doc(LIVE, (p, rb) => {
      p.contracts[0].planned_rejected = '3';
      p.contracts[0].advance = true;
      const c = rb.contracts[0];
      c.match.received = '25';
      c.match.over_invoiced = '4';
      c.match.paid_amount = '1000';
      c.shipments.push({ id: 5, status: 'in_transit' });
      c.invoices.push({ id: 7, status: 'queried' });
      rb.checks.push({ category: 'missing', kind: 'payment_unconfirmed' });
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

/**
 * ace#3260: labs programme 361 contract 323 (run connect-fi/20261018-1440).
 * Ordered 820 handsets at UGX 41,500, received 814, refused 6, an advance of
 * 10,000,000 (payment 171), then the balance 23,781,000 (payment 172). The
 * contract_match numbers are quoted verbatim in the issue; payable_now is NET
 * of payments recorded, so it read 23,781,000 after the advance and 0 once paid.
 */
describe('checkPaidWithinArrived on contract 323 (payable_now is net of payments, ace#3260)', () => {
  const PROGRAMME = 361;
  const CONTRACT = 323;

  function c323(paid: string, payableNow: string, opts: { withContract?: boolean } = {}): string {
    const raw: RawContractReadback = {
      shipment_list: { value: [{ id: 1, status: 'delivered' }] },
      receipt_list: {
        value: [{ id: 2, shipment_id: 1, lines: [{ quantity_accepted: '814', quantity_rejected: '6', rejection_reason: 'damaged' }] }],
      },
      invoice_list: { value: [{ id: 3, status: 'approved' }] },
      payment_list: { value: [{ id: 171, invoice_id: null, amount: '10000000' }] },
      contract_match: {
        status: 'fully_received',
        payment_terms: 'advance',
        advance_state: 'paid',
        ordered: { amount: '820' },
        received: { amount: '814' },
        refused: { amount: '6' },
        over_invoiced: null,
        paid_amount: { amount: paid },
        payable_now: { amount: payableNow },
      },
      ...(opts.withContract === false ? {} : { contract: { id: CONTRACT, quantity: '820', unit_price: '41500', payment_terms: 'advance' } }),
    };
    const p: FulfilPlan = { program_id: PROGRAMME, contracts: [{ contract_id: CONTRACT, planned_rejected: '6', advance: true }] };
    return JSON.stringify({ plan: p, readback: { contracts: [normalizeContract(CONTRACT, raw)], checks: [] } });
  }

  it('after the advance only (paid 10,000,000, payable_now 23,781,000) passes', () => {
    expect(checkPaidWithinArrived(c323('10000000', '23781000')).pass).toBe(true);
  });

  it('fully paid (paid 33,781,000 = 814 x 41,500, payable_now 0) passes — the case the old check failed', () => {
    const r = checkPaidWithinArrived(c323('33781000', '0'));
    expect(r.pass, r.detail).toBe(true);
  });

  it('paid above 814 x 41,500 fails, naming the value arrived', () => {
    const r = checkPaidWithinArrived(c323('34030000', '0'));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('only 33781000 arrived');
    expect(r.auto_fix_hint).toBeTruthy();
  });

  it('without the contract the value arrived is unavailable: the detail says so, and only payable_now >= 0 is judged', () => {
    const r = checkPaidWithinArrived(c323('33781000', '0', { withContract: false }));
    expect(r.pass).toBe(true);
    expect(r.detail).toMatch(/value arrived unavailable for contract 323/);
    expect(checkPaidWithinArrived(c323('33781000', '-249000', { withContract: false })).pass).toBe(false);
  });
});
