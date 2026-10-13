/**
 * dimagi-internal/ace#2857 — Step 4f halting a build that is CORRECT.
 *
 * On `turmeric-market-study-ghana/20261012-1749` the `market` field was a
 * PDD-declared select, shipped as `kind: text`, and a component of the payable
 * `turmeric_survey` entity key — so step 7's halt fired. But no market is named
 * anywhere in any input: the implementing organisation chooses them after the
 * build (operator ruling `market-list-source-confirmed`), the PDD itself names
 * a text field as the interim mechanism, and Phase 2's journeys pass on either
 * shape. Every rung of the step-5 ladder was empty, so the halt could not be
 * discharged by any amount of re-running, and the Phase 3 agent overrode it on
 * its own judgement.
 *
 * The exemption added here is NOT the one the issue proposed. That one keyed
 * on the PDD declaring free text as an "advisory mechanism" — which keys a
 * payment gate on AI-authored prose, letting Phase 1 disarm Phase 3. This one
 * keys on whether a single legitimate member of the option set exists anywhere
 * the build can read, which is a fact about the world and is recorded.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyOptionSourceGap,
  describeOptionSourceGaps,
  type OptionSourceGapInput,
} from '../../lib/option-register';

/** The halting default: payable, in the entity key, enumerable, no register. */
const base: OptionSourceGapInput = {
  field_id: 'market',
  feeds_entity_id: true,
  payable: true,
  non_enumerable_by_nature: false,
  candidate_values: [],
};

describe('classifyOptionSourceGap — the halt still fires where it should', () => {
  it('halts when candidate values exist and the field is in a payable entity key', () => {
    // The original defect (ace#1136): the build COULD have enumerated and
    // didn't. Nothing about ace#2857 relaxes this.
    const v = classifyOptionSourceGap({
      ...base,
      candidate_values: ['kejetia', 'makola', 'kumasi-central'],
    });
    expect(v.outcome).toBe('halt');
    expect(v.exemption).toBeUndefined();
    expect(v.reason).toMatch(/3 candidate value\(s\) are available/);
    expect(v.reason).toMatch(/kejetia/);
  });

  it('halts on a PDD-named partner register whatever the payability (ace#1621)', () => {
    // This outranks every exemption, including an unpaid unit and an empty
    // candidate set — the register EXISTS and must be read, not worked around.
    for (const extra of [
      { payable: false },
      { feeds_entity_id: false },
      { non_enumerable_by_nature: true },
      { candidate_values: [] },
    ]) {
      const v = classifyOptionSourceGap({
        ...base,
        ...extra,
        declares_partner_register: true,
      });
      expect(v.outcome).toBe('halt');
      expect(v.reason).toMatch(/ace#1621/);
    }
  });
});

describe('classifyOptionSourceGap — the two pre-existing exemptions (ace#1295)', () => {
  it('records on an UNPAID deliver unit', () => {
    const v = classifyOptionSourceGap({
      ...base,
      payable: false,
      candidate_values: ['a', 'b'],
    });
    expect(v.outcome).toBe('record');
    expect(v.exemption).toBe('unpaid-deliver-unit');
  });

  it('records when the field is not in the entity key', () => {
    const v = classifyOptionSourceGap({
      ...base,
      feeds_entity_id: false,
      candidate_values: ['a', 'b'],
    });
    expect(v.outcome).toBe('record');
    expect(v.exemption).toBe('not-in-entity-key');
  });

  it('records a component non-enumerable BY NATURE', () => {
    // bednet-check-2-visit/20260813-2313: a personal name in a concat() key.
    const v = classifyOptionSourceGap({
      ...base,
      field_id: 'hh_head_name',
      non_enumerable_by_nature: true,
    });
    expect(v.outcome).toBe('record');
    expect(v.exemption).toBe('non-enumerable-by-nature');
  });
});

describe('classifyOptionSourceGap — the new exemption (ace#2857)', () => {
  it('records the live turmeric `market` case instead of halting it', () => {
    const v = classifyOptionSourceGap(base); // payable, in the key, zero candidates
    expect(v.outcome).toBe('record');
    expect(v.exemption).toBe('no-candidate-values');
  });

  it('explains WHY halting would accomplish nothing, not merely that it is allowed', () => {
    const v = classifyOptionSourceGap(base);
    expect(v.reason).toMatch(/Re-running Phase 3 cannot produce the set/);
    expect(v.reason).toMatch(/no-inferred-backstory/);
  });

  it('ONE candidate value is enough to put the halt back', () => {
    // The boundary that keeps this from being a loophole: the moment the build
    // can name a real member of the set, a rung of the ladder is open.
    expect(classifyOptionSourceGap({ ...base, candidate_values: ['kejetia'] }).outcome).toBe(
      'halt',
    );
  });

  it('is not reachable by PDD prose — the input carries no PDD text at all', () => {
    // The filed remedy would have keyed on the PDD saying "Mechanism
    // (advisory)". If a future edit reintroduces that, this fails: the shape
    // of the input is the guarantee.
    const keys = Object.keys(base).concat('declares_partner_register').sort();
    expect(keys).toEqual([
      'candidate_values',
      'declares_partner_register',
      'feeds_entity_id',
      'field_id',
      'non_enumerable_by_nature',
      'payable',
    ]);
  });
});

describe('every recorded gap gates go-live, never nothing', () => {
  // The skill prescribed `recommended-confirmation` in the same sentence as
  // "since it is a go-live prerequisite", and that ask gates nothing
  // (lib/decisions-schema.ts). That contradiction is what made the exemption
  // above safe to add: the gap now blocks the gate it belongs to.
  const cases: OptionSourceGapInput[] = [
    base,
    { ...base, payable: false },
    { ...base, feeds_entity_id: false },
    { ...base, non_enumerable_by_nature: true },
    { ...base, candidate_values: ['a'] },
    { ...base, declares_partner_register: true },
  ];

  it('always asks required-before / go-live, on halt and on record alike', () => {
    for (const c of cases) {
      const v = classifyOptionSourceGap(c);
      expect(v.review_ask).toBe('required-before');
      expect(v.needed_by).toBe('go-live');
    }
  });

  it('never returns `recommended-confirmation`', () => {
    for (const c of cases) {
      expect(JSON.stringify(classifyOptionSourceGap(c))).not.toMatch(
        /recommended-confirmation/,
      );
    }
  });

  it('always names the field and gives a reason, so a row is never bare', () => {
    for (const c of cases) {
      const v = classifyOptionSourceGap(c);
      expect(v.field_id).toBe(c.field_id);
      expect(v.reason).toContain(c.field_id);
      expect(v.reason.length).toBeGreaterThan(40);
    }
  });
});

describe('describeOptionSourceGaps', () => {
  it('renders one line per field, tagged with outcome and exemption', () => {
    const lines = describeOptionSourceGaps([
      classifyOptionSourceGap(base),
      classifyOptionSourceGap({ ...base, field_id: 'seller_id', non_enumerable_by_nature: true }),
      classifyOptionSourceGap({ ...base, field_id: 'crop', candidate_values: ['turmeric'] }),
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[record:no-candidate-values\] market:/);
    expect(lines[1]).toMatch(/^\[record:non-enumerable-by-nature\] seller_id:/);
    expect(lines[2]).toMatch(/^\[halt\] crop:/);
  });
});
