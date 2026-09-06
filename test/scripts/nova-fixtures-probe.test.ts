import { describe, expect, it } from 'vitest';
import { classifyFixtureProbe, remedyFor } from '../../scripts/probe-nova-fixtures.js';

/**
 * The probe's network half is gated behind NOVA_API_KEY; its verdict logic is
 * not, and the verdict is what tells a run whether Step 4f can still finish a
 * partner register on its own. These pin the one distinction that matters: a
 * capability that EXISTS is not a capability that WORKS.
 *
 * The direction reversed on 2026-09-06 (ace#1886). `both` was the adoption
 * signal; it is now the expected steady state, and `create-only` — once
 * "today" — is a regression.
 */
describe('classifyFixtureProbe', () => {
  it('create + bind → both (expected since 2026-09-06)', () => {
    expect(classifyFixtureProbe({ canCreateTable: true, canBindSelect: true })).toBe('both');
  });

  it('create without bind → create-only (the state observed 2026-09-01, now a regression)', () => {
    expect(
      classifyFixtureProbe({
        canCreateTable: true,
        canBindSelect: false,
        bindError: 'its Project lookup definitions are unavailable',
      }),
    ).toBe('create-only');
  });

  /**
   * The bind failure that has no error attached. Until 2026-09-06 the probe
   * scored the bind as "the write returned no error", and a correctly bound
   * field comes back from `add_fields` with `options: []` and no source — so
   * the write response cannot tell a landed bind from a missing one in either
   * direction. `canBindSelect` now means "read back as a lookup source".
   */
  it('an ACCEPTED write whose read-back did not confirm is NOT a bind', () => {
    expect(
      classifyFixtureProbe({
        canCreateTable: true,
        canBindSelect: false,
        bindAccepted: true,
        bindReadBackIssue: 'field reads back with options source kind "absent", not "lookup"',
      }),
    ).toBe('create-only');
  });

  it('no create atom → none, whatever the bind says', () => {
    expect(classifyFixtureProbe({ canCreateTable: false, canBindSelect: false })).toBe('none');
    expect(classifyFixtureProbe({ canCreateTable: false, canBindSelect: true })).toBe('none');
  });

  it('never reports a transient arm — Nova’s "retry" wording is misleading', () => {
    // Reproduced across separate apps, tables and minutes. If a future reader
    // adds a 'transient' verdict, this is the evidence they must overturn.
    const verdicts = new Set(
      [true, false].flatMap((c) => [true, false].map((b) => classifyFixtureProbe({ canCreateTable: c, canBindSelect: b }))),
    );
    expect([...verdicts].sort()).toEqual(['both', 'create-only', 'none']);
  });
});

describe('remedyFor', () => {
  it('both is the expected state and authorises the autonomous register', () => {
    const remedy = remedyFor('both');
    expect(remedy).toMatch(/EXPECTED/);
    expect(remedy).toMatch(/creates, populates AND binds/i);
  });

  /**
   * The whole point of keeping this probe after the adoption. If the bind
   * regresses, a build must go back to halting — shipping invented options
   * instead is the ace#1621 defect, which has no downstream symptom.
   */
  it('create-only now reads as a REGRESSION that restores the halt', () => {
    const remedy = remedyFor('create-only');
    expect(remedy).toMatch(/REGRESSION/);
    expect(remedy).toMatch(/must HALT/);
    expect(remedy).toMatch(/upstream-regression-triage/);
  });

  it('every failing verdict routes to upstream-regression-triage at the right repo', () => {
    for (const v of ['create-only', 'none'] as const) {
      expect(remedyFor(v)).toMatch(/voidcraft-labs\/commcare-nova/);
    }
  });
});
