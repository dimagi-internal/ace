/**
 * Work Order vs solicitation: do the two documents agree on the commercial
 * terms a partner prices against?
 *
 * ## The failure class
 *
 * `pdd-to-work-order` (Phase 1) and `solicitation-create` (Phase 8) both read
 * the PDD and the decisions log, and neither read the other's conclusion. On
 * `spark-facilitator/20261001-2208` the Work Order § 2 told the partner to
 * "cost device provision separately in its solicitation response; devices are
 * funded under this Work Order only if Dimagi agrees that cost at contract
 * execution, in addition to the not-to-exceed in section 6.1", while the
 * solicitation's own decision rows (`solicitation-all-in-rate-and-devices`,
 * superseded by `sol-devices-and-system-of-record-2208`) recorded an ALL-IN
 * per-meeting rate with devices inside it. Both rows even said "the work order
 * text should be reconciled at contract execution" — i.e. the contradiction was
 * known, logged, and shipped. A partner reading both documents cannot price the
 * engagement.
 *
 * The solicitation side follows a standing operator directive (Jonathan
 * 2026-09-08, ace#2265: the rate is all-in, never a separately-funded line;
 * 2026-09-26: devices and data are assumed). The Work Order now follows it too
 * (`skills/pdd-to-work-order/SKILL.md § Commercial terms follow the
 * solicitation`), and this module is the structural check that the two agree.
 *
 * ## What it reads
 *
 * - **Solicitation stance**: LIVE (not superseded) decision rows whose id
 *   starts `sol-` or `solicitation-`, classified from their effective value
 *   (`override ?? ai-default`) and `plain` line. `options` are deliberately NOT
 *   read: they list the road not taken.
 * - **Work Order stance**: sentences that put a cost item (devices,
 *   connectivity, transport, supervision …) OUTSIDE the per-unit rate, or that
 *   state the rate is all-in.
 *
 * Pure; no I/O.
 */
import yaml from 'yaml';

export type CommercialStance = 'all-in' | 'separate';

export interface SolicitationStanceRow {
  id: string;
  stance: CommercialStance;
  /** The text the stance was read from, for the failure message. */
  text: string;
}

export interface WorkOrderStanceHit {
  stance: CommercialStance;
  sentence: string;
}

export interface CommercialTermsFinding {
  /** 'n/a' = no solicitation row fixes rate framing or devices. */
  status: 'agree' | 'disagree' | 'n/a';
  solicitation: SolicitationStanceRow[];
  workOrder: WorkOrderStanceHit[];
  /** The work-order sentences that contradict the solicitation stance. */
  conflicts: WorkOrderStanceHit[];
}

const SOLICITATION_ID = /^(sol|solicitation)-/;

/** Cost items that the all-in directive says sit INSIDE the rate. */
const COST_ITEM =
  /\b(devices?|device provision|smartphones?|handsets?|phones?|connectivity|airtime|data bundles?|transport|supervision)\b/i;

/** Language that puts something OUTSIDE the per-unit rate. */
const OUTSIDE_RATE =
  /\b(separately|separate (?:budget )?line|separately[- ]funded|reimbursed separately|in addition to the (?:total )?not[- ]to[- ]exceed|outside the (?:per[- ]\w+ )?rate|funded under this work order only if)\b/i;

/** Negations of OUTSIDE_RATE — "no separately-funded line" is an all-in statement. */
const NEGATED_OUTSIDE =
  /\b(no|never|not|without)\b[^.]{0,40}\b(separately|separate (?:budget )?line|separately[- ]funded)/i;

// Hyphenated only: "all in-country permissions" is not a rate statement.
const ALL_IN = /\ball-in\b(?!-)|\ball[- ]inclusive\b/i;
const INSIDE_RATE =
  /\b(devices?|connectivity|transport|supervision)\b[^.]{0,60}\b(inside|within|included in|covered by|part of) the (?:per[- ]\w+ )?rate\b/i;

/** Classify one piece of decision text. Null when it says nothing about rate framing or devices. */
export function classifyStanceText(text: string): CommercialStance | null {
  if (!text) return null;
  if (ALL_IN.test(text) || INSIDE_RATE.test(text)) return 'all-in';
  if (NEGATED_OUTSIDE.test(text) && COST_ITEM.test(text)) return 'all-in';
  if (COST_ITEM.test(text) && OUTSIDE_RATE.test(text)) return 'separate';
  return null;
}

interface LooseRow {
  id?: unknown;
  superseded_by?: unknown;
  override?: unknown;
  'ai-default'?: unknown;
  plain?: unknown;
}

/**
 * The solicitation's recorded stance(s). Lenient parse: a decisions log that
 * fails the strict schema elsewhere must not hide a commercial contradiction.
 */
export function solicitationStances(decisionsYaml: string): SolicitationStanceRow[] {
  if (!decisionsYaml.trim()) return [];
  let doc: unknown;
  try {
    doc = yaml.parse(decisionsYaml);
  } catch {
    return [];
  }
  const rows = (doc as { decisions?: unknown })?.decisions;
  if (!Array.isArray(rows)) return [];
  const out: SolicitationStanceRow[] = [];
  for (const r of rows as LooseRow[]) {
    if (typeof r?.id !== 'string' || !SOLICITATION_ID.test(r.id)) continue;
    if (r.superseded_by !== undefined && r.superseded_by !== null) continue;
    const value = String(r.override ?? r['ai-default'] ?? '');
    const plain = typeof r.plain === 'string' ? r.plain : '';
    const stance = classifyStanceText(value) ?? classifyStanceText(plain);
    if (stance) out.push({ id: r.id, stance, text: value || plain });
  }
  return out;
}

function sentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=\.)\s+(?=[A-Z*])/))
    .map((s) => s.replace(/^[\s*•\-\t]+/, '').trim())
    .filter(Boolean);
}

/** Sentences in the Work Order that state a commercial stance. */
export function workOrderStances(workOrderText: string): WorkOrderStanceHit[] {
  const hits: WorkOrderStanceHit[] = [];
  for (const s of sentences(workOrderText)) {
    const stance = classifyStanceText(s);
    if (stance) hits.push({ stance, sentence: s });
  }
  return hits;
}

export function compareCommercialTerms(
  workOrderText: string,
  decisionsYaml: string,
): CommercialTermsFinding {
  const solicitation = solicitationStances(decisionsYaml);
  const workOrder = workOrderStances(workOrderText);
  if (solicitation.length === 0) {
    return { status: 'n/a', solicitation, workOrder, conflicts: [] };
  }
  // The latest live row wins if the solicitation itself is inconsistent; the
  // log is append-only, so array order is write order.
  const governing = solicitation[solicitation.length - 1].stance;
  const conflicts = workOrder.filter((h) => h.stance !== governing);
  return {
    status: conflicts.length ? 'disagree' : 'agree',
    solicitation,
    workOrder,
    conflicts,
  };
}
