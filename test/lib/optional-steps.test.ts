import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  OptionalStepsError,
  isOptionalStepEnabled,
  renderOptionalStepsYaml,
  resolveOptionalSteps,
  validateOptionalStepsBlock,
} from '../../lib/optional-steps.js';

const now = new Date('2026-10-18T14:02:00Z');

function refusal(fn: () => unknown): OptionalStepsError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OptionalStepsError) return e;
    throw e;
  }
  throw new Error('expected an OptionalStepsError');
}

describe('resolveOptionalSteps', () => {
  it('default is all-off: no flag, no opp.yaml → null (no block is written)', () => {
    expect(resolveOptionalSteps({ now })).toBeNull();
    expect(resolveOptionalSteps({ withFlag: '', oppYamlSteps: undefined, now })).toBeNull();
    expect(resolveOptionalSteps({ oppYamlSteps: [], now })).toBeNull();
    expect(resolveOptionalSteps({ oppYamlSteps: { google_form: false }, now })).toBeNull();
  });

  it('labs_e2e expands to every step with simulate_weeks=4 and the default seed count', () => {
    expect(resolveOptionalSteps({ withFlag: 'labs_e2e', now })).toEqual({
      resolved_at: '2026-10-18T14:02:00.000Z',
      source: 'flag',
      private_solicitation: true,
      google_form: true,
      seed_responses: { count: 5 },
      ace_winner: true,
      supply_chain: true,
      simulate_weeks: 4,
    });
  });

  it('seed_responses forces private_solicitation and records which step forced it', () => {
    const r = resolveOptionalSteps({ withFlag: 'seed_responses=7', now })!;
    expect(r.private_solicitation).toBe(true);
    expect(r.seed_responses).toEqual({ count: 7 });
    expect(r.implied).toEqual({ private_solicitation: 'seed_responses' });
  });

  it('ace_winner forces private_solicitation too', () => {
    expect(resolveOptionalSteps({ withFlag: 'ace_winner', now })!.private_solicitation).toBe(true);
  });

  it('google_form alone does NOT imply a private call', () => {
    const r = resolveOptionalSteps({ withFlag: 'google_form', now })!;
    expect(r.google_form).toBe(true);
    expect(r.private_solicitation).toBe(false);
    expect(r.implied).toBeUndefined();
  });

  it('supply_chain without ace_winner is refused', () => {
    expect(refusal(() => resolveOptionalSteps({ withFlag: 'supply_chain', now })).code).toBe('REQUIRES_ACE_WINNER');
    expect(refusal(() => resolveOptionalSteps({ withFlag: 'simulate_weeks=2', now })).code).toBe('REQUIRES_ACE_WINNER');
  });

  it('--invite-candidates with seed_responses is refused', () => {
    expect(
      refusal(() => resolveOptionalSteps({ withFlag: 'seed_responses', inviteCandidates: true, now })).code,
    ).toBe('INVITE_CANDIDATES_CONFLICT');
    // ...but invite-candidates with a private call and no fabricated responses is fine
    expect(resolveOptionalSteps({ withFlag: 'private_solicitation', inviteCandidates: true, now })).not.toBeNull();
  });

  it('an unknown name is refused, never ignored', () => {
    expect(refusal(() => resolveOptionalSteps({ withFlag: 'private_solicitaton', now })).code).toBe('UNKNOWN_STEP');
    expect(refusal(() => resolveOptionalSteps({ oppYamlSteps: ['labs-e2e'], now })).code).toBe('UNKNOWN_STEP');
  });

  it('values are validated', () => {
    expect(refusal(() => resolveOptionalSteps({ withFlag: 'ace_winner,simulate_weeks=0', now })).code).toBe('BAD_VALUE');
    expect(refusal(() => resolveOptionalSteps({ withFlag: 'seed_responses=lots', now })).code).toBe('BAD_VALUE');
    expect(refusal(() => resolveOptionalSteps({ withFlag: 'google_form=1', now })).code).toBe('BAD_VALUE');
  });

  it('reads opp.yaml in both list and mapping shapes, and reports the source', () => {
    const list = resolveOptionalSteps({ oppYamlSteps: ['private_solicitation'], now })!;
    expect(list.source).toBe('opp.yaml');
    const map = resolveOptionalSteps({
      oppYamlSteps: { ace_winner: true, seed_responses: { count: 3 }, simulate_weeks: 6, supply_chain: true },
      now,
    })!;
    expect(map.seed_responses).toEqual({ count: 3 });
    expect(map.simulate_weeks).toBe(6);
    expect(refusal(() => resolveOptionalSteps({ oppYamlSteps: 'labs_e2e', now })).code).toBe('BAD_OPP_YAML');
  });

  it('flag and opp.yaml combine; the flag wins a value conflict', () => {
    const r = resolveOptionalSteps({
      withFlag: 'simulate_weeks=6',
      oppYamlSteps: { ace_winner: true, simulate_weeks: 4 },
      now,
    })!;
    expect(r.source).toBe('both');
    expect(r.simulate_weeks).toBe(6);
    expect(r.ace_winner).toBe(true);
  });
});

describe('the persisted block', () => {
  it('renders YAML that parses back to the resolved object and validates clean', () => {
    const r = resolveOptionalSteps({ withFlag: 'labs_e2e', now })!;
    const parsed = YAML.parse(renderOptionalStepsYaml(r)).optional_steps;
    expect(parsed).toEqual(r);
    expect(validateOptionalStepsBlock(parsed)).toEqual([]);
    const implied = resolveOptionalSteps({ withFlag: 'seed_responses', oppYamlSteps: ['google_form'], now })!;
    const p2 = YAML.parse(renderOptionalStepsYaml(implied)).optional_steps;
    expect(p2).toEqual(implied);
    expect(p2.source).toBe('both');
  });

  it('opp.yaml source renders as a quoted string', () => {
    const r = resolveOptionalSteps({ oppYamlSteps: ['google_form'], now })!;
    expect(YAML.parse(renderOptionalStepsYaml(r)).optional_steps.source).toBe('opp.yaml');
  });

  it('validator: absent is valid; a hand-edited block that breaks an implication is not', () => {
    expect(validateOptionalStepsBlock(undefined)).toEqual([]);
    const r = resolveOptionalSteps({ withFlag: 'labs_e2e', now })!;
    expect(validateOptionalStepsBlock({ ...r, private_solicitation: false }).join('\n')).toMatch(/forces a private call/);
    expect(validateOptionalStepsBlock({ ...r, ace_winner: false }).join('\n')).toMatch(/ace_winner is not/);
    expect(validateOptionalStepsBlock({ ...r, bogus: true }).join('\n')).toMatch(/unknown key/);
    expect(validateOptionalStepsBlock(['labs_e2e'])).toEqual(['optional_steps must be a mapping']);
  });

  it('isOptionalStepEnabled reads only the persisted block', () => {
    expect(isOptionalStepEnabled({}, 'seed_responses')).toBe(false);
    expect(isOptionalStepEnabled(null, 'seed_responses')).toBe(false);
    const r = resolveOptionalSteps({ withFlag: 'seed_responses', now })!;
    expect(isOptionalStepEnabled({ optional_steps: r }, 'seed_responses')).toBe(true);
    expect(isOptionalStepEnabled({ optional_steps: r }, 'private_solicitation')).toBe(true);
    expect(isOptionalStepEnabled({ optional_steps: r }, 'supply_chain')).toBe(false);
  });
});
