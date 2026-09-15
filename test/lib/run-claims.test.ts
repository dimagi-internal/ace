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

// ── Task 2: freeze + immutability ──────────────────────────────────

import { freezeClaimSet, diffFrozenClaims } from '../../lib/run-claims.js';

const pending = () => parseClaimSet(VALID).claimSet!;

describe('freezeClaimSet', () => {
  it('stamps frozen_at and source_run_id', () => {
    const r = freezeClaimSet(pending(), { runId: '20260908-0510', now: '2026-09-15T10:30:00Z' });
    expect(r.ok).toBe(true);
    expect(r.claimSet?.frozen_at).toBe('2026-09-15T10:30:00Z');
    expect(r.claimSet?.source_run_id).toBe('20260908-0510');
  });

  it('refuses to re-freeze an already-frozen set', () => {
    const once = freezeClaimSet(pending(), { runId: 'r1', now: '2026-09-15T10:30:00Z' }).claimSet!;
    const twice = freezeClaimSet(once, { runId: 'r2', now: '2026-09-15T11:00:00Z' });
    expect(twice.ok).toBe(false);
    expect(twice.issues.join(' ')).toMatch(/already frozen/i);
  });

  it('refuses to freeze an empty claim set', () => {
    const empty = { ...pending(), claims: [] };
    expect(freezeClaimSet(empty, { runId: 'r1', now: 'n' }).ok).toBe(false);
  });
});

describe('diffFrozenClaims', () => {
  const frozen = () =>
    freezeClaimSet(pending(), { runId: 'r1', now: '2026-09-15T10:30:00Z' }).claimSet!;

  it('allows an identical set', () => {
    expect(diffFrozenClaims(frozen(), frozen())).toEqual([]);
  });

  it('rejects an added claim', () => {
    const f = frozen();
    const more = { ...f, claims: [...f.claims, { ...f.claims[0], id: 'sneaky' }] };
    expect(diffFrozenClaims(f, more).join(' ')).toContain('sneaky');
  });

  it('rejects a removed claim', () => {
    const f = frozen();
    expect(diffFrozenClaims(f, { ...f, claims: [] }).join(' ')).toContain('cs-deliver-unpaid');
  });

  it('rejects a reworded claim — the exam cannot change after the run starts', () => {
    const f = frozen();
    const soft = {
      ...f,
      claims: [{ ...f.claims[0], claim: 'The Deliver app mentions payment somewhere.' }],
    };
    expect(diffFrozenClaims(f, soft).join(' ')).toMatch(/reworded|changed/i);
  });

  it('ALLOWS verdict fields to be written — that is the whole point', () => {
    const f = frozen();
    const answered = {
      ...f,
      claims: [
        { ...f.claims[0], verdict: 'MET' as const, evidence_kind: 'probed' as const, evidence: 'x' },
      ],
    };
    expect(diffFrozenClaims(f, answered)).toEqual([]);
  });
});

// ── Task 3: verdict recording ──────────────────────────────────────

import { recordVerdict, claimsDueAt } from '../../lib/run-claims.js';

const frozenSet = () =>
  freezeClaimSet(pending(), { runId: 'r1', now: '2026-09-15T10:30:00Z' }).claimSet!;

describe('recordVerdict', () => {
  it('records MET with probed evidence', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'MET',
      evidence_kind: 'probed',
      evidence: 'CCZ b3f1c2 — 0 matches for <connect:payment>',
      phase: 'commcare-setup',
      now: '2026-09-15T14:02:11Z',
    });
    expect(r.ok).toBe(true);
    expect(r.claimSet?.claims[0].verdict).toBe('MET');
    expect(r.claimSet?.claims[0].checked_in_phase).toBe('commcare-setup');
  });

  it('REFUSES a probe-kind claim recorded as judged — the degradation this exists to prevent', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'MET',
      evidence_kind: 'judged',
      evidence: 'looked about right',
      phase: 'commcare-setup',
      now: 'n',
    });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/probe/i);
  });

  it('REFUSES INDETERMINATE without would_settle_it', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'INDETERMINATE',
      evidence: 'ambiguous',
      phase: 'commcare-setup',
      now: 'n',
    });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/would_settle_it/);
  });

  it('accepts INDETERMINATE when it names what would settle it', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'INDETERMINATE',
      evidence: 'the CCZ has two distribution forms',
      would_settle_it: 'which form the opportunity binds as the payable deliver unit',
      phase: 'commcare-setup',
      now: 'n',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses an unknown claim id rather than silently doing nothing', () => {
    const r = recordVerdict(frozenSet(), 'no-such-claim', {
      verdict: 'MET',
      evidence_kind: 'probed',
      evidence: 'x',
      phase: 'p',
      now: 'n',
    });
    expect(r.ok).toBe(false);
  });

  it('requires non-empty evidence for every verdict', () => {
    const r = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'UNMET',
      evidence_kind: 'probed',
      evidence: '',
      phase: 'p',
      now: 'n',
    });
    expect(r.ok).toBe(false);
  });
});

describe('claimsDueAt', () => {
  it('returns only claims whose checkable_at matches', () => {
    expect(claimsDueAt(frozenSet(), 'commcare-setup')).toHaveLength(1);
    expect(claimsDueAt(frozenSet(), 'connect-setup')).toHaveLength(0);
  });

  it('does not re-return a claim that already has a verdict', () => {
    const answered = recordVerdict(frozenSet(), 'cs-deliver-unpaid', {
      verdict: 'MET',
      evidence_kind: 'probed',
      evidence: 'x',
      phase: 'commcare-setup',
      now: 'n',
    }).claimSet!;
    expect(claimsDueAt(answered, 'commcare-setup')).toHaveLength(0);
  });
});
