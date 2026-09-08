/**
 * `solicitation-create` must scope the addend of `expected_end_date`
 * (dimagi-internal/ace#1858).
 *
 * The two date rows in § Step 2 sat one line apart and contradicted each other:
 *
 *   expected_start_date = application_deadline + a contracting allowance
 *                         ("it has to cover response review, award, and contracting")
 *   expected_end_date   = expected_start_date + the PDD's stated duration band
 *
 * For a solicited engagement the PDD's `## Timeline` total normally starts its
 * clock at solicitation-open, so "the stated duration band" already contains the
 * window `application_deadline` consumed and the award step the contracting
 * allowance covers. Adding it to the start date spends both twice.
 *
 * Measured on `bednet-check-2-visit/20260828-0629` (labs solicitation 17695):
 * published 2026-08-30, deadline 2026-09-13, start 2026-09-27. The whole 18-week
 * total gives 2027-01-31; the post-award addend — total less only the 2-week
 * solicitation-open row, since the award row also carries onboarding and worker
 * registration the LLO performs after award — is 16 weeks and gives 2027-01-17.
 * **Fourteen days long, on a public partner-facing listing** — and Step 7a
 * asserted only `end > start`, which the wrong date satisfies.
 *
 * This test does two things:
 *   1. Verifies the ARITHMETIC of the worked example the skill now carries, so a
 *      future edit cannot leave a self-inconsistent example in place — including
 *      that the whole-total reading really does produce the wrong published date.
 *   2. Pins the PROSE contract: the addend is scoped, and Step 7a bounds the span
 *      rather than only asserting ordering.
 *
 * SCOPE: offline and deterministic. There is no runtime helper to test — the rule
 * is prose an LLM executes — so the example's arithmetic is the closest thing to
 * an executable statement of the contract.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = path.join(REPO_ROOT, 'skills/solicitation-create/SKILL.md');
const PDD_TEMPLATE = path.join(REPO_ROOT, 'templates/pdd-template.md');

/** UTC-safe `YYYY-MM-DD` + N weeks. */
function addWeeks(iso: string, weeks: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

/** The bednet-check-2-visit/20260828-0629 run, as published. */
const RUN = {
  publishedOn: '2026-08-30',
  applicationDeadline: '2026-09-13',
  contractingAllowanceDays: 14,
  expectedStartDate: '2026-09-27',
  /** PDD § Timeline rows, in order, from solicitation-open. */
  timelineWeeks: {
    solicitationOpen: 2,
    awardOnboardingRegistration: 1,
    learnCompletion: 1,
    fieldWork: 13,
    auditAndCloseout: 1,
  },
  /** What a literal reading of the pre-fix rule would have published. */
  wrongEndDate: '2027-01-31',
  /** What the post-award remainder actually gives, and what shipped. */
  correctEndDate: '2027-01-17',
};

describe('solicitation-create § expected_end_date addend (ace#1858)', () => {
  const t = RUN.timelineWeeks;
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  // Rule (1): the solicitation-open row is always subtracted. Rule (2): the award
  // row is KEPT here — it bundles onboarding and worker registration, which is LLO
  // work performed after award, not something the contracting allowance does.
  const postAward = total - t.solicitationOpen;

  it('the worked example self-describes: 18-week total, 16-week post-award addend', () => {
    expect(total).toBe(18);
    expect(postAward).toBe(16);
  });

  it('expected_start_date is the deadline plus the contracting allowance', () => {
    const d = new Date(`${RUN.applicationDeadline}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + RUN.contractingAllowanceDays);
    expect(d.toISOString().slice(0, 10)).toBe(RUN.expectedStartDate);
  });

  it('adding the WHOLE timeline total produces the wrong published date', () => {
    expect(addWeeks(RUN.expectedStartDate, total)).toBe(RUN.wrongEndDate);
  });

  it('adding the POST-AWARD addend produces the date that shipped', () => {
    expect(addWeeks(RUN.expectedStartDate, postAward)).toBe(RUN.correctEndDate);
  });

  it('the error is 14 days — a fortnight long on a public listing', () => {
    const wrong = new Date(`${RUN.wrongEndDate}T00:00:00Z`).getTime();
    const right = new Date(`${RUN.correctEndDate}T00:00:00Z`).getTime();
    expect((wrong - right) / 86_400_000).toBe(14);
  });

  it('the wrong date passes the ordering check, which is why prose alone was not enough', () => {
    expect(RUN.wrongEndDate > RUN.expectedStartDate).toBe(true);
    expect(RUN.expectedStartDate > RUN.applicationDeadline).toBe(true);
  });

  it('the span ceiling Step 7a now asserts REJECTS the wrong date and ACCEPTS the right one', () => {
    const days = (a: string, b: string) =>
      (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000;
    const windowUsed = days(RUN.applicationDeadline, RUN.publishedOn);
    const ceilingDays = total * 7 - windowUsed;
    expect(days(RUN.wrongEndDate, RUN.expectedStartDate)).toBeGreaterThan(ceilingDays);
    expect(days(RUN.correctEndDate, RUN.expectedStartDate)).toBeLessThanOrEqual(ceilingDays);
  });
});

describe('solicitation-create § Step 2 states the scoped addend', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  const endRow = text.split('\n').find((l) => l.includes('| `expected_end_date` | string')) ?? '';

  it('finds the expected_end_date row', () => {
    expect(endRow).not.toBe('');
  });

  it('does NOT tell you to add the whole stated duration band unqualified', () => {
    expect(
      /`expected_start_date \+ the PDD's stated duration band`/.test(endRow),
      'the expected_end_date row still adds the PDD\'s WHOLE stated duration band to a start ' +
        'date that already sits past the solicitation window and award — see ace#1858.',
    ).toBe(false);
  });

  it('scopes the addend to the post-award remainder', () => {
    expect(/POST-AWARD/i.test(endRow)).toBe(true);
    expect(/subtract/i.test(endRow)).toBe(true);
    // The two decision rules must both be stated, or the subtraction is a judgement call again.
    expect(/solicitation-open row\(s\) are ALWAYS subtracted/i.test(endRow)).toBe(true);
    expect(/purely contractual/i.test(endRow)).toBe(true);
  });

  it('Step 7a bounds the SPAN, not just the ordering', () => {
    expect(/Engagement span/i.test(text)).toBe(true);
    expect(/solicitation window actually used/i.test(text)).toBe(true);
  });
});

/**
 * ace#2231 — the INVERSE case: a PDD whose `## Timeline` clock starts at AWARD.
 *
 * #1858's ceiling subtracted the solicitation window unconditionally, which is
 * right only when the total CONTAINS that window. `poverty-graduation`'s § 17
 * opens with "Partner onboarding and FLW recruitment", so its 18-week total is
 * entirely post-award — Step 2 correctly subtracts nothing, and the
 * unconditional ceiling then rejects the value Step 2 just computed. Complying
 * publishes an end date two weeks SHORT of the programme's declared stages.
 *
 * Both PDD shapes are legal: `templates/pdd-template.md § Timeline` asks a PDD
 * to state where its clock starts precisely because the convention is not pinned.
 */
const AWARD_ANCHORED_RUN = {
  publishedOn: '2026-09-08',
  applicationDeadline: '2026-09-22',
  contractingAllowanceDays: 14,
  expectedStartDate: '2026-10-06',
  /** PDD § 17 rows, tops of bands. There is NO solicitation-open row. */
  timelineWeeks: {
    onboardingAndRecruitment: 3,
    targetingSurvey: 8,
    eligibilityDecision: 2,
    enrollmentAndDelivery: 5,
  },
  /** What Step 2 computes, and what shipped on solicitation 19188. */
  correctEndDate: '2027-02-09',
  /** What an unconditionally-subtracted ceiling would force instead. */
  truncatedEndDate: '2027-01-26',
};

describe('solicitation-create § Step 7a span ceiling is conditional (ace#2231)', () => {
  const t = AWARD_ANCHORED_RUN.timelineWeeks;
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  const days = (a: string, b: string) =>
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000;
  const windowUsed = days(AWARD_ANCHORED_RUN.applicationDeadline, AWARD_ANCHORED_RUN.publishedOn);
  const span = days(AWARD_ANCHORED_RUN.correctEndDate, AWARD_ANCHORED_RUN.expectedStartDate);

  it('the timeline is 18 weeks with no solicitation-open row to subtract', () => {
    expect(total).toBe(18);
    expect(Object.keys(t)).not.toContain('solicitationOpen');
  });

  it('Step 2 subtracts nothing, giving the date that shipped', () => {
    expect(addWeeks(AWARD_ANCHORED_RUN.expectedStartDate, total)).toBe(
      AWARD_ANCHORED_RUN.correctEndDate,
    );
    expect(span).toBe(total * 7);
  });

  it('the UNCONDITIONAL ceiling rejects that correct date', () => {
    const unconditional = total * 7 - windowUsed;
    expect(unconditional).toBe(112);
    expect(span).toBeGreaterThan(unconditional);
  });

  it('obeying the unconditional ceiling truncates the listing by the solicitation window', () => {
    expect(addWeeks(AWARD_ANCHORED_RUN.expectedStartDate, total)).toBe(
      AWARD_ANCHORED_RUN.correctEndDate,
    );
    expect(
      days(AWARD_ANCHORED_RUN.correctEndDate, AWARD_ANCHORED_RUN.truncatedEndDate),
    ).toBe(windowUsed);
  });

  it('the CONDITIONAL ceiling (subtrahend 0 when no solicitation row) accepts it', () => {
    const conditional = total * 7; // nothing to subtract
    expect(span).toBeLessThanOrEqual(conditional);
  });

  it('and still rejects the #1858 whole-total overshoot, which DOES contain the window', () => {
    // Regression guard: making the ceiling conditional must not blunt the original catch.
    const bednetTotal = 18;
    const bednetWindow = days(RUN.applicationDeadline, RUN.publishedOn);
    const bednetCeiling = bednetTotal * 7 - bednetWindow; // solicitation-open row present
    expect(days(RUN.wrongEndDate, RUN.expectedStartDate)).toBeGreaterThan(bednetCeiling);
  });
});

describe('solicitation-create § the ceiling PROSE states the condition', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  const step7a = text.slice(text.indexOf('**Engagement span'));

  it('says the subtrahend is conditional, not unconditional', () => {
    expect(/subtrahend is CONDITIONAL/i.test(step7a)).toBe(true);
  });

  it('names the award-anchored case and tells you to subtract nothing', () => {
    expect(/starts at award/i.test(step7a)).toBe(true);
    expect(/subtract nothing/i.test(step7a)).toBe(true);
  });

  it('Step 2 rule (1) states the has-none case, so the two steps read alike', () => {
    const endRow = text.split('\n').find((l) => l.includes('| `expected_end_date` | string')) ?? '';
    expect(/If the timeline has none/i.test(endRow)).toBe(true);
  });
});

describe('templates/pdd-template.md § Timeline names its own convention', () => {
  it('asks the PDD to say where its clock starts', () => {
    const text = fs.readFileSync(PDD_TEMPLATE, 'utf8');
    const timeline = text.slice(text.indexOf('## Timeline'), text.indexOf('## Timeline') + 900);
    expect(/where the clock starts|solicitation-open/i.test(timeline)).toBe(true);
  });
});
