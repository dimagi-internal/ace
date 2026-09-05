import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { classifyComponentSet } from '../../lib/component-set';
import {
  findCrossReferences,
  assessProgrammeReadiness,
  type ComponentBody,
} from '../../lib/programme-overview';

//
// The cross-reference fixtures below are the REAL relationships found in the
// poverty-graduation component PDDs on 2026-09-05 (grepped from the documents,
// not imagined): 5 → {6, 9}, 6 → {5b}, 4 → {2, 3}. The programme carries
// 2, 4, 5, 6 — so 9, 5b and 3 are referenced but absent.
//

const BODIES: ComponentBody[] = [
  {
    component_id: '4',
    text: `Framing note. Enrollment activates a selected or included household.
Inputs: the scored household list from Component 2, and where a validation
layer exists, the finalized list from Component 3.`,
  },
  {
    component_id: '5',
    text: `Framing note. In-kind productive asset transfer.
Round two is gated on Component 9 verifying the business is operating.
Consumption support (Component 6) shares the verification machinery.`,
  },
  {
    component_id: '6',
    text: `Framing note. Consumption support is the small recurring transfer.
This component owns the transfer method and its verification, and that
ownership is shared. Component 5b (cash asset transfer) also uses it.`,
  },
  {
    component_id: '2',
    text: `Framing note. The household poverty targeting survey. Produces a
scored household list.`,
  },
];

const PRESENT = ['2', '4', '5', '6'];

describe('findCrossReferences — real relationships', () => {
  it('finds what each component leans on', () => {
    const refs = findCrossReferences(BODIES, PRESENT);
    const asString = refs.map((r) => `${r.from}->${r.to}`);
    expect(asString).toEqual(['4->2', '4->3', '5->6', '5->9', '6->5b']);
  });

  it('marks 3, 9 and 5b unresolved — they are referenced but not in this programme', () => {
    const refs = findCrossReferences(BODIES, PRESENT);
    expect(refs.filter((r) => !r.resolved).map((r) => r.to).sort()).toEqual(['3', '5b', '9']);
  });

  it('does NOT read a document\'s own declaration line as a reference to itself', () => {
    // The declaration uses a colon; a prose reference does not.
    const refs = findCrossReferences(
      [{ component_id: '4', text: 'Version: 0.1 · Component: 4 of the graduation component set' }],
      ['4'],
    );
    expect(refs).toEqual([]);
  });

  it('excludes a colon-form declaration line naming a DIFFERENT component', () => {
    // The sibling test above cannot detect the mechanism it is named for: its
    // declaration names the body's own id, so the self-reference drop satisfies
    // it whether or not the regex excludes `Component:`. Measured 2026-09-05 —
    // relaxing PROSE_REF_RE to /\bComponent\s*:?\s*(\d+[a-z]?)\b/gi leaves all
    // 11 tests in this file green. This one goes red, because `from !== to`.
    const refs = findCrossReferences(
      [{ component_id: '4', text: 'Version: 0.1 · Component: 6 of the graduation component set' }],
      ['4', '6'],
    );
    expect(refs).toEqual([]);
  });

  it('drops self-references, which carry no information', () => {
    const refs = findCrossReferences(
      [{ component_id: '5', text: 'See Component 5 above. Also Component 6.' }],
      ['5', '6'],
    );
    expect(refs.map((r) => r.to)).toEqual(['6']);
  });

  it('de-duplicates a component mentioned many times', () => {
    const refs = findCrossReferences(
      [{ component_id: '5', text: 'Component 9 gates it. Component 9 again. And Component 9.' }],
      ['5'],
    );
    expect(refs).toHaveLength(1);
  });

  it('keeps 5b distinct from 5', () => {
    const refs = findCrossReferences(
      [{ component_id: '6', text: 'Component 5b uses it, not Component 5.' }],
      ['5', '6'],
    );
    expect(refs.map((r) => `${r.to}:${r.resolved}`)).toEqual(['5:true', '5b:false']);
  });
});

describe('assessProgrammeReadiness — obligations on the overview', () => {
  const set = classifyComponentSet(
    ['2', '4', '5', '6'].map((id) => ({
      file_id: `id-${id}`,
      name: `PDD ${id}`,
      text: `Program Design Document (PDD): Component ${id}\nVersion: 0.1 · Component: ${id} of the graduation component set`,
    })),
  );

  it('is ok when there is something to build — obligations are work, not a gate', () => {
    const r = assessProgrammeReadiness(set, BODIES);
    expect(r.ok).toBe(true);
    expect(r.obligations.length).toBeGreaterThan(0);
  });

  it('always demands selection, case model, composition and downstream use', () => {
    const r = assessProgrammeReadiness(set, BODIES);
    const codes = r.obligations.map((o) => o.code);
    expect(codes).toContain('declare-selection');
    expect(codes).toContain('declare-case-model');
    expect(codes).toContain('declare-composition');
    expect(codes).toContain('declare-downstream-use');
  });

  it('asks, per referring component, what it does without the absent one', () => {
    const r = assessProgrammeReadiness(set, BODIES);
    const absent = r.obligations.filter((o) => o.code === 'resolve-absent-reference');
    // 4 (needs 3) and 5 (needs 9) and 6 (needs 5b) — one each, not one per reference.
    expect(absent.map((o) => o.components[0])).toEqual(['4', '5', '6']);
    expect(absent.find((o) => o.components[0] === '5')?.question).toMatch(/Component 9/);
  });

  it('raises no absent-reference obligation when the programme is self-contained', () => {
    const selfContained: ComponentBody[] = [
      { component_id: '4', text: 'Depends on Component 2.' },
      { component_id: '2', text: 'Stands alone.' },
    ];
    const s = classifyComponentSet(
      ['2', '4'].map((id) => ({
        file_id: id,
        name: id,
        text: `Program Design Document (PDD): C${id}\nVersion: 0.1 · Component: ${id} of the set`,
      })),
    );
    const r = assessProgrammeReadiness(s, selfContained);
    expect(r.obligations.some((o) => o.code === 'resolve-absent-reference')).toBe(false);
  });

  it('produces no obligations for an empty set', () => {
    const r = assessProgrammeReadiness(classifyComponentSet([]), []);
    expect(r.ok).toBe(false);
    expect(r.obligations).toEqual([]);
  });
});
