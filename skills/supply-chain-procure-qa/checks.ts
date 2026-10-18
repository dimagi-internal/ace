/**
 * Static QA checks for `supply-chain-procure-qa`.
 *
 * The artifact is ONE JSON document: `{plan, readback}`.
 *   - `plan` is `supply-chain-procure`'s plan file (the tender lines, the buyer
 *     of record the runner implies, the quote spread it meant to record).
 *   - `readback` is what labs returns NOW (tender, quotes, awards, contracts,
 *     the comparison per commodity, checks_list), read fresh by this QA skill
 *     and normalised with {@link normalizeReadback}. The verdict is a function
 *     of the read-back, never of the write responses (spec 2026-10-18 § F0).
 *
 * Grounded on a live read-only capture of labs program 10605, tender 60
 * (`test/skills/supply-chain-procure-qa/fixtures/labs-program-10605-tender-60.json`):
 * a real award to the NON-cheapest quote, with a stated reason, and a tender
 * that stays `awarded` (never closed).
 */
import type { QACheck, QACheckResult } from '../../lib/qa-types';
import { decimalEq, toScaled } from '../../lib/decimal-string';
import { SYNTHETIC_SUFFIX } from '../../lib/supply-chain-ref';

export interface ProcurePlan {
  program_id: number;
  lines: Array<{ commodity_slug: string; quantity: string; quantity_unit: string }>;
  /** From `buyerOfRecord(runner.role)` (lib/supply-chain-runner.ts). */
  buyer_of_record: 'programme_org' | 'partner_org';
  /** The labs org id that buys (the runner's on the winner path). */
  buyer_org_id: number;
  /** The fewest live quotes per line the plan meant to record (spec § F3: 3-4 on the simulated track). */
  min_quotes_per_line: number;
  /** True on the simulated track: every supplier is invented and carries the marker. */
  simulated: boolean;
}

export interface ProcureReadback {
  tender: { id: number; status: string; lines: Array<{ commodity_slug: string; quantity: string; quantity_unit: string }> };
  quotes: Array<{
    id: number;
    supplier_id: number;
    item_id: number | null;
    commodity_slug: string;
    as_quoted_amount: string;
    as_quoted_unit: string;
    live: boolean;
  }>;
  awards: Array<{
    id: number;
    quote_id: number;
    commodity_slug: string;
    rationale: string;
    provisional: boolean;
    unrankable_columns: string[];
    /** The frozen snapshot's rows on its `ranked_by` column. */
    ranked: Array<{ quote_id: number; amount: string | null }>;
  }>;
  contracts: Array<{
    id: number;
    award_id: number | null;
    supplier_id: number;
    item_id: number | null;
    commodity_slug: string;
    quantity: string;
    quantity_unit: string;
    unit_price: string | null;
    unit_price_unit: string;
    buyer_of_record: string;
    buyer_org_id: number;
  }>;
  /** Supplier names as the comparison names them, per commodity. */
  supplier_names: Record<string, string[]>;
  checks: Array<{ category: string; kind: string }>;
}

/** The raw replies of the QA's reads, as labs returns them. */
export interface RawReadback {
  tender_list?: { value: Array<Record<string, unknown>> };
  tender_get?: Record<string, unknown>;
  quote_list: { value: Array<Record<string, unknown>> };
  award_list: { value: Array<Record<string, unknown>> };
  contract_list: { value: Array<Record<string, unknown>> };
  /** `tender_compare` replies keyed by commodity slug. */
  tender_compare: Record<string, Record<string, unknown>>;
  checks_list?: { checks?: Array<Record<string, unknown>> };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);

/**
 * Labs writes `"38"` in one place and `"38.00"` in another; comparing strings
 * would call them different. The exact helpers live in lib/decimal-string.ts.
 */
export { decimalEq } from '../../lib/decimal-string';
const decimalScaled = toScaled;

/** Normalise the raw labs replies into {@link ProcureReadback} for one tender. */
export function normalizeReadback(raw: RawReadback, tenderId: number): ProcureReadback {
  const t = raw.tender_get ?? arr(raw.tender_list?.value).find((x) => x.id === tenderId) ?? {};
  const lines = arr((t as Record<string, unknown>).lines).map((l) => ({
    commodity_slug: str(l.commodity_slug),
    quantity: str(l.quantity),
    quantity_unit: str(l.quantity_unit),
  }));
  const quotes = arr(raw.quote_list.value)
    .filter((q) => q.tender_id === tenderId)
    .map((q) => ({
      id: num(q.id) as number,
      supplier_id: num(q.supplier_id) as number,
      item_id: num(q.item_id),
      commodity_slug: str(q.commodity_slug),
      as_quoted_amount: str(q.as_quoted_amount),
      as_quoted_unit: str(q.as_quoted_unit),
      live: q.voided !== true && (q.superseded_by_quote_id === null || q.superseded_by_quote_id === undefined),
    }));
  const awards = arr(raw.award_list.value)
    .filter((a) => a.tender_id === tenderId)
    .map((a) => {
      const snap = (a.comparison_snapshot ?? {}) as Record<string, unknown>;
      const rankedBy = str(snap.ranked_by);
      return {
        id: num(a.id) as number,
        quote_id: num(a.quote_id) as number,
        commodity_slug: str(a.commodity_slug),
        rationale: str(a.rationale),
        provisional: a.provisional === true || snap.provisional === true,
        unrankable_columns: arr(snap.columns)
          .filter((c) => c.rankable !== true)
          .map((c) => str(c.key)),
        ranked: arr(snap.comparable).map((row) => {
          const fig = ((row.figures ?? {}) as Record<string, { amount?: unknown }>)[rankedBy];
          return { quote_id: num(row.quote_id) as number, amount: fig && typeof fig.amount === 'string' ? fig.amount : null };
        }),
      };
    });
  const contracts = arr(raw.contract_list.value)
    .filter((c) => c.tender_id === tenderId || c.tender_id === undefined)
    .map((c) => ({
      id: num(c.id) as number,
      award_id: num(c.award_id),
      supplier_id: num(c.supplier_id) as number,
      item_id: num(c.item_id),
      commodity_slug: str(c.commodity_slug),
      quantity: str(c.quantity),
      quantity_unit: str(c.quantity_unit),
      unit_price: typeof c.unit_price === 'string' ? c.unit_price : null,
      unit_price_unit: str(c.unit_price_unit),
      buyer_of_record: str(c.buyer_of_record),
      buyer_org_id: num(c.buyer_org_id) as number,
    }));
  const supplier_names: Record<string, string[]> = {};
  for (const [slug, cmp] of Object.entries(raw.tender_compare ?? {})) {
    supplier_names[slug] = [...arr(cmp.comparable), ...arr(cmp.blocked), ...arr(cmp.not_comparable)]
      .map((r) => str(r.supplier_name))
      .filter(Boolean);
  }
  return {
    tender: { id: tenderId, status: str((t as Record<string, unknown>).status), lines },
    quotes,
    awards,
    contracts,
    supplier_names,
    checks: arr(raw.checks_list?.checks).map((c) => ({ category: str(c.category), kind: str(c.kind) })),
  };
}

interface Doc {
  plan: ProcurePlan;
  readback: ProcureReadback;
}

function withDoc(artifact: string, fn: (d: Doc) => QACheckResult): QACheckResult {
  let doc: Doc;
  try {
    doc = JSON.parse(artifact) as Doc;
  } catch (e) {
    return { pass: false, detail: `artifact is not JSON: ${(e as Error).message}`, auto_fix_hint: 'Rebuild the {plan, readback} document as JSON.' };
  }
  if (!doc || typeof doc !== 'object' || !doc.plan || !doc.readback) {
    return { pass: false, detail: 'artifact must be {plan, readback}', auto_fix_hint: 'Re-read labs and rebuild the {plan, readback} document.' };
  }
  return fn(doc);
}

export function checkTenderAwarded(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const s = readback.tender.status;
    return s === 'awarded' || s === 'closed'
      ? { pass: true, detail: `tender ${readback.tender.id} is ${s}` }
      : {
          pass: false,
          detail: `tender ${readback.tender.id} is '${s}'; after procurement it must be awarded (every line awarded) or closed`,
          auto_fix_hint: 'Award every line (supply_chain_award_create), then close the tender (supply_chain_tender_close).',
        };
  });
}

export function checkOneAwardPerLine(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const bad: string[] = [];
    for (const line of readback.tender.lines) {
      const n = readback.awards.filter((a) => a.commodity_slug === line.commodity_slug).length;
      if (n !== 1) bad.push(`${line.commodity_slug}: ${n} awards`);
    }
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `each tender line needs exactly one award: ${bad.join('; ')}`,
          auto_fix_hint: 'Award the missing line. A second award on one line cannot be deleted; record why in the run record and contract only one.',
        };
  });
}

export function checkAwardComparisonRankable(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const bad = readback.awards
      .filter((a) => a.provisional || a.unrankable_columns.length > 0)
      .map((a) => `award ${a.id} (${a.commodity_slug})${a.provisional ? ' provisional' : ''}${a.unrankable_columns.length ? ` unrankable: ${a.unrankable_columns.join(', ')}` : ''}`);
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `award decided on a comparison that was not rankable: ${bad.join('; ')}`,
          auto_fix_hint: "Resolve the blocked suppliers with quote_correct (citing their clarification) BEFORE awarding; an award freezes the comparison as it stood.",
        };
  });
}

export function checkContractMatchesAward(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const bad: string[] = [];
    for (const award of readback.awards) {
      const quote = readback.quotes.find((q) => q.id === award.quote_id);
      const line = readback.tender.lines.find((l) => l.commodity_slug === award.commodity_slug);
      const contracts = readback.contracts.filter((c) => c.award_id === award.id);
      if (contracts.length !== 1) {
        bad.push(`award ${award.id}: ${contracts.length} contracts`);
        continue;
      }
      const c = contracts[0];
      if (!quote) {
        bad.push(`award ${award.id}: awarded quote ${award.quote_id} not found`);
        continue;
      }
      if (c.supplier_id !== quote.supplier_id) bad.push(`contract ${c.id}: supplier ${c.supplier_id} ≠ quote's ${quote.supplier_id}`);
      if (quote.item_id !== null && c.item_id !== quote.item_id) bad.push(`contract ${c.id}: item ${c.item_id} ≠ quote's ${quote.item_id}`);
      if (c.unit_price === null || !decimalEq(c.unit_price, quote.as_quoted_amount)) {
        bad.push(`contract ${c.id}: unit price ${c.unit_price} ≠ quoted ${quote.as_quoted_amount}`);
      }
      if (c.unit_price_unit !== quote.as_quoted_unit) bad.push(`contract ${c.id}: price unit ${c.unit_price_unit} ≠ quoted ${quote.as_quoted_unit}`);
      if (line && !(decimalEq(c.quantity, line.quantity) && c.quantity_unit === line.quantity_unit)) {
        bad.push(`contract ${c.id}: ${c.quantity} ${c.quantity_unit} ≠ tender line ${line.quantity} ${line.quantity_unit}`);
      }
    }
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint:
            'A contract must carry the awarded quote exactly (supplier, item, price as stated, the tendered quantity). Contracts cannot be deleted: record the discrepancy and contract_update the commitment, never re-create it.',
        };
  });
}

export function checkBuyerMatchesRunner(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const bad = readback.contracts
      .filter((c) => c.buyer_of_record !== plan.buyer_of_record || c.buyer_org_id !== plan.buyer_org_id)
      .map((c) => `contract ${c.id}: ${c.buyer_of_record}/${c.buyer_org_id}`);
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `buyer of record should be ${plan.buyer_of_record}/${plan.buyer_org_id} (from the runner): ${bad.join('; ')}`,
          auto_fix_hint: 'buyer_of_record follows from who runs the programme (buyerOfRecord, lib/supply-chain-runner.ts). Correct it with supply_chain_contract_update.',
        };
  });
}

export function checkQuotesPerLine(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const bad = readback.tender.lines
      .map((l) => ({ slug: l.commodity_slug, n: readback.quotes.filter((q) => q.live && q.commodity_slug === l.commodity_slug).length }))
      .filter((x) => x.n < plan.min_quotes_per_line)
      .map((x) => `${x.slug}: ${x.n}`);
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `fewer than ${plan.min_quotes_per_line} live quotes: ${bad.join('; ')}`,
          auto_fix_hint: 'Record the planned quotes (supply_chain_quote_record). A comparison of one offer is not a tender.',
        };
  });
}

/**
 * An award to a quote that was not the cheapest on the snapshot's ranking
 * column must say why. The live control (program 10605) is exactly this: the
 * cheaper kit failed the item specification, and the rationale says so. This
 * check only demands that a reason exists; whether it is a GOOD reason is
 * `supply-chain-procure-eval`'s call.
 */
export function checkNonCheapestAwardExplained(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const bad: string[] = [];
    const notes: string[] = [];
    for (const a of readback.awards) {
      const priced = a.ranked.filter((r): r is { quote_id: number; amount: string } => r.amount !== null);
      const mine = priced.find((r) => r.quote_id === a.quote_id);
      if (!mine || priced.length < 2) continue;
      const cheapest = priced.reduce((m, r) => (decimalScaled(r.amount) < decimalScaled(m.amount) ? r : m));
      if (decimalScaled(mine.amount) <= decimalScaled(cheapest.amount)) continue;
      if (a.rationale.trim().length < 20) bad.push(`award ${a.id}: not the cheapest (${mine.amount} vs ${cheapest.amount}) and rationale "${a.rationale}"`);
      else notes.push(`award ${a.id} is not the cheapest; rationale given`);
    }
    return bad.length === 0
      ? { pass: true, detail: notes.join('; ') || undefined }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint: 'An award cannot be edited or deleted. Record the real reason in the run record; the next award must state it in its rationale.',
        };
  });
}

export function checkSuppliersSynthetic(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    if (!plan.simulated) return { pass: true, detail: 'not the simulated track' };
    const bad = [...new Set(Object.values(readback.supplier_names).flat())].filter((n) => !n.trim().endsWith(SYNTHETIC_SUFFIX));
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `suppliers quoted without the ${SYNTHETIC_SUFFIX} marker on the simulated track: ${bad.join(', ')}`,
          auto_fix_hint: 'Only invented suppliers may quote in a simulation (supply-chain-setup Step 8). A real company here has ACE-invented quotes attached to it.',
        };
  });
}

export function checkNoProcurementConflicts(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const conflicts = readback.checks.filter((c) => c.category === 'conflict');
    return conflicts.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `checks_list reports conflict(s): ${conflicts.map((c) => c.kind || '?').join(', ')}`,
          auto_fix_hint: 'award_not_contracted means a contract is missing: create it from the award. Any other conflict names the record to correct.',
        };
  });
}

export const CHECKS: QACheck[] = [
  { id: 'tender_awarded', type: 'static', description: 'The tender ends awarded or closed', run: checkTenderAwarded },
  { id: 'one_award_per_line', type: 'static', description: 'Each tender line has exactly one award', run: checkOneAwardPerLine },
  { id: 'award_comparison_rankable', type: 'static', description: 'Every award froze a rankable, non-provisional comparison', run: checkAwardComparisonRankable },
  { id: 'contract_matches_award', type: 'static', description: "Each award has one contract carrying the awarded quote's supplier, item, price and the tendered quantity", run: checkContractMatchesAward },
  { id: 'buyer_matches_runner', type: 'static', description: 'Every contract names the buyer of record the runner implies', run: checkBuyerMatchesRunner },
  { id: 'quotes_per_line', type: 'static', description: 'Each line has at least the planned number of live quotes', run: checkQuotesPerLine },
  { id: 'non_cheapest_award_explained', type: 'static', description: 'An award to a non-cheapest quote carries a stated reason', run: checkNonCheapestAwardExplained },
  { id: 'suppliers_synthetic', type: 'static', description: 'On the simulated track every quoting supplier carries [Synthetic]', run: checkSuppliersSynthetic },
  { id: 'no_procurement_conflicts', type: 'static', description: 'checks_list shows no conflict after procurement', run: checkNoProcurementConflicts },
];
