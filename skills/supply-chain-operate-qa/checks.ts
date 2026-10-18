/**
 * Static QA checks for `supply-chain-operate-qa`, one simulated week at a time.
 *
 * The artifact is ONE JSON document: `{plan, readback}`.
 *   - `plan` is the week's plan from `supply-chain-operate`: the consignments
 *     (store to store), the distributions to each worker, the stock counts
 *     (including the deliberate zero, a stockout), and the item's pack size.
 *   - `readback` is what labs returns NOW for that week, normalised with
 *     {@link normalizeReadback}: the movement records, the stock position per
 *     store, labs' own `stock_flow`, the open `checks_list` findings, and the
 *     findings the week's review artifact listed.
 *
 * `stock_flow` is labs' account of where the item went, in the item's BASE
 * unit, while `stock_position` reports a store's on-hand in whatever unit it
 * was received in (the PACK unit for a supplier receipt). The live capture
 * (labs program 10605, store 149) shows exactly that: 1000 tests flowed in,
 * 20 kits are on hand, at 50 tests a kit. A balance check that compared the two
 * numbers directly would fail a correct ledger, so the conversion is explicit.
 */
import type { QACheck, QACheckResult } from '../../lib/qa-types';
import { decimalCompare, decimalEq, decimalSum, fromScaled, toScaled } from '../../lib/decimal-string';

export interface OperatePlan {
  program_id: number;
  week: number;
  item: { id: number; base_unit: string; pack_unit: string; base_per_pack: number };
  consignments: Array<{ key: string; from_supply_point_id: number; to_supply_point_id: number; quantity: string; quantity_received: string }>;
  distributions: Array<{ connect_username: string; quantity: string }>;
  counts: Array<{ supply_point_id: number; quantity: string }>;
  /** True in the week the plan records a zero count (a stockout). */
  stockout_week: boolean;
}

export interface OperateReadback {
  consignments: Array<{ id: number; reference: string; status: string; quantity: string; quantity_received: string | null }>;
  distribution_lines: Array<{ connect_username: string; quantity: string }>;
  counts: Array<{ supply_point_id: number; quantity: string }>;
  /** Store on-hand per supply point id, with its unit. */
  on_hand: Record<string, { amount: string; unit: string }>;
  flow: {
    unit: string;
    adjusted: number;
    stores: string[];
    /** source node -> target node -> the running total at the last week. */
    links: Array<{ source: string; target: string; total: number }>;
  };
  checks: Array<{ category: string; kind: string; audience: string }>;
  /** The findings the week's review artifact lists, by kind and audience. */
  listed: Array<{ kind: string; audience: string }>;
}

export interface RawReadback {
  consignment_list: { value: Array<Record<string, unknown>> };
  distribution_list: { value: Array<Record<string, unknown>> };
  stock_count_list: { value: Array<Record<string, unknown>> };
  stock_position: Record<string, Record<string, unknown>>;
  stock_flow: Record<string, unknown>;
  checks_list?: { checks?: Array<Record<string, unknown>> };
  /** Parsed from the week's review artifact by the QA skill. */
  listed?: Array<{ kind: string; audience: string }>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
const qty = (v: unknown): string => (typeof v === 'number' ? String(v) : str(v) || '0');

export function normalizeReadback(raw: RawReadback): OperateReadback {
  const flow = raw.stock_flow ?? {};
  const nodes = arr(flow.nodes);
  return {
    consignments: arr(raw.consignment_list.value).map((c) => ({
      id: c.id as number,
      reference: str(c.reference),
      status: str(c.status),
      quantity: qty(c.quantity),
      quantity_received: c.quantity_received === null || c.quantity_received === undefined ? null : qty(c.quantity_received),
    })),
    distribution_lines: arr(raw.distribution_list.value).flatMap((d) =>
      arr(d.lines).map((l) => ({ connect_username: str(l.connect_username), quantity: qty(l.quantity) })),
    ),
    counts: arr(raw.stock_count_list.value).map((c) => ({ supply_point_id: c.supply_point_id as number, quantity: qty(c.quantity) })),
    on_hand: Object.fromEntries(
      Object.entries(raw.stock_position ?? {}).map(([id, p]) => {
        const oh = (p.on_hand ?? {}) as { amount?: unknown; unit?: unknown };
        return [id, { amount: qty(oh.amount), unit: str(oh.unit) }];
      }),
    ),
    flow: {
      unit: str(flow.unit),
      adjusted: typeof flow.adjusted === 'number' ? flow.adjusted : 0,
      stores: nodes.filter((n) => n.kind === 'store').map((n) => str(n.id)),
      links: arr(flow.links).map((l) => {
        const series = Array.isArray(l.series) ? (l.series as number[]) : [];
        return { source: str(l.source), target: str(l.target), total: series.length ? series[series.length - 1] : 0 };
      }),
    },
    checks: arr(raw.checks_list?.checks).map((c) => ({ category: str(c.category), kind: str(c.kind), audience: str(c.audience) })),
    listed: raw.listed ?? [],
  };
}

interface Doc {
  plan: OperatePlan;
  readback: OperateReadback;
}

function withDoc(artifact: string, fn: (d: Doc) => QACheckResult): QACheckResult {
  let doc: Doc;
  try {
    doc = JSON.parse(artifact) as Doc;
  } catch (e) {
    return { pass: false, detail: `artifact is not JSON: ${(e as Error).message}`, auto_fix_hint: 'Rebuild the {plan, readback} document as JSON.' };
  }
  if (!doc || typeof doc !== 'object' || !doc.plan || !doc.readback || !doc.readback.flow) {
    return { pass: false, detail: 'artifact must be {plan, readback}', auto_fix_hint: "Re-read the week's labs records and rebuild the document." };
  }
  return fn(doc);
}

/** On-hand in the flow's unit: packs are converted with the item's base_per_pack. */
export function onHandInFlowUnit(onHand: { amount: string; unit: string }, item: OperatePlan['item'], flowUnit: string): string | null {
  if (onHand.unit === flowUnit) return onHand.amount;
  if (onHand.unit === item.pack_unit && flowUnit === item.base_unit) {
    return fromScaled(toScaled(onHand.amount) * BigInt(item.base_per_pack));
  }
  return null;
}

export function checkFlowsBalance(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const { flow } = readback;
    const bad: string[] = [];
    const notes: string[] = [];
    for (const node of flow.stores) {
      const inflow = flow.links.filter((l) => l.target === node).reduce((t, l) => t + l.total, 0);
      const outflow = flow.links.filter((l) => l.source === node).reduce((t, l) => t + l.total, 0);
      const id = node.replace(/^p/, '');
      const oh = readback.on_hand[id];
      if (!oh) continue;
      const converted = onHandInFlowUnit(oh, plan.item, flow.unit);
      if (converted === null) {
        bad.push(`store ${id}: on-hand unit '${oh.unit}' cannot be converted to the flow's '${flow.unit}'`);
        continue;
      }
      const expected = String(inflow - outflow);
      if (decimalEq(expected, converted)) continue;
      if (flow.adjusted !== 0) notes.push(`store ${id}: flow ${expected} vs on-hand ${converted} ${flow.unit}, with ${flow.adjusted} adjusted (not drawn per store)`);
      else bad.push(`store ${id}: flow in-out = ${expected} ${flow.unit} but on-hand is ${converted} ${flow.unit}`);
    }
    return bad.length === 0
      ? { pass: true, detail: notes.join('; ') || undefined }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint:
            'Every unit that left a store must be a recorded consignment, distribution or loss. Find the missing movement; correct a wrong one with a stock_count override (it needs a reason), never a second movement.',
        };
  });
}

export function checkConsignmentsReceived(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const bad: string[] = [];
    for (const c of plan.consignments) {
      const got = readback.consignments.find((r) => r.reference === c.key);
      if (!got) {
        bad.push(`consignment ${c.key}: not in labs`);
        continue;
      }
      if (got.status !== 'received') bad.push(`consignment ${c.key}: ${got.status}`);
      if (got.quantity_received === null || !decimalEq(got.quantity_received, c.quantity_received)) {
        bad.push(`consignment ${c.key}: received ${got.quantity_received}, planned ${c.quantity_received}`);
      }
    }
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: bad.join('; '),
          auto_fix_hint: "Receive each consignment (supply_chain_consignment_receive) with the quantity that arrived; a short receipt writes the difference off as a loss. Give each dispatch its plan key as `reference`.",
        };
  });
}

export function checkDistributionsReadBack(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const bad = plan.distributions
      .filter((d) => {
        const got = readback.distribution_lines.filter((l) => l.connect_username === d.connect_username).map((l) => l.quantity);
        return got.length === 0 || !decimalEq(decimalSum(got), d.quantity);
      })
      .map((d) => `${d.connect_username}: planned ${d.quantity}`);
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `distribution lines missing or different: ${bad.join('; ')}`,
          auto_fix_hint: "Record the week's resupply run (supply_chain_distribution_record), one line per worker by connect_username.",
        };
  });
}

export function checkCountsReadBack(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    const bad = plan.counts
      .filter((c) => !readback.counts.some((r) => r.supply_point_id === c.supply_point_id && decimalEq(r.quantity, c.quantity)))
      .map((c) => `point ${c.supply_point_id}: ${c.quantity}`);
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `planned counts not in labs: ${bad.join('; ')}`,
          auto_fix_hint: 'Record the count (supply_chain_stock_count_record, kind self_reported). A zero is a real observation and must be recorded.',
        };
  });
}

export function checkStockoutRecorded(artifact: string): QACheckResult {
  return withDoc(artifact, ({ plan, readback }) => {
    if (!plan.stockout_week) return { pass: true, detail: 'no stockout planned this week' };
    const zero = readback.counts.some((c) => decimalCompare(c.quantity, '0') === 0);
    return zero
      ? { pass: true }
      : {
          pass: false,
          detail: 'the plan recorded a stockout this week but no zero count reads back',
          auto_fix_hint: 'Record the worker\'s zero self-report. Leaving it out hides the stockout the weekly review is meant to show.',
        };
  });
}

export function checkFindingsListedByAudience(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const key = (c: { kind: string; audience: string }) => `${c.kind}|${c.audience}`;
    const count = (xs: Array<{ kind: string; audience: string }>) => {
      const m = new Map<string, number>();
      for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
      return m;
    };
    const open = count(readback.checks);
    const listed = count(readback.listed);
    const missing = [...open].filter(([k, n]) => (listed.get(k) ?? 0) < n).map(([k, n]) => `${k} x${n - (listed.get(k) ?? 0)}`);
    return missing.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `open checks_list findings the week's review does not list: ${missing.join(', ')}`,
          auto_fix_hint: "List every open finding in the week's review, grouped by audience (supplier, partner, ours). labs deliberately leaves them unranked; the review must not drop any.",
        };
  });
}

export function checkNoStockConflicts(artifact: string): QACheckResult {
  return withDoc(artifact, ({ readback }) => {
    const bad = readback.checks.filter((c) => c.kind === 'stock_negative');
    return bad.length === 0
      ? { pass: true }
      : {
          pass: false,
          detail: `stock_negative x${bad.length}: more left a place than it held`,
          auto_fix_hint: 'A movement was recorded before the stock that feeds it (or twice). Find it in stock_flow; correct with a stock_count override and a reason.',
        };
  });
}

export const CHECKS: QACheck[] = [
  { id: 'flows_balance', type: 'static', description: "Each store's flow in minus out equals its on-hand (unit-converted)", run: checkFlowsBalance },
  { id: 'consignments_received', type: 'static', description: 'Every planned consignment is received with the planned quantity', run: checkConsignmentsReceived },
  { id: 'distributions_read_back', type: 'static', description: 'Every planned per-worker distribution reads back', run: checkDistributionsReadBack },
  { id: 'counts_read_back', type: 'static', description: 'Every planned stock count reads back', run: checkCountsReadBack },
  { id: 'stockout_recorded', type: 'static', description: 'In the stockout week, the zero count reads back', run: checkStockoutRecorded },
  { id: 'findings_listed_by_audience', type: 'static', description: "The week's review lists every open finding by audience", run: checkFindingsListedByAudience },
  { id: 'no_stock_conflicts', type: 'static', description: 'checks_list shows no stock_negative', run: checkNoStockConflicts },
];
