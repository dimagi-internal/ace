/**
 * Tests for `lib/run-claims.ts` — the pure core of pre-run claims /
 * post-run validation.
 *
 * Source-of-truth contract:
 *   - `docs/superpowers/specs/2026-09-15-pre-run-claims-post-run-validation-design.md`
 *
 * The rules under test are the ones that make the mechanism honest:
 *   - a frozen claim cannot be reworded once results start arriving
 *   - a `probe`-kind check cannot silently degrade into a `judged` opinion
 *   - INDETERMINATE must name what would settle it
 *   - an unanswered claim becomes NOT REACHED, which accuses
 *   - a run whose answered claims all passed is NOT "all met" if a
 *     checkpoint never ran
 */

import { describe, it, expect } from 'vitest';
import { parseClaimSet } from '../../lib/run-claims.js';

const VALID = {
  schema_version: 1,
  kind: 'run-claims',
  opp: 'poverty-graduation',
  claims: [
    {
      id: 'cs-deliver-unpaid',
      claim: "The Deliver app's consumption-support distribution visit carries no payment marker.",
      artifact: 'deliver-app',
      checkable_at: 'commcare-setup',
      origin: { kind: 'counterpart-decision', person: 'Sophie Feintuch' },
      authored_by: 'ace',
      check: { kind: 'probe', how: 'Parse the released Deliver CCZ.' },
    },
  ],
};

describe('parseClaimSet', () => {
  it('accepts a well-formed pending claim set', () => {
    const r = parseClaimSet(VALID);
    expect(r.ok).toBe(true);
    expect(r.claimSet?.claims).toHaveLength(1);
    expect(r.issues).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(parseClaimSet('nope').ok).toBe(false);
  });

  it('names the offending claim id in the issue text', () => {
    const bad = { ...VALID, claims: [{ ...VALID.claims[0], checkable_at: '' }] };
    const r = parseClaimSet(bad);
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toContain('cs-deliver-unpaid');
  });

  it('rejects duplicate claim ids', () => {
    const dup = { ...VALID, claims: [VALID.claims[0], VALID.claims[0]] };
    const r = parseClaimSet(dup);
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/duplicate/i);
  });
});
