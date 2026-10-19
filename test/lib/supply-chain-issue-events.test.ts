/**
 * lib/supply-chain-issue-events.ts — what drives a worker's distribution
 * (ace#3216, observed connect-fi/20261018-1440).
 *
 * The defect: supply-chain-operate distributed enrolments x allocation for
 * every commodity. Connect FI's phone is handed over on the UNPAID Follow-up
 * Contact form (`phone_obtained` = "handed over today" / "voucher redeemed"),
 * to ~55-75% of enrolled adults, usually on a later visit.
 *
 * The synthetic-stream shapes below follow labs' generator source
 * (dimagi-internal/connect-labs@main, synthetic/generator/fixtures/engine.py):
 * de-novo visits carry `username`, `visit_date`, `entity_name` (stable per
 * beneficiary), a fresh `entity_id`, and a `form_json` with NO `form.@name`;
 * only a mirror clone carries the form name.
 */
import { describe, expect, it } from 'vitest';
import { computeSimCalendar } from '../../lib/sim-calendar';
import {
  IssueEventError,
  deriveIssueEvents,
  issueQuantity,
  visitForm,
  type IssueEvent,
  type IssueVisit,
} from '../../lib/supply-chain-issue-events';

const cal = computeSimCalendar('2026-10-19', 4);
const wk = (w: number, d = 1) => {
  const start = new Date(`${cal.weeks[w].start}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + d);
  return start.toISOString().slice(0, 10);
};

const PHONE: IssueEvent = {
  kind: 'form_answer',
  form: 'Follow-up Contact',
  field: 'form.phone_obtained',
  values: ['handed_over_today', 'voucher_redeemed'],
  quantity_per_issue: '1',
  eligible_share: '0.65',
  later_visit: true,
  basis: 'PDD § Form 3: a phone only for an adult with no working phone and an ID card; ~55-75% of enrolled adults',
};

/** De-novo synthetic: 200 beneficiaries, two visits each, one week apart, no form identity. */
function deNovo(): IssueVisit[] {
  const out: IssueVisit[] = [];
  for (let b = 0; b < 200; b++) {
    const flw = `syn-flw-00${b % 4}`;
    out.push({ username: flw, visit_date: wk(1 + (b % 3)), entity_name: `Adult ${b}`, entity_id: `u-${b}-a`, form_json: { phone_obtained: 'not_yet' } });
    out.push({ username: flw, visit_date: wk(2 + (b % 3)), entity_name: `Adult ${b}`, entity_id: `u-${b}-b`, form_json: { phone_obtained: 'handed_over_today' } });
  }
  return out;
}

const total = (weeks: Record<number, Record<string, number>>) =>
  Object.values(weeks).reduce((t, w) => t + Object.values(w).reduce((a, b) => a + b, 0), 0);

describe('deriveIssueEvents', () => {
  it('generates handovers from the eligibility share when the stream has no form identity, never one per enrolment', () => {
    const r = deriveIssueEvents({ commodity: 'phone', issue_event: PHONE, visits: deNovo(), calendar: cal, seed: 20261018 });
    expect(r.source).toBe('simulated_from_eligibility');
    const n = total(r.weeks);
    // 200 enrolments: the old enrolment proxy gave 200. 0.65 of 200 is 130.
    expect(n).toBeGreaterThan(105);
    expect(n).toBeLessThan(155);
    expect(n).not.toBe(200);
    // Handed over on the LATER visit: nothing in week 1, where only first visits fall.
    expect(r.weeks[1]).toBeUndefined();
    expect(r.note).toMatch(/generated/);
  });

  it('is deterministic for a seed', () => {
    const a = deriveIssueEvents({ commodity: 'phone', issue_event: PHONE, visits: deNovo(), calendar: cal, seed: 7 });
    const b = deriveIssueEvents({ commodity: 'phone', issue_event: PHONE, visits: deNovo(), calendar: cal, seed: 7 });
    expect(a.weeks).toEqual(b.weeks);
  });

  it('reads the issue form when visits carry form identity (real visits, mirror clones)', () => {
    const visits: IssueVisit[] = [
      { username: 'w1', visit_date: wk(1), form_json: { form: { '@name': 'Enrolment', phone_obtained: 'handed_over_today' } } },
      { username: 'w1', visit_date: wk(2), form_json: { form: { '@name': 'Follow-up Contact', phone_obtained: 'handed_over_today' } } },
      { username: 'w1', visit_date: wk(2), form_json: { form: { '@name': 'Follow-up Contact', phone_obtained: 'not_yet' } } },
      { username: 'w2', visit_date: wk(3), form_json: { form: { '@xmlns': 'Follow-up Contact', phone_obtained: 'voucher_redeemed' } } },
    ];
    const event: IssueEvent = { ...PHONE, field: 'form.phone_obtained' };
    const r = deriveIssueEvents({ commodity: 'phone', issue_event: event, visits, calendar: cal, seed: 1 });
    expect(r.source).toBe('form_answer_visits');
    expect(r.weeks).toEqual({ 2: { w1: 1 }, 3: { w2: 1 } });
  });

  it('refuses to guess when there is no form to read and no PDD share', () => {
    expect(() =>
      deriveIssueEvents({ commodity: 'phone', issue_event: { ...PHONE, eligible_share: null }, visits: deNovo(), calendar: cal, seed: 1 }),
    ).toThrow(IssueEventError);
  });

  it('per_enrolment counts each beneficiary once, in the week of their first visit', () => {
    const r = deriveIssueEvents({
      commodity: 'sim',
      issue_event: { kind: 'per_enrolment', per_person: '1', basis: 'PDD: every enrolled adult receives a SIM starter kit' },
      visits: deNovo(),
      calendar: cal,
      seed: 1,
    });
    expect(r.source).toBe('per_enrolment');
    expect(total(r.weeks)).toBe(200);
  });

  it('refuses an issue_event with no PDD basis', () => {
    expect(() =>
      deriveIssueEvents({ commodity: 'sim', issue_event: { kind: 'per_enrolment', per_person: '1', basis: ' ' }, visits: [], calendar: cal, seed: 1 }),
    ).toThrow(/basis/);
  });
});

describe('helpers', () => {
  it('visitForm reads form.@name / @xmlns and is null on a de-novo visit', () => {
    expect(visitForm({ username: 'a', visit_date: wk(1), form_json: { form: { '@name': 'X' } } })).toEqual({ name: 'X', xmlns: null });
    expect(visitForm({ username: 'a', visit_date: wk(1), form_json: { phone_obtained: 'not_yet' } })).toBeNull();
  });
  it('issueQuantity multiplies exactly', () => {
    expect(issueQuantity(PHONE, 3)).toBe('3');
    expect(issueQuantity({ kind: 'per_enrolment', per_person: '0.5', basis: 'b' }, 3)).toBe('1.5');
  });
});
