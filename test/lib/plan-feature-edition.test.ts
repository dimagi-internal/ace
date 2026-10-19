/**
 * dimagi-internal/ace#3206 — app-deploy verifies EVERY `plan-feature`
 * confirmation by checking the space's subscription `edition` against the
 * entry's `plans` string. Fixtures are the four `plans` strings Nova returned
 * on connect-fi/20261018-1440 (edition Advanced).
 */
import { describe, expect, it } from 'vitest';
import { planIncludesEdition } from '../../lib/plan-feature-edition.js';

describe('planIncludesEdition', () => {
  it('Advanced is in "Standard, Pro, Advanced and Enterprise" (lookup-tables)', () => {
    expect(planIncludesEdition('Standard, Pro, Advanced and Enterprise', 'Advanced')).toBe(true);
  });

  it('Advanced is in "Pro, Advanced and Enterprise" (child-cases, data-forwarding)', () => {
    expect(planIncludesEdition('Pro, Advanced and Enterprise', 'Advanced')).toBe(true);
  });

  it('Standard is NOT in "Pro, Advanced and Enterprise"', () => {
    expect(planIncludesEdition('Pro, Advanced and Enterprise', 'Standard')).toBe(false);
  });

  it('Free is never included', () => {
    expect(planIncludesEdition('Standard, Pro, Advanced and Enterprise', 'Free')).toBe(false);
    expect(planIncludesEdition('Pro, Advanced and Enterprise', 'Free')).toBe(false);
  });

  it('Enterprise is in "Advanced and Enterprise" (advanced-case-actions), the last item', () => {
    expect(planIncludesEdition('Advanced and Enterprise', 'Enterprise')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(planIncludesEdition('Pro, Advanced and Enterprise', 'advanced')).toBe(true);
    expect(planIncludesEdition('pro, advanced and enterprise', 'ENTERPRISE')).toBe(true);
  });

  it('matches whole items only — "Pro" does not match inside another word', () => {
    expect(planIncludesEdition('Professional and Enterprise', 'Pro')).toBe(false);
    expect(planIncludesEdition('Advanced and Enterprise', 'Advance')).toBe(false);
  });

  it('never confirms on empty input', () => {
    expect(planIncludesEdition('', 'Advanced')).toBe(false);
    expect(planIncludesEdition('Pro, Advanced and Enterprise', '')).toBe(false);
  });
});
