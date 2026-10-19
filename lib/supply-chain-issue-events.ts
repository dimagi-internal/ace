/**
 * Issue events: what drives a supply-chain distribution to a field worker.
 *
 * A worker is resupplied with what they handed over, so the week's distribution
 * per worker is that worker's ISSUE EVENTS that week times the quantity one
 * issue hands over. An issue event is declared per commodity in the
 * `supply-chain-setup` plan (`commodities[].issue_event`):
 *
 *   - `form_answer`: a form, a field and the answers that mean "handed over".
 *     Connect FI's phone is the canonical case: the UNPAID Follow-up Contact
 *     form, `phone_obtained` = "handed over today" / "voucher redeemed", given
 *     only to an adult with no working phone AND an ID card, usually on a LATER
 *     visit — about 55-75% of enrolled adults (ace#3216, connect-fi/20261018-1440).
 *   - `per_enrolment`: one allocation per enrolled person. Only legal when the
 *     PDD says every enrolee gets one; it used to be the silent default for every
 *     commodity, which over-distributed Connect FI's phones by 25-45%.
 *
 * Where the events come from (`IssueEventSource`):
 *
 *   - `form_answer_visits`: the visits carry form identity (`form.@name` or
 *     `form.@xmlns` in `form_json`, as real Connect visits and mirror clones
 *     do), so the events are read: visits of the issue form whose field holds
 *     an issue answer.
 *   - `simulated_from_eligibility`: the visits carry NO form identity. That is
 *     every de-novo synthetic stream labs generates today: `schema_loader.py`
 *     merges every Deliver form's questions into one schema, `engine.py` stamps
 *     every visit with the opportunity's FIRST deliver unit and fills the merged
 *     schema on every visit, and per-form presence applies only to mirror
 *     clones (`fields.py`, `if mirror and form_name and by_form`). There is no
 *     Follow-up Contact visit to read, so the events are GENERATED from the
 *     PDD's eligibility share, once per beneficiary, on that beneficiary's
 *     later visit — and the plan says so. Never a silent enrolment proxy.
 *   - `per_enrolment`: first visit per beneficiary, times `per_person`.
 */
import type { SimCalendar } from './sim-calendar';
import { weekOf } from './sim-calendar';
import { decimalCompare, fromScaled, toScaled } from './decimal-string';

export class IssueEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueEventError';
  }
}

export type IssueEvent =
  | {
      kind: 'form_answer';
      /** The form that records the handover, by name or xmlns. */
      form: string;
      /** The field, as a form_json path (`form.phone_obtained`). */
      field: string;
      /** The answers that mean the commodity was handed over. */
      values: string[];
      /** Base units one issue hands over (decimal string). */
      quantity_per_issue: string;
      /** Share of enrolled beneficiaries who get one (decimal string 0-1), from the PDD; null if the PDD gives none. */
      eligible_share: string | null;
      /** True when the PDD says the handover usually happens on a later visit. */
      later_visit: boolean;
      /** The PDD sentence(s) this came from. */
      basis: string;
    }
  | {
      kind: 'per_enrolment';
      /** Base units per enrolled person (decimal string). */
      per_person: string;
      /** The PDD sentence saying every enrolee gets one. Required. */
      basis: string;
    };

export type IssueEventSource = 'form_answer_visits' | 'simulated_from_eligibility' | 'per_enrolment';

export interface IssueVisit {
  username: string;
  visit_date: string;
  entity_name?: string | null;
  entity_id?: string | null;
  form_json?: Record<string, unknown> | null;
}

/** week -> username -> issue events that week. */
export type WeeklyIssueEvents = Record<number, Record<string, number>>;

export interface DerivedIssueEvents {
  source: IssueEventSource;
  weeks: WeeklyIssueEvents;
  /** What the plan must say about how the events were obtained. */
  note: string;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The form a visit was submitted on, or null when the visit carries no form identity. */
export function visitForm(v: IssueVisit): { name: string | null; xmlns: string | null } | null {
  const form = getPath(v.form_json, 'form');
  if (!form || typeof form !== 'object') return null;
  const name = (form as Record<string, unknown>)['@name'];
  const xmlns = (form as Record<string, unknown>)['@xmlns'];
  const n = typeof name === 'string' && name ? name : null;
  const x = typeof xmlns === 'string' && xmlns ? xmlns : null;
  return n || x ? { name: n, xmlns: x } : null;
}

/**
 * Deterministic [0, 1) draw from a seed and a key: FNV-1a, then murmur3's fmix32
 * finaliser. Without the finaliser, keys differing only in their last characters
 * ("Adult 1", "Adult 2") differ only in FNV's LOW bits, the high bits barely
 * move, and a 0.65 share drew 195 of 200 — the control below caught it.
 */
export function seededUnit(seed: string | number, key: string): number {
  let h = 0x811c9dc5;
  const s = `${seed}:${key}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

function beneficiaryKey(v: IssueVisit, i: number): string {
  return v.entity_name || v.entity_id || `visit-${i}`;
}

function bump(weeks: WeeklyIssueEvents, w: number | null, username: string, n = 1): void {
  if (w === null || w < 1) return; // week 0 is setup; nothing is issued outside the delivery weeks
  weeks[w] ??= {};
  weeks[w][username] = (weeks[w][username] ?? 0) + n;
}

function byBeneficiary(visits: IssueVisit[]): IssueVisit[][] {
  const groups = new Map<string, IssueVisit[]>();
  visits.forEach((v, i) => {
    const k = beneficiaryKey(v, i);
    const g = groups.get(k) ?? [];
    g.push(v);
    groups.set(k, g);
  });
  for (const g of groups.values()) g.sort((a, b) => a.visit_date.localeCompare(b.visit_date));
  return [...groups.values()];
}

export function assertIssueEvent(e: IssueEvent, commodity: string): void {
  if (!e || typeof e !== 'object') throw new IssueEventError(`commodity ${commodity}: no issue_event declared`);
  if (!e.basis || !e.basis.trim()) throw new IssueEventError(`commodity ${commodity}: issue_event needs the PDD sentence it came from (basis)`);
  if (e.kind === 'per_enrolment') {
    if (decimalCompare(e.per_person, '0') <= 0) throw new IssueEventError(`commodity ${commodity}: per_person must be > 0`);
    return;
  }
  if (e.kind !== 'form_answer') throw new IssueEventError(`commodity ${commodity}: unknown issue_event kind`);
  if (!e.form || !e.field || !Array.isArray(e.values) || e.values.length === 0) {
    throw new IssueEventError(`commodity ${commodity}: a form_answer issue_event names the form, the field and the issue answers`);
  }
  if (decimalCompare(e.quantity_per_issue, '0') <= 0) throw new IssueEventError(`commodity ${commodity}: quantity_per_issue must be > 0`);
  if (e.eligible_share !== null) {
    if (decimalCompare(e.eligible_share, '0') < 0 || decimalCompare(e.eligible_share, '1') > 0) {
      throw new IssueEventError(`commodity ${commodity}: eligible_share ${e.eligible_share} is not between 0 and 1`);
    }
  }
}

/**
 * Derive one commodity's issue events per worker per delivery week from the
 * whole window's visits. Throws `IssueEventError` rather than guessing: a
 * stream with no form identity and a PDD with no eligibility share has no
 * honest answer.
 */
export function deriveIssueEvents(input: {
  commodity: string;
  issue_event: IssueEvent;
  visits: IssueVisit[];
  calendar: SimCalendar;
  seed: string | number;
}): DerivedIssueEvents {
  const { commodity, issue_event: e, visits, calendar, seed } = input;
  assertIssueEvent(e, commodity);
  const weeks: WeeklyIssueEvents = {};

  if (e.kind === 'per_enrolment') {
    for (const g of byBeneficiary(visits)) bump(weeks, weekOf(calendar, g[0].visit_date), g[0].username);
    return { source: 'per_enrolment', weeks, note: `one allocation per enrolled person (${e.basis})` };
  }

  const withForm = visits.some((v) => visitForm(v) !== null);
  if (withForm) {
    for (const v of visits) {
      const f = visitForm(v);
      if (!f || (f.name !== e.form && f.xmlns !== e.form)) continue;
      const answer = getPath(v.form_json, e.field);
      if (typeof answer === 'string' && e.values.includes(answer)) bump(weeks, weekOf(calendar, v.visit_date), v.username);
    }
    return { source: 'form_answer_visits', weeks, note: `read from ${e.form} visits where ${e.field} is ${e.values.join(' / ')}` };
  }

  if (e.eligible_share === null) {
    throw new IssueEventError(
      `commodity ${commodity}: the visits carry no form identity (labs' de-novo synthetic stream has no per-form visits, so there is no ${e.form} event to read) and the PDD gives no eligibility share to generate the handovers from. Supply eligible_share with its PDD sentence; never fall back to enrolments.`,
    );
  }
  const share = Number(e.eligible_share);
  for (const g of byBeneficiary(visits)) {
    const key = beneficiaryKey(g[0], 0);
    if (seededUnit(seed, `${commodity}:${key}`) >= share) continue; // not eligible
    const at = e.later_visit ? g[1] : g[0];
    if (!at) continue; // no later visit inside the window: not handed over yet
    bump(weeks, weekOf(calendar, at.visit_date), at.username);
  }
  return {
    source: 'simulated_from_eligibility',
    weeks,
    note: `generated: the synthetic visits carry no ${e.form} form, so ${e.eligible_share} of beneficiaries are drawn eligible (${e.basis})${e.later_visit ? ', each handed over on their second visit' : ''}`,
  };
}

/** The quantity one week's issue events put on a worker's distribution line. */
export function issueQuantity(e: IssueEvent, issueEvents: number): string {
  const per = e.kind === 'per_enrolment' ? e.per_person : e.quantity_per_issue;
  return fromScaled(toScaled(per) * BigInt(issueEvents));
}
