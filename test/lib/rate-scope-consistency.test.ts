/**
 * Tests for `lib/rate-scope-consistency.ts` (ace#2265).
 *
 * The positive control is solicitation 19201's live Q8 text — the shipped
 * contradiction. The negative controls are the sibling strings from the SAME
 * record that were always correct: Q8's own framing and the linked evaluation
 * criterion, both of which already asserted all-in. It matters that those pass,
 * because they are what the corrected question has to agree with.
 *
 * Policy under test (Jonathan, 2026-09-08): "the LLO should propose an all-in
 * rate per verified service delivery, and explicitly how much is paid to the
 * worker vs. commodity."
 */
import { describe, it, expect } from 'vitest';
import {
  scanRateScope,
  hasCompositionAsk,
  formatRateScope,
} from '../../lib/rate-scope-consistency.js';

// ── Verbatim from 19201: the question text that shipped wrong ───────────────
const Q8_TEXT_SHIPPED =
  'Provide a budget breakdown for the proposed scope, distinguishing: FLW ' +
  'compensation; supervision and coordination staff time; transport and field ' +
  'logistics; device, connectivity and data costs; and reporting time. State ' +
  'clearly which of these your proposed per-worker-day rate is intended to ' +
  'cover and which you would expect to be funded separately, and give an ' +
  'indicative total for a cohort at the size you would propose.';

// ── Verbatim from 19201: the siblings that were already right ──────────────
const Q8_FRAMING_SHIPPED =
  'A strong answer separates worker compensation from the costs a partner ' +
  'absorbs — supervision, transport, devices, data, reporting time — and ' +
  'states which of them your proposed per-day rate is expected to cover. ' +
  'Vague single-line totals score low.';

const CRITERION_SHIPPED =
  'Quality of the proposed per-worker-day rate and its justification, and ' +
  'whether the budget honestly separates worker pay from partner-absorbed costs.';

// ── What a corrected question looks like under the policy ──────────────────
const Q8_TEXT_CORRECTED =
  'Propose your all-in rate per verified service delivery, and state how much ' +
  'of it is paid to the worker vs. commodity — supervision, transport, ' +
  'devices, connectivity and reporting time. Give an indicative total for a ' +
  'cohort at the size you would propose.';

describe('the shipped Q8 text — the contradiction this exists for', () => {
  it('flags the separately-funded invitation', () => {
    const result = scanRateScope({
      questions: [{ id: 'budget-breakdown', text: Q8_TEXT_SHIPPED, framing: Q8_FRAMING_SHIPPED }],
    });
    const separate = result.issues.filter((i) => i.kind === 'separately-funded-invitation');
    expect(separate).toHaveLength(1);
    expect(separate[0].match).toBe('funded separately');
    expect(separate[0].field).toBe('questions[0] (budget-breakdown).text');
  });

  it('tells the author the rate is all-in, not just that the phrase is wrong', () => {
    const result = scanRateScope({ questions: [{ id: 'q', text: Q8_TEXT_SHIPPED }] });
    const [issue] = result.issues.filter((i) => i.kind === 'separately-funded-invitation');
    expect(issue.remedy).toMatch(/ALL-IN/);
    expect(issue.remedy).toMatch(/worker and commodity/);
  });

  it('also flags that the shipped record never asked for the split', () => {
    // 19201 asked for a five-category breakdown but never for worker vs.
    // commodity — so both halves of the policy were missing at once.
    const result = scanRateScope({
      questions: [{ id: 'budget-breakdown', text: Q8_TEXT_SHIPPED, framing: Q8_FRAMING_SHIPPED }],
      evaluation_criteria: [{ id: 'payment-economics-and-budget', description: CRITERION_SHIPPED }],
    });
    expect(result.issues.some((i) => i.kind === 'missing-composition-ask')).toBe(true);
  });
});

describe('the siblings from the same record that were already correct', () => {
  it('does not flag Q8 framing, which already asserted partner-absorbed', () => {
    expect(scanRateScope({ questions: [{ framing: Q8_FRAMING_SHIPPED }] }).issues.filter(
      (i) => i.kind === 'separately-funded-invitation',
    )).toEqual([]);
  });

  it('does not flag the evaluation criterion', () => {
    expect(scanRateScope({ evaluation_criteria: [{ description: CRITERION_SHIPPED }] }).issues.filter(
      (i) => i.kind === 'separately-funded-invitation',
    )).toEqual([]);
  });

  it('does not flag asking what the rate COVERS — that is the legitimate ask', () => {
    const text = 'State which of these your proposed rate is intended to cover.';
    expect(scanRateScope({ questions: [{ text }] }).issues.filter(
      (i) => i.kind === 'separately-funded-invitation',
    )).toEqual([]);
  });
});

describe('a corrected question satisfies both halves of the policy', () => {
  it('is clean', () => {
    const result = scanRateScope({
      questions: [{ id: 'rate-and-composition', text: Q8_TEXT_CORRECTED }],
    });
    expect(result.clean).toBe(true);
    expect(formatRateScope(result)).toBe('');
  });
});

describe('recognising the composition ask, however it is worded', () => {
  it.each([
    'State how much of the rate is paid to the worker vs. commodity.',
    'Break the commodity cost out against the worker portion.',
    'Tell us how much goes to the worker and how much covers everything else.',
    'Give the worker share of your proposed all-in rate.',
    'Provide a breakdown showing the worker component of the rate.',
  ])('accepts: %s', (text) => {
    expect(hasCompositionAsk({ questions: [{ text }] })).toBe(true);
  });

  it.each([
    'Provide a budget breakdown for the proposed scope.',
    'Propose your per-unit rate and justify it against local labour rates.',
    'Give an indicative total for a cohort at the size you would propose.',
  ])('does not mistake a generic budget ask for it: %s', (text) => {
    expect(hasCompositionAsk({ questions: [{ text }] })).toBe(false);
  });

  it('accepts the ask wherever it appears, not only in questions[].text', () => {
    expect(
      hasCompositionAsk({
        scope_of_work: 'Respondents state how much of the rate is paid to the worker vs. commodity.',
      }),
    ).toBe(true);
    expect(
      hasCompositionAsk({
        questions: [{ text: 'Budget?', framing: 'Name the worker share of the all-in rate.' }],
      }),
    ).toBe(true);
  });
});

describe('the other separate-funding phrasings', () => {
  it.each([
    ['costs reimbursed separately by the programme', 'reimbursed separately'],
    ['items billed separately outside this schedule', 'billed separately'],
    ['supervision is separately funded', 'separately funded'],
    ['devices are funded outside the rate', 'funded outside the rate'],
    ['request a separate budget line for transport', 'a separate budget line'],
  ])('flags %s', (text, expected) => {
    const issues = scanRateScope({ questions: [{ text }] }).issues.filter(
      (i) => i.kind === 'separately-funded-invitation',
    );
    expect(issues.map((i) => i.match?.toLowerCase())).toContain(expected);
  });
});

describe('the operator-facing message', () => {
  it('states the policy, not just the violation', () => {
    const out = formatRateScope(scanRateScope({ questions: [{ text: Q8_TEXT_SHIPPED }] }));
    expect(out).toContain('[BLOCKER]');
    expect(out).toContain('ALL-IN');
    expect(out).toContain('worker vs. commodity');
  });
});
