/**
 * dimagi-internal/ace#1368 (split out of #1250) — a Learn app's `result_pass`
 * label can claim readiness far broader than the bank actually certifies, and
 * nothing compares the two.
 *
 * On bednet-check-2-visit/20260813-2333 the built label reads:
 *
 *   "You can now begin delivery work"
 *
 * after examining TWO payment-model facts — directly contradicting the PDD's
 * own D-1 residual, which states the gate "is not a competence certification
 * and must not be described as one". The PDD wrote the residual honestly; the
 * builder then wrote a label that violates it.
 *
 * The pass label is what the WORKER reads. A gate certifying two payment-model
 * facts, telling a worker they are ready to begin delivery work, is a claim the
 * programme explicitly disclaimed — and it is the shape a worker will
 * reasonably rely on.
 *
 * Worth recording what that gate never tests: the follow-up CONSENT
 * RE-AFFIRMATION, which is the sole server-side payment predicate
 * (`form_field_rules` keys on `consent_confirmed`, per the same PDD's D-6). A
 * worker can clear the gate and still fail the only check that decides whether
 * they get paid.
 */
import { describe, it, expect } from 'vitest';
import { checkPassLabelScope } from '../../lib/pass-label-scope.js';

const TWO_FACTS = ['only the follow-up visit is paid', 'consent must be re-confirmed each visit'];

describe('checkPassLabelScope (#1368)', () => {
  it('flags the live label — a readiness claim over a 2-item payment-model bank', () => {
    const r = checkPassLabelScope('You can now begin delivery work.', {
      certifiedRules: TWO_FACTS,
      declaredNotCompetence: true,
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('readiness-overclaim');
    expect(r.detail).toMatch(/not a competence certification/i);
  });

  it('flags a competence claim even when the PDD did not disclaim one', () => {
    const r = checkPassLabelScope('You are now qualified to visit households.', {
      certifiedRules: TWO_FACTS,
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('readiness-overclaim');
  });

  it('passes a label scoped to what the bank tested', () => {
    const r = checkPassLabelScope(
      'Passed. You answered both payment rules correctly: only the follow-up visit is paid, and ' +
        'consent must be re-confirmed each visit.',
      { certifiedRules: TWO_FACTS, declaredNotCompetence: true },
    );
    expect(r.ok).toBe(true);
  });

  it('passes a plain acknowledgement that claims nothing', () => {
    expect(checkPassLabelScope('Passed. Well done.', { certifiedRules: TWO_FACTS }).ok).toBe(true);
  });

  it('does NOT fire on a large bank — the overclaim is relative to what was tested', () => {
    const r = checkPassLabelScope('You can now begin delivery work.', {
      certifiedRules: Array.from({ length: 14 }, (_, i) => `rule ${i}`),
    });
    expect(r.ok).toBe(true);
  });

  it('still fires on a large bank when the PDD explicitly disclaimed competence', () => {
    const r = checkPassLabelScope('You can now begin delivery work.', {
      certifiedRules: Array.from({ length: 14 }, (_, i) => `rule ${i}`),
      declaredNotCompetence: true,
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('contradicts-declared-scope');
  });

  it('is inert on an empty label rather than inventing a finding', () => {
    expect(checkPassLabelScope('', { certifiedRules: TWO_FACTS }).ok).toBe(true);
  });

  it('names the payment predicate the gate does not test, when one is declared', () => {
    const r = checkPassLabelScope('You can now begin delivery work.', {
      certifiedRules: TWO_FACTS,
      declaredNotCompetence: true,
      untestedPaymentPredicate: 'consent_confirmed on the follow-up form',
    });
    expect(r.detail).toMatch(/consent_confirmed/);
  });
});
