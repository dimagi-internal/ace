/**
 * ace#1417 — findOrCreate is check-then-act, so two concurrent writers of the
 * same artifact name both miss the lookup and both create.
 */
import { describe, it, expect } from 'vitest';
import {
  pickCanonical,
  reconcileAfterCreate,
  type DriveSibling,
} from '../../lib/drive-duplicate-reconcile';

const at = (id: string, createdTime: string | null): DriveSibling => ({ id, createdTime });

describe('pickCanonical is deterministic across writers', () => {
  it('picks the earliest createdTime', () => {
    expect(pickCanonical([at('b', '2026-08-14T20:19:05Z'), at('a', '2026-08-14T20:19:01Z')])!.id)
      .toBe('a');
  });

  it('is order-independent — every writer sees the same winner', () => {
    const s = [at('z', '2026-08-14T20:19:05Z'), at('a', '2026-08-14T20:19:01Z'), at('m', '2026-08-14T20:19:03Z')];
    const shuffled = [s[2], s[0], s[1]];
    expect(pickCanonical(s)!.id).toBe(pickCanonical(shuffled)!.id);
  });

  it('breaks a createdTime tie by id, so the rule stays total', () => {
    const t = '2026-08-14T20:19:01Z';
    expect(pickCanonical([at('b', t), at('a', t)])!.id).toBe('a');
  });

  it('sorts an unknown createdTime LAST — it must never win', () => {
    // If it could win, two writers with different field selections would
    // disagree about the canonical file and both could trash.
    expect(pickCanonical([at('a', null), at('b', '2026-08-14T20:19:05Z')])!.id).toBe('b');
  });

  it('returns undefined for an empty set', () => {
    expect(pickCanonical([])).toBeUndefined();
  });
});

describe('the live race (bednet-check-2-visit/20260814-2019)', () => {
  // Parent's call landed first; the subagent's 6.5-minute call landed after.
  const parent = at('1NrTc7ZRSY5cQKY07_DHYQV-x2VcfEqJ3WTZSZXM6PDE', '2026-08-14T20:19:01Z');
  const subagent = at('1RgVqiranxNpxlOGGyY-hbRpDWio_mGpCYo0aop5y7s8', '2026-08-14T20:25:33Z');
  const siblings = [parent, subagent];

  it('the earlier writer keeps its file', () => {
    expect(reconcileAfterCreate(parent.id, siblings)).toEqual({
      action: 'keep',
      canonicalId: parent.id,
    });
  });

  it('the later writer adopts the earlier file and trashes its OWN', () => {
    expect(reconcileAfterCreate(subagent.id, siblings)).toEqual({
      action: 'adopt',
      canonicalId: parent.id,
      trashId: subagent.id,
    });
  });

  it('both writers converge on the same id', () => {
    const a = reconcileAfterCreate(parent.id, siblings).canonicalId;
    const b = reconcileAfterCreate(subagent.id, siblings).canonicalId;
    expect(a).toBe(b);
  });

  it('a writer never nominates another writer’s file for trashing', () => {
    for (const me of [parent.id, subagent.id]) {
      const v = reconcileAfterCreate(me, siblings);
      if (v.action === 'adopt') expect(v.trashId).toBe(me);
    }
  });
});

describe('degenerate inputs never trash', () => {
  it('a single sibling is a keep', () => {
    expect(reconcileAfterCreate('a', [at('a', '2026-08-14T20:19:01Z')]).action).toBe('keep');
  });

  it('an empty listing is a keep — never act on incomplete information', () => {
    expect(reconcileAfterCreate('a', [])).toEqual({ action: 'keep', canonicalId: 'a' });
  });

  it('a listing that does not contain us is a keep', () => {
    // Eventual consistency: our own create may not be in the index yet.
    // Trashing here would delete a file we never made.
    expect(reconcileAfterCreate('a', [at('b', '2026-08-14T20:19:01Z')]))
      .toEqual({ action: 'keep', canonicalId: 'a' });
  });
});

describe('three-way races converge too', () => {
  const s = [at('c', '2026-08-14T20:19:07Z'), at('a', '2026-08-14T20:19:01Z'), at('b', '2026-08-14T20:19:04Z')];

  it('exactly one writer keeps; the rest adopt', () => {
    const outcomes = ['a', 'b', 'c'].map((id) => reconcileAfterCreate(id, s));
    expect(outcomes.filter((o) => o.action === 'keep')).toHaveLength(1);
    expect(outcomes.every((o) => o.canonicalId === 'a')).toBe(true);
  });

  it('every adopter trashes only itself, so all three files resolve to one', () => {
    const trashed = ['a', 'b', 'c']
      .map((id) => reconcileAfterCreate(id, s))
      .flatMap((o) => (o.action === 'adopt' ? [o.trashId] : []));
    expect(trashed.sort()).toEqual(['b', 'c']);
  });
});
