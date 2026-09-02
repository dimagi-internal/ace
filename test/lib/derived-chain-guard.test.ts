/**
 * ace#1823 — the Deliver app writes poverty scores for households that don't
 * exist.
 *
 * The fixture below is the released hh-poverty-targeting form
 * (`hh-poverty-targeting`, HQ app `ce668763ad6c4b48ac5f4cd4502f3f8c`), read out
 * of `deliver-latest-release.ccz` -> `modules-0/forms-0.xml`: the roster is
 * gated on consent, `ppi_score` carries an inline `visit_outcome = 'completed'`
 * guard, and the other twelve derived nodes sit at form root with nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  checkDerivedChainGuards,
  formatDerivedChainReport,
  referencedFields,
  conditionalTest,
  type DerivedField,
} from '../../lib/derived-chain-guard.js';

/** The shipped shape, trimmed to the nodes that carry the defect. */
function shippedForm(): DerivedField[] {
  return [
    { id: 'visit_outcome', kind: 'single_select' },
    {
      id: 'consent_screen',
      kind: 'group',
      children: [{ id: 'consent', kind: 'single_select' }],
    },
    {
      id: 'roster',
      kind: 'repeat',
      relevant: "/data/consent_screen/consent = 'yes'",
      children: [{ id: 'is_member', kind: 'single_select' }],
    },
    {
      id: 'member_count',
      kind: 'hidden',
      calculate: "count(/data/roster/is_member[. = 'yes'])",
    },
    {
      id: 'hh_size_band',
      kind: 'hidden',
      calculate:
        "if(/data/member_count <= 3, 'le3', if(/data/member_count <= 6, 'r4to6', 'gt6'))",
    },
    {
      id: 'size_points',
      kind: 'hidden',
      calculate: "if(/data/hh_size_band = 'le3', 31, if(/data/hh_size_band = 'r4to6', 10, 0))",
    },
    {
      id: 'ppi_score',
      kind: 'hidden',
      calculate:
        "if(/data/visit_outcome = 'completed', /data/size_points + /data/zone_points, '')",
    },
    { id: 'zone_points', kind: 'hidden', calculate: "if(/data/zone = 'urban', 8, 0)" },
    { id: 'zone', kind: 'single_select' },
  ];
}

describe('the shipped form is caught (ace#1823)', () => {
  const report = checkDerivedChainGuards(shippedForm());
  const ids = report.findings.map((f) => f.fieldId);

  it('member_count is flagged — count() over a skipped repeat returns 0', () => {
    expect(ids).toContain('member_count');
    const f = report.findings.find((x) => x.fieldId === 'member_count')!;
    // The gate OWNER is what a human needs named, not the leaf under it.
    expect(f.gatedSourceId).toBe('roster');
    expect(f.gate).toBe("/data/consent_screen/consent = 'yes'");
    expect(f.transitive).toBe(false);
  });

  it('hh_size_band is flagged — the band is the field the fraud control groups on', () => {
    // 1,072 of 3,794 records landed in the 31-point band by construction.
    expect(ids).toContain('hh_size_band');
    expect(report.findings.find((x) => x.fieldId === 'hh_size_band')!.transitive).toBe(true);
  });

  it('size_points is flagged — taint propagates the whole chain, not one hop', () => {
    expect(ids).toContain('size_points');
  });

  it('an if() whose TEST reads only tainted fields is not a guard', () => {
    // `if(member_count <= 3, 'le3', …)` looks defensive and faithfully converts
    // a phantom 0 into a phantom band. That is the corruption wearing an if().
    const calc = shippedForm().find((f) => f.id === 'hh_size_band')!.calculate!;
    expect(conditionalTest(calc)).toContain('member_count');
    expect(ids).toContain('hh_size_band');
  });

  it('ppi_score is NOT flagged — its guard reads an ungated discriminator', () => {
    // The one node that was already right. Flagging it would make the check an
    // always-fires blocker on a correct form.
    expect(ids).not.toContain('ppi_score');
  });

  it('a derived field that reads nothing gated is NOT flagged', () => {
    expect(ids).not.toContain('zone_points');
  });

  it('the report names the gate a human has to reason about', () => {
    const text = formatDerivedChainReport(report);
    expect(text).toContain('UNGUARDED');
    expect(text).toContain("consent = 'yes'");
    expect(text).toContain('hh_size_band');
  });
});

describe('the fixed form is clean — the negative control', () => {
  it('guarding each derived node on the ungated discriminator clears every finding', () => {
    const fixed = shippedForm().map((f) => {
      if (['member_count', 'hh_size_band', 'size_points'].includes(f.id)) {
        return { ...f, relevant: "/data/visit_outcome = 'completed'" };
      }
      return f;
    });
    const r = checkDerivedChainGuards(fixed);
    expect(r.findings).toEqual([]);
    expect(formatDerivedChainReport(r)).toContain('OK');
  });

  it('an inline conditional on the discriminator clears it too', () => {
    // Same fix in the shape ppi_score already used, since that is what the
    // architect will reach for.
    const fixed = shippedForm().map((f) =>
      f.id === 'member_count'
        ? {
            ...f,
            calculate:
              "if(/data/visit_outcome = 'completed', count(/data/roster/is_member[. = 'yes']), '')",
          }
        : f,
    );
    const r = checkDerivedChainGuards(fixed);
    expect(r.findings.map((x) => x.fieldId)).toEqual([]);
  });

  it('a form with no gated container has nothing to find', () => {
    const r = checkDerivedChainGuards([
      { id: 'a', kind: 'integer' },
      { id: 'b', kind: 'hidden', calculate: '/data/a * 2' },
    ]);
    expect(r.findings).toEqual([]);
    expect(r.gatedSources).toEqual([]);
  });

  it('a derived field INSIDE the gated group is not a finding', () => {
    // It is skipped along with its source, so it never submits a phantom value.
    const r = checkDerivedChainGuards([
      {
        id: 'g',
        kind: 'group',
        relevant: "/data/consent = 'yes'",
        children: [
          { id: 'x', kind: 'integer' },
          { id: 'x2', kind: 'hidden', calculate: '/data/x * 2' },
        ],
      },
    ]);
    expect(r.findings).toEqual([]);
  });
});

describe('reference extraction does not invent references', () => {
  const known = new Set(['a', 'b', 'le3']);

  it('reads absolute and bare paths', () => {
    expect(referencedFields('/data/a + b', known).sort()).toEqual(['a', 'b']);
  });

  it('ignores XPath function names', () => {
    expect(referencedFields('count(/data/a)', known)).toEqual(['a']);
  });

  it('ignores string literals — a value must never resolve to a field', () => {
    // `'le3'` is a band VALUE that happens to share a name with a field here.
    expect(referencedFields("if(/data/a = 'le3', 1, 0)", known)).toEqual(['a']);
  });
});

describe('conditionalTest', () => {
  it('extracts the test of a 3-arg if()', () => {
    expect(conditionalTest("if(/data/x = 'y', 1, 0)")).toBe("/data/x = 'y'");
  });

  it('is depth-aware — a call inside the test does not end it early', () => {
    expect(conditionalTest('if(count(/data/r) > 0, 1, 0)')).toBe('count(/data/r) > 0');
  });

  it('returns null for a non-conditional', () => {
    expect(conditionalTest('/data/a + /data/b')).toBeNull();
    expect(conditionalTest("count(/data/r[. = 'yes'])")).toBeNull();
  });
});
