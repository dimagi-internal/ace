import { describe, expect, it } from 'vitest';
import { classifyFixtureProbe, remedyFor } from '../../scripts/probe-nova-fixtures.ts';

/**
 * The probe's network half is gated behind NOVA_API_KEY; its verdict logic is
 * not, and the verdict is what decides whether ACE keeps the partner-register
 * halt. These pin the one distinction that matters: a capability that EXISTS
 * is not a capability that WORKS.
 */
describe('classifyFixtureProbe', () => {
  it('create + bind → both (the halt may be retired)', () => {
    expect(classifyFixtureProbe({ canCreateTable: true, canBindSelect: true })).toBe('both');
  });

  it('create without bind → create-only (observed live 2026-09-01)', () => {
    expect(
      classifyFixtureProbe({
        canCreateTable: true,
        canBindSelect: false,
        bindError: 'its Project lookup definitions are unavailable',
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
  it('create-only keeps the halt and blames the binding, not the create atom', () => {
    const remedy = remedyFor('create-only');
    expect(remedy).toMatch(/HALT STAYS/);
    expect(remedy).toMatch(/binding, not the create atom/);
  });

  it('both is the only verdict that authorises retiring the handoff', () => {
    expect(remedyFor('both')).toMatch(/retire the operator handoff/i);
    expect(remedyFor('create-only')).not.toMatch(/retire/i);
    expect(remedyFor('none')).not.toMatch(/retire/i);
  });

  it('none routes to upstream-regression-triage at the right repo', () => {
    expect(remedyFor('none')).toMatch(/voidcraft-labs\/commcare-nova/);
  });
});
