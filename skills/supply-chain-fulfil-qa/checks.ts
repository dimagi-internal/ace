/**
 * Static QA checks for `supply-chain-fulfil-qa`.
 *
 * The artifact is ONE JSON document: `{plan, readback}`.
 *   - `plan` is `supply-chain-fulfil`'s plan file: per contract, the shipment
 *     and receipt it meant to record (including the deliberate partial
 *     rejection and over-billed invoice on the simulated track).
 *   - `readback` is what labs returns NOW, per contract: shipments, receipts,
 *     invoices, payments, and labs' own three-way match, normalised with
 *     {@link normalizeReadback}. The verdict reads the read-back, never the
 *     write responses (spec 2026-10-18 § F0).
 *
 * Labs' `contract_match` is computed and never stored, so it is the authority
 * these checks lean on rather than ACE's own sums. Its `payable_now` is what
 * is still safe to pay — the value that arrived NET of payments already
 * recorded — not the value that arrived (ace#3260: labs programme 361
 * contract 323, 814 received at UGX 41,500 with a 10,000,000 advance, read
 * payable_now 23,781,000; once paid in full, paid 33,781,000 and payable_now
 * 0). So the value that ARRIVED is `received × unit_price`, and the unit
 * price comes from the contract (`supply_chain_contract_get`, or its row in
 * `supply_chain_contract_list`), passed as `RawContractReadback.contract`.
 * Grounded on live captures of labs program 10605 contract 187
 * (`test/skills/supply-chain-fulfil-qa/fixtures/labs-program-10605-contract-187.json`)
 * and the contract 323 numbers quoted in ace#3260.
 */
import type { QACheck, QACheckResult } from '../../lib/qa-types';
import { decimalCompare, decimalMul, decimalSum as sum } from '../../lib/decimal-string';

export interface FulfilPlan {
  program_id: number;
  contracts: Array<{
    contract_id: number;
    /** Quantity the plan meant to reject on arrival (0 unless this is the planned partial rejection). */
    planned_rejected: string;
    /** True for the contract on payment_terms advance. */
    advance: boolean;
  }>;
}

export interface ContractReadback {
  contract_id: number;
  /**
   * The contract's unit price (contract currency), or null when the caller did
   * not read the contract. Optional so a readback built before ace#3260 still
   * parses; without it `paid_within_arrived` cannot compute the value arrived.
   */
  unit_price?: string | null;
  shipments: Array<{ id: number; status: string }>;
  receipts: Array<{
    id: number;
    shipment_id: number | null;
    lines: Array<{ quantity_accepted: string; quantity_rejected: string; rejection_reason: string }>;
  }>;
  invoices: Array<{ id: number; status: string }>;
  payments: Array<{ id: number; invoice_id: number | null; amount: string }>;
  match: {
    status: string;
    ordered: string;
    received: string;
    refused: string;
    over_invoiced: string;
    paid_amount: string;
    payable_now: string;
    payment_terms: string;
    advance_state: string | null;
  };
}

export interface FulfilReadback {
  contracts: ContractReadback[];
  checks: Array<{ category: string; kind: string }>;
}

/** The raw replies of the QA's reads for ONE contract, as labs returns them. */
export interface RawContractReadback {
  shipment_list: { value: Array<Record<string, unknown>> };
  receipt_list: { value: Array<Record<string, unknown>> };
  invoice_list: { value: Array<Record<string, unknown>> };
  payment_list: { value: Array<Record<string, unknown>> };
  contract_match: Record<string, unknown>;
  /**
   * The contract itself: `supply_chain_contract_get`'s reply, or the
   * contract's row from `supply_chain_contract_list`. Only `unit_price` is
   * read. Optional for backward compatibility; omit it and the value arrived
   * is reported as unavailable.
   */
  contract?: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
const amount = (v: unknown): string => {
  const a = (v ?? {}) as { amount?: unknown };
  return typeof a.amount === 'string' ? a.amount : '0';
};

/** `unit_price` from a contract read, bare or wrapped in `{value: {...}}`; null when absent or not a decimal string. */
function unitPrice(contract: Record<string, unknown> | undefined): string | null {
  if (!contract || typeof contract !== 'object') return null;
  const inner = (contract.value && typeof contract.value === 'object' ? contract.value : contract) as Record<string, unknown>;
  const p = inner.unit_price;
  const v = typeof p === 'string' ? p.trim() : typeof p === 'number' ? String(p) : '';
  return /^-?\d*\.?\d+$/.test(v) ? v : null;
}

export function normalizeContract(contractId: number, raw: RawContractReadback): ContractReadback {
  const m = raw.contract_match ?? {};
  return {
    contract_id: contractId,
    unit_price: unitPrice(raw.contract),
    shipments: arr(raw.shipment_list.value).map((s) => ({ id: num(s.id) as number, status: str(s.status) })),
    receipts: arr(raw.receipt_list.value).map((r) => ({
      id: num(r.id) as number,
      shipment_id: num(r.shipment_id),
      lines: arr(r.lines).map((l) => ({
        quantity_accepted: str(l.quantity_accepted) || '0',
        quantity_rejected: str(l.quantity_rejected) || '0',
        rejection_reason: str(l.rejection_reason),
      })),
    })),
    invoices: arr(raw.invoice_list.value).map((i) => ({ id: num(i.id) as number, status: str(i.status) })),
    payments: arr(raw.payment_list.value).map((p) => ({ id: num(p.id) as number, invoice_id: num(p.invoice_id), amount: str(p.amount) || '0' })),
    match: {
      status: str(m.status),
      ordered: amount(m.ordered),
      received: amount(m.received),
      refused: amount(m.refused),
      over_invoiced: amount(m.over_invoiced),
      paid_amount: amount(m.paid_amount),
      payable_now: amount(m.payable_now),
      payment_terms: str(m.payment_terms),
      advance_state: typeof m.advance_state === 'string' ? m.advance_state : null,
    },
  };
}

export function normalizeChecks(raw: { checks?: Array<Record<string, unknown>> } | undefined): FulfilReadback['checks'] {
  return arr(raw?.checks).map((c) => ({ category: str(c.category), kind: str(c.kind) }));
}

interface Doc {
  plan: FulfilPlan;
  readback: FulfilReadback;
}

function withDoc(artifact: string, fn: (d: Doc) => QACheckResult): QACheckResult {
  let doc: Doc;
  try {
    doc = JSON.parse(artifact) as Doc;
  } catch (e) {
    return { pass: false, detail: `artifact is not JSON: ${(e as Error).message}`, auto_fix_hint: 'Rebuild the {plan, readback} document as JSON.' };
  }
  if (!doc || typeof doc !== 'object' || !doc.plan || !doc.readback || !Array.isArray(doc.readback.contracts)) {
    return { pass: false, detail: 'artifact must be {plan, readback: {contracts, checks}}', auto_fix_hint: 'Re-read labs per contract and rebuild the document.' };
  }
  return fn(doc);
}

function each(doc: Doc, fn: (planned: FulfilPlan['contracts'][number], rb: ContractReadback | undefined) => string[]): string[] {
  return doc.plan.contracts.flatMap((c) => fn(c, doc.readback.contracts.find((r) => r.contract_id === c.contract_id)));
}

export function checkReceivedEqualsAccepted(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const bad = each(doc, (p, rb) => {
      if (!rb) return [`contract ${p.contract_id}: not read back`];
      const accepted = sum(rb.receipts.flatMap((r) => r.lines.map((l) => l.quantity_accepted)));
      const out: string[] = [];
      if (decimalCompare(accepted, rb.match.received) !== 0) {
        out.push(`contract ${p.contract_id}: receipts accept ${accepted}, the three-way match says received ${rb.match.received}`);
      }
      if (rb.receipts.length === 0) out.push(`contract ${p.contract_id}: no goods received note`);
      return out;
    });
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint: 'Stock exists only from a goods received note: record the receipt (supply_chain_receipt_record) for what arrived. A shipment alone posts nothing.',
        };
  });
}

export function checkRejectionsAsPlanned(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const bad = each(doc, (p, rb) => {
      if (!rb) return [];
      const lines = rb.receipts.flatMap((r) => r.lines);
      const rejected = sum(lines.map((l) => l.quantity_rejected));
      const out: string[] = [];
      if (decimalCompare(rejected, p.planned_rejected) !== 0) out.push(`contract ${p.contract_id}: rejected ${rejected}, planned ${p.planned_rejected}`);
      for (const l of lines) if (decimalCompare(l.quantity_rejected, '0') > 0 && !l.rejection_reason.trim()) out.push(`contract ${p.contract_id}: a rejected line has no reason`);
      return out;
    });
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint: 'Rejected quantity stays on the receipt line and never enters stock; give it a rejection_reason. A receipt cannot be deleted, so a wrong one is corrected by a stock movement, not re-recorded.',
        };
  });
}

export function checkShipmentsReceived(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const bad = each(doc, (p, rb) => {
      if (!rb) return [];
      return rb.shipments.flatMap((s) => {
        const out: string[] = [];
        if (s.status !== 'delivered') out.push(`shipment ${s.id} is ${s.status}`);
        if (!rb.receipts.some((r) => r.shipment_id === s.id)) out.push(`shipment ${s.id} has no receipt naming it`);
        return out;
      });
    });
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint: 'Move the shipment to delivered (supply_chain_shipment_update) and record its receipt with shipment_id set, so labs can match batches.',
        };
  });
}

export function checkDisputesResolved(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const bad = doc.readback.contracts.flatMap((c) => c.invoices.filter((i) => i.status === 'queried').map((i) => `invoice ${i.id} (contract ${c.contract_id})`));
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `still queried: ${bad.join(', ')}`,
          auto_fix_hint: "Record the supplier's corrected billing with supply_chain_invoice_update (quantity_billed / unit_price as corrected) and move it to approved; or reject it.",
        };
  });
}

export function checkNotOverInvoiced(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const bad = doc.readback.contracts
      .filter((c) => decimalCompare(c.match.over_invoiced, '0') > 0)
      .map((c) => `contract ${c.contract_id}: over-invoiced by ${c.match.over_invoiced}`);
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint: 'An invoice bills more than arrived. Dispute it (supply_chain_invoice_dispute), then record the corrected figure.',
        };
  });
}

/**
 * Paid never exceeds the value that ARRIVED (`received × unit_price`).
 *
 * `payable_now` is NOT that value: labs nets it of payments already recorded,
 * so comparing paid with it fails every contract with a payment on it and
 * reads 0 on a fully paid one (ace#3260). Without a unit price the value
 * arrived cannot be computed; the check then judges only that labs' net
 * `payable_now` is not negative, and says so in its detail.
 */
export function checkPaidWithinArrived(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const bad: string[] = [];
    const unpriced: number[] = [];
    for (const c of doc.readback.contracts) {
      if (c.unit_price) {
        const arrived = decimalMul(c.match.received, c.unit_price);
        if (decimalCompare(c.match.paid_amount, arrived) > 0) {
          bad.push(`contract ${c.contract_id}: paid ${c.match.paid_amount} but only ${arrived} arrived (${c.match.received} received x ${c.unit_price})`);
        }
      } else {
        unpriced.push(c.contract_id);
        if (decimalCompare(c.match.payable_now, '0') < 0) {
          bad.push(`contract ${c.contract_id}: payable_now ${c.match.payable_now} is negative after paying ${c.match.paid_amount}`);
        }
      }
    }
    const note =
      unpriced.length === 0
        ? undefined
        : `value arrived unavailable for contract ${unpriced.join(', ')}: no unit_price was read, so only payable_now >= 0 was judged (an overpayment labs reports as payable_now 0 is not seen)`;
    return bad.length === 0
      ? note
        ? { pass: true, detail: note }
        : { pass: true }
      : {
          pass: false,
          detail: [...bad, ...(note ? [note] : [])].join('; '),
          auto_fix_hint:
            "Pay what ARRIVED (received x the contract unit_price), never what was billed; contract_match.payable_now is already net of payments made, so it is the balance to pay. An overpayment is recoverable, not deletable: record it in the run and recover it against the next invoice. Pass the contract (supply_chain_contract_get) into the readback so the value arrived can be computed.",
        };
  });
}

export function checkAdvancesMatched(artifact: string): QACheckResult {
  return withDoc(artifact, (doc) => {
    const bad = each(doc, (p, rb) => {
      if (!rb || !p.advance) return [];
      const out: string[] = [];
      // labs' own reading wins: advance_state comes from the payments recorded,
      // never the terms. An unacknowledged advance also shows as invoice_id null.
      const recorded =
        rb.match.advance_state === 'paid' || rb.match.advance_state === 'part_paid' || rb.payments.some((x) => x.invoice_id === null);
      if (!recorded) out.push(`contract ${p.contract_id}: planned an advance, none recorded`);
      if (rb.match.payment_terms !== 'advance') out.push(`contract ${p.contract_id}: payment_terms is ${rb.match.payment_terms}, not advance`);
      return out;
    });
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint: 'Record the advance against contract_id before any invoice exists; the invoice later names it in acknowledges_payment_ids.',
        };
  });
}

export function checkNoFulfilmentFindings(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const bad = readback.checks.filter((c) => c.category === 'conflict' || c.kind === 'payment_unconfirmed');
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `checks_list: ${bad.map((c) => c.kind || c.category).join(', ')}`,
          auto_fix_hint:
            "payment_unconfirmed: record the payee's confirmation (supply_chain_payment_confirm with confirmed_on in the simulated week); a backdated payment is already older than a fortnight. A conflict names the record to correct.",
        };
  });
}

export const CHECKS: QACheck[] = [
  { id: 'received_equals_accepted', type: 'static', description: "Each contract's received quantity (three-way match) equals its receipts' accepted lines", run: checkReceivedEqualsAccepted },
  { id: 'rejections_as_planned', type: 'static', description: 'Rejected quantity is what the plan meant to reject, each with a reason', run: checkRejectionsAsPlanned },
  { id: 'shipments_received', type: 'static', description: 'Every shipment is delivered and has a receipt naming it', run: checkShipmentsReceived },
  { id: 'disputes_resolved', type: 'static', description: 'No invoice is left queried', run: checkDisputesResolved },
  { id: 'not_over_invoiced', type: 'static', description: 'No contract is invoiced for more than arrived', run: checkNotOverInvoiced },
  { id: 'paid_within_arrived', type: 'static', description: 'No contract is paid more than the value that arrived (received x contract unit_price)', run: checkPaidWithinArrived },
  { id: 'advances_matched', type: 'static', description: 'A planned advance is recorded on an advance-terms contract', run: checkAdvancesMatched },
  { id: 'no_fulfilment_findings', type: 'static', description: 'checks_list shows no conflict and no payment_unconfirmed', run: checkNoFulfilmentFindings },
];
