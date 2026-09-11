/**
 * ace#2373 — an accuracy-conditioned GPS dedup radius is coherent by
 * construction; only an UNCONDITIONED radius at or below the worst accepted
 * accuracy is the ace#984 incoherence.
 *
 * The two controls are the Targeting PDD's own §6 wordings, verbatim:
 *   - v1.0 (the ace#984 defect): an unconditioned `< 15m` against a 50 m
 *     tolerance → MUST classify incoherent.
 *   - v1.1 [FIXED] (the author's resolution, rev 86 of
 *     `1u-QzTn1G82n5U5J5txjUFjoNOnlQzGEnmU3B57AcYNs`): the same radius, run only
 *     where both readings beat it, identifiers otherwise → MUST classify
 *     coherent.
 *
 * Before ace#2373 the brief and the gate compared the two numbers as scalars,
 * so both wordings read 15 <= 50 → incoherent.
 */
import { describe, it, expect } from 'vitest';
import {
  BOTH_ACCURACIES_BELOW_RADIUS,
  classifyGpsDedupCoherence,
  parseGpsDedupWording,
  readGpsDedupRule,
} from '../../lib/gps-dedup-coherence';

const V1_0_WORDING = 'Duplicates: same household identifiers, or same GPS point (< 15m).';
const V1_1_WORDING =
  'Duplicates: same household identifiers, or same GPS point (< 15m) where both readings have ' +
  'accuracy better than 15m. Where either reading is less accurate than the radius, duplicate ' +
  'detection relies on identifiers alone.';
const TOLERANCE_M = 50;

describe('controls — the two Targeting PDD §6 wordings', () => {
  it('POSITIVE: v1.1 [FIXED] accuracy-conditioned radius classifies coherent', () => {
    const rule = parseGpsDedupWording(V1_1_WORDING);
    expect(rule).not.toBeNull();
    expect(rule!.radius_m).toBe(15);
    expect(rule!.condition).toEqual({ kind: 'both-readings-accuracy-below', accuracy_below_m: 15 });
    expect(rule!.fallback).toBe('identifiers');
    const c = classifyGpsDedupCoherence(rule!, TOLERANCE_M);
    expect(c.verdict).toBe('coherent');
    expect(c.basis).toBe('accuracy-conditioned');
    expect(c.notes).toEqual([]);
  });

  it('NEGATIVE: v1.0 unconditioned radius against a 50 m tolerance classifies incoherent', () => {
    const rule = parseGpsDedupWording(V1_0_WORDING);
    expect(rule).not.toBeNull();
    expect(rule!.radius_m).toBe(15);
    expect(rule!.condition).toEqual({ kind: 'unconditioned' });
    const c = classifyGpsDedupCoherence(rule!, TOLERANCE_M);
    expect(c.verdict).toBe('incoherent');
    expect(c.basis).toBe('radius-within-tolerance');
  });
});

describe('readGpsDedupRule — program_parameters shapes', () => {
  it('reads the canonical structured object (run_state YAML) and classifies it coherent', () => {
    const rule = readGpsDedupRule({
      duplicate_gps_rule: { radius_m: 15, applies_when: BOTH_ACCURACIES_BELOW_RADIUS, fallback: 'identifiers' },
    });
    expect(rule!.source).toBe('structured');
    expect(classifyGpsDedupCoherence(rule!, TOLERANCE_M).verdict).toBe('coherent');
  });

  it('reads the PDD body table one-line string form', () => {
    const rule = readGpsDedupRule({
      duplicate_gps_rule: 'radius_m=15; applies_when=both_accuracies_below_radius; fallback=identifiers',
    });
    expect(rule).toEqual({
      radius_m: 15,
      condition: { kind: 'both-readings-accuracy-below', accuracy_below_m: 15 },
      fallback: 'identifiers',
      source: 'structured',
    });
  });

  it('a structured rule WITHOUT applies_when is unconditioned, so 15 vs 50 is incoherent', () => {
    const rule = readGpsDedupRule({ duplicate_gps_rule: { radius_m: 15 } });
    expect(rule!.condition).toEqual({ kind: 'unconditioned' });
    expect(classifyGpsDedupCoherence(rule!, TOLERANCE_M).verdict).toBe('incoherent');
  });

  it('a bare duplicate_gps_radius_m scalar is NOT the whole rule — unclear, never incoherent', () => {
    // The shape poverty-graduation/20260908-0510 emitted for a PDD whose rule was
    // conditioned: classifying the scalar as unconditioned is how the condition
    // was dropped on the way downstream.
    const rule = readGpsDedupRule({ duplicate_gps_radius_m: 15 });
    expect(rule!.source).toBe('bare-scalar');
    expect(rule!.condition.kind).toBe('unknown');
    const c = classifyGpsDedupCoherence(rule!, TOLERANCE_M);
    expect(c.verdict).toBe('unclear');
    expect(c.verdict).not.toBe('incoherent');
    expect(c.detail).toMatch(/parseGpsDedupWording/);
  });

  it('prefers the structured rule over a legacy scalar when both are present', () => {
    const rule = readGpsDedupRule({
      duplicate_gps_radius_m: 15,
      duplicate_gps_rule: { radius_m: 15, applies_when: BOTH_ACCURACIES_BELOW_RADIUS },
    });
    expect(rule!.source).toBe('structured');
  });

  it('returns null when the PDD decides no GPS dedup rule', () => {
    expect(readGpsDedupRule({ learn_passing_score: 80 })).toBeNull();
  });

  it('throws on a malformed canonical rule rather than guessing', () => {
    expect(() => readGpsDedupRule({ duplicate_gps_rule: { radius_m: 'fifteen' } })).toThrow(/radius_m/);
    expect(() =>
      readGpsDedupRule({ duplicate_gps_rule: { radius_m: 15, applies_when: 'either_accuracy_below_radius' } }),
    ).toThrow(/applies_when/);
  });
});

describe('classifyGpsDedupCoherence — the other branches', () => {
  it('an unconditioned radius above the worst accepted accuracy stays coherent (the #984 rule, unchanged)', () => {
    const c = classifyGpsDedupCoherence(
      { radius_m: 60, condition: { kind: 'unconditioned' }, fallback: null, source: 'structured' },
      TOLERANCE_M,
    );
    expect(c.verdict).toBe('coherent');
    expect(c.basis).toBe('radius-exceeds-tolerance');
  });

  it('a radius EQUAL to the worst accepted accuracy is still incoherent ("at or below")', () => {
    const c = classifyGpsDedupCoherence(
      { radius_m: 50, condition: { kind: 'unconditioned' }, fallback: null, source: 'structured' },
      TOLERANCE_M,
    );
    expect(c.verdict).toBe('incoherent');
  });

  it('a condition LOOSER than the radius does not rescue it', () => {
    const rule = parseGpsDedupWording(
      'Same GPS point (< 15m) where both readings have accuracy better than 30m.',
    );
    expect(rule!.condition).toEqual({ kind: 'both-readings-accuracy-below', accuracy_below_m: 30 });
    const c = classifyGpsDedupCoherence(rule!, TOLERANCE_M);
    expect(c.verdict).toBe('incoherent');
    expect(c.basis).toBe('condition-looser-than-radius');
  });

  it('a conditioned rule with no stated fallback is coherent, with a build-memo note', () => {
    const rule = parseGpsDedupWording('Same GPS point (< 15m) where both readings have accuracy better than 15m.');
    const c = classifyGpsDedupCoherence(rule!, TOLERANCE_M);
    expect(c.verdict).toBe('coherent');
    expect(c.notes.join(' ')).toMatch(/build memo/);
  });

  it('"better than the radius" resolves to the radius itself', () => {
    const rule = parseGpsDedupWording(
      'Same GPS point (within 20 m), but only where each reading has accuracy better than the radius.',
    );
    expect(rule!.condition).toEqual({ kind: 'both-readings-accuracy-below', accuracy_below_m: 20 });
  });
});

describe('parseGpsDedupWording — conservative in both directions', () => {
  it('a condition on only ONE reading is unknown, not conditioned', () => {
    const rule = parseGpsDedupWording('Same GPS point (< 15m) where either reading has accuracy better than 15m.');
    expect(rule!.condition.kind).toBe('unknown');
    expect(classifyGpsDedupCoherence(rule!, TOLERANCE_M).verdict).toBe('unclear');
  });

  it('accuracy mentioned in an unrecognised shape is unknown, not unconditioned', () => {
    const rule = parseGpsDedupWording('Same GPS point (< 15m), weighting each pair by its reported accuracy.');
    expect(rule!.condition.kind).toBe('unknown');
  });

  it('"less accurate than" is not mistaken for the coherent condition', () => {
    const rule = parseGpsDedupWording('Same GPS point (< 15m) where both readings are less accurate than 15m.');
    expect(rule!.condition.kind).toBe('unknown');
  });

  it('returns null when no GPS radius is stated', () => {
    expect(parseGpsDedupWording('Duplicates: same household identifiers.')).toBeNull();
  });
});
