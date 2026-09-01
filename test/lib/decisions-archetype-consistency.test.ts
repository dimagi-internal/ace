/**
 * Cross-row archetype consistency (ace#1859).
 *
 * The negative fixture is the real defective row from
 * `bednet-check-2-visit/20260828-0629`, transcribed from the Drive log
 * (`152EVc7xe9XjCSQ8ozz8tDeBWKLgXUv2mxe8Vs2zmeZU`) — including the CORRECTED
 * version, which is the positive control. Both matter: an over-broad version
 * of this rule fires on the corrected row too, because that row legitimately
 * offers `"multi-stage covered by both smokes"` as a rejected alternative.
 */
import { describe, expect, it } from 'vitest';

import {
  ARCHETYPES,
  ARCHETYPE_DECISION_ID,
  checkArchetypeConsistency,
  declaredArchetype,
  namedArchetypes,
  type ArchetypeCheckRow,
} from '../../lib/decisions-archetype-consistency.js';

/** The Phase-1 row that declares the run's archetype, as it really shipped. */
const declaring: ArchetypeCheckRow = {
  id: 'archetype-selection',
  value: 'longitudinal-visits',
  evidenceBasis: 'stated',
};

/** Phase 3's `test-archetype-coverage` row EXACTLY as it shipped — the defect. */
const defectiveCoverage: ArchetypeCheckRow = {
  id: 'test-archetype-coverage',
  value: 'atomic-visit covered by both smokes',
  paramsArchetype: 'atomic-visit',
  evidenceBasis: 'stated',
};

/** The same row after run-surface-audit's 2026-08-29 in-place correction. */
const correctedCoverage: ArchetypeCheckRow = {
  id: 'test-archetype-coverage',
  value: 'longitudinal-visits covered by both smokes',
  paramsArchetype: 'longitudinal-visits',
  evidenceBasis: 'stated',
};

describe('ARCHETYPES', () => {
  it('is sourced from the declared vocabulary, not restated', () => {
    expect([...ARCHETYPES].sort()).toEqual(
      ['atomic-visit', 'focus-group', 'longitudinal-visits', 'multi-stage'].sort(),
    );
    expect(ARCHETYPE_DECISION_ID).toBe('archetype-selection');
  });
});

describe('namedArchetypes', () => {
  it('finds a token embedded in a longer option label', () => {
    expect(namedArchetypes('atomic-visit covered by both smokes')).toEqual(['atomic-visit']);
  });

  it('does not confuse the four tokens with one another', () => {
    expect(namedArchetypes('longitudinal-visits')).toEqual(['longitudinal-visits']);
    expect(namedArchetypes('multi-stage covered by the deliver smoke only')).toEqual(['multi-stage']);
  });

  it('matches a pluralised mention', () => {
    expect(namedArchetypes('atomic-visits covered by both smokes')).toEqual(['atomic-visit']);
  });

  it('does not match a token glued into a longer word', () => {
    expect(namedArchetypes('semi-atomic-visitor')).toEqual([]);
    expect(namedArchetypes('')).toEqual([]);
  });
});

describe('declaredArchetype', () => {
  it('reads the run archetype off the archetype-selection row', () => {
    expect(declaredArchetype([declaring, correctedCoverage])).toBe('longitudinal-visits');
  });

  it('stays inert when the run has no archetype-selection row', () => {
    expect(declaredArchetype([defectiveCoverage])).toBeNull();
  });

  it('stays inert when the declaring row is ambiguous — never guesses ground truth', () => {
    expect(
      declaredArchetype([{ id: 'archetype-selection', value: 'atomic-visit or multi-stage' }]),
    ).toBeNull();
    expect(declaredArchetype([{ id: 'archetype-selection', value: 'to be decided' }])).toBeNull();
  });
});

describe('checkArchetypeConsistency', () => {
  it('NEGATIVE — flags the real ace#1859 row, in BOTH the fields it got wrong', () => {
    const r = checkArchetypeConsistency([declaring, defectiveCoverage]);
    expect(r.declared).toBe('longitudinal-visits');
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((c) => c.field).sort()).toEqual(['params.archetype', 'value']);
    for (const c of r.findings) {
      expect(c.id).toBe('test-archetype-coverage');
      expect(c.named).toBe('atomic-visit');
      expect(c.declared).toBe('longitudinal-visits');
      expect(c.detail).toContain('atomic-visit');
      expect(c.detail).toContain('longitudinal-visits');
    }
  });

  it('POSITIVE — the CORRECTED row is clean, alternatives and all', () => {
    // This is the test that keeps the rule narrow. The corrected row still
    // OFFERS `multi-stage covered by both smokes` as a rejected option and
    // still records `superseded_reading: multi-stage (prior run)` in params —
    // naming an alternative in order to reject it is what a decision row is
    // for. Only the value the run ACTS on has to agree.
    expect(checkArchetypeConsistency([declaring, correctedCoverage]).findings).toEqual([]);
  });

  it('POSITIVE — the declaring row alone is clean', () => {
    // `archetype-selection`'s own options list all four archetypes: that IS
    // the vocabulary. An `options`-scanning version of this rule flags the one
    // row that is definitionally right.
    expect(checkArchetypeConsistency([declaring]).findings).toEqual([]);
  });

  it('NEGATIVE — the declaring row is NOT exempt: its own params can contradict it', () => {
    // The value cannot disagree (it is where `declared` came from), but
    // `params.archetype` can, and a run whose declaring row disagrees with
    // ITSELF is the worst version of this defect. An `if (id === declaring)
    // continue` guard would silently exempt exactly that.
    const r = checkArchetypeConsistency([{ ...declaring, paramsArchetype: 'atomic-visit' }]);
    expect(r.declared).toBe('longitudinal-visits');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].field).toBe('params.archetype');
    expect(r.findings[0].named).toBe('atomic-visit');
  });

  it('POSITIVE — reasoning that rejects another archetype is not a contradiction', () => {
    // Three real rows in this run do exactly this ("not focus-group, so a real
    // Learn app carries the training curriculum"). `reasoning` is never read.
    expect(
      checkArchetypeConsistency([
        declaring,
        {
          id: 'ocs-prompt-composition',
          value: 'opp-specific composition',
          evidenceBasis: 'stated',
        },
      ]).findings,
    ).toEqual([]);
  });

  it('POSITIVE — a row declaring evidence_basis: conflicting is exempt', () => {
    // Run 20260825-1310 recorded `multi-stage` with `evidence_basis:
    // conflicting` on purpose. A row that has said, in the schema's own
    // vocabulary, that it is reconciling disagreeing sources must not be
    // punished for the honest encoding.
    expect(
      checkArchetypeConsistency([
        declaring,
        { id: 'x', value: 'multi-stage', evidenceBasis: 'conflicting' },
      ]).findings,
    ).toEqual([]);
  });

  it('POSITIVE — inert on a run with no declared archetype', () => {
    const r = checkArchetypeConsistency([defectiveCoverage]);
    expect(r.declared).toBeNull();
    expect(r.findings).toEqual([]);
    expect(checkArchetypeConsistency([]).findings).toEqual([]);
  });

  it('compares the EFFECTIVE value, so a human override is what gets checked', () => {
    // Callers pass `override ?? ai-default`. A reviewer who overrode a row to
    // the right archetype must not still be flagged for ACE's original
    // proposal, and one who overrode it to the WRONG archetype must be.
    expect(
      checkArchetypeConsistency([declaring, { id: 'r', value: 'longitudinal-visits' }])
        .findings,
    ).toEqual([]);
    expect(
      checkArchetypeConsistency([declaring, { id: 'r', value: 'focus-group' }]).findings,
    ).toHaveLength(1);
  });
});
