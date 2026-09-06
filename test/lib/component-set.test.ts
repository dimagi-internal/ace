import { describe, it, expect } from 'vitest';
import {
  classifyComponentSet,
  compareComponentIds,
  type ComponentSetInput,
} from '../../lib/component-set';

//
// The fixtures below are the REAL first lines of the poverty-graduation input
// set, read off Drive on 2026-09-05 — not invented shapes. A classifier
// validated only against strings this repo authored would pass while failing
// on the documents it exists to read.
//

const ENROLLMENT = `Program Design Document (PDD): Enrollment
Version: 0.1 (draft) · Status: Draft for discussion, not SME-approved · Author: drafted with Claude · Intended compiler: ACE · Component: 4 of the graduation component set
Framing note. Enrollment activates a selected or included household: it confirms the household's identity against its targeting record, explains the program, records participation consent, collects the operating data the downstream components need, and sets the enrolled state (starting the graduation clock).`;

const PRODUCTIVE_ASSET = `Program Design Document (PDD): Productive Asset Transfer (In-Kind)
Version: 0.1 (draft) · Status: Draft for discussion, not SME-approved · Author: drafted with Claude · Intended compiler: ACE · Component: 5 of the graduation component set
Framing note. This PDD covers the in-kind form of the productive asset transfer: a physic`;

const CONSUMPTION = `Program Design Document (PDD): Recurring Consumption Support
Version: 0.1 (draft) · Status: Draft for discussion, not SME-approved · Author: drafted with Claude · Intended compiler: ACE · Component: 6 of the graduation component set
Framing note. Consumption support is the small recurring transfer that stabilizes household consumption.
This component owns the transfer method and its verification, and that ownership is shared. Component 5b (cash asset transfer) also uses it.`;

const LEARN = `Program Design Document (PDD): Learn (Program Training and Certification)
Version: 0.4 (draft) · Status: Draft for discussion, not SME-approved · Author: drafted with Claude · Intended compiler: ACE · Scope: program-level (cross-component)
Framing note. The program has one Learn app, not one per component.`;

// Authored by a different person, BEFORE the convention existed. Declares
// nothing. Its Drive filename says "(Component 2)" — which is exactly the
// evidence this classifier must refuse to accept.
const TARGETING = `Program Design Document (PDD): Household Poverty Targeting Survey
Version: 1.0 (draft for discussion) · Status: Example / illustrative — not yet SME-approved · Author: Neal Lesh (drafted with Claude) · Intended compiler: ACE · Intended reviewers: Graduation SME (TBD), 1–2 LLOs, Dimagi delivery team`;

const FRAMEWORK = `Poverty Graduation on Connect: Models and Components Framework
Purpose: A map of the components a graduation program is built from and how each would be built on Connect.
Components vs models. The components below are a menu.`;

function input(name: string, text: string): ComponentSetInput {
  return { file_id: `id-${name}`, name, text };
}

const REAL_SET: ComponentSetInput[] = [
  input('Graduation Framework', FRAMEWORK),
  input('PDD - Enrollment', ENROLLMENT),
  input('PDD - Productive Asset (In-kind)', PRODUCTIVE_ASSET),
  input('PDD - Consumpton Support', CONSUMPTION),
  input('PDD - Learn', LEARN),
  input('PDD - Targeting Survey (Component 2) — copied from hh-poverty-targeting', TARGETING),
];

describe('classifyComponentSet — against the real poverty-graduation set', () => {
  it('finds the three declared components, by the AUTHOR\'s ids', () => {
    const set = classifyComponentSet(REAL_SET);
    expect(set.components.map((c) => c.component_id)).toEqual(['4', '5', '6']);
    expect(set.components.map((c) => c.declared_title)).toEqual([
      'Enrollment',
      'Productive Asset Transfer (In-Kind)',
      'Recurring Consumption Support',
    ]);
  });

  it('separates the program-level PDD from the components', () => {
    const set = classifyComponentSet(REAL_SET);
    expect(set.programLevel.map((p) => p.declared_title)).toEqual([
      'Learn (Program Training and Certification)',
    ]);
    expect(set.components.some((c) => c.declared_title?.startsWith('Learn'))).toBe(false);
  });

  it('treats the framework as supporting — it is not PDD-shaped', () => {
    const set = classifyComponentSet(REAL_SET);
    expect(set.supporting.map((s) => s.name)).toContain('Graduation Framework');
  });

  it('REFUSES the filename as evidence: the targeting PDD is undeclared, not Component 2', () => {
    const set = classifyComponentSet(REAL_SET);
    const undeclared = set.undeclared.map((u) => u.declared_title);
    expect(undeclared).toEqual(['Household Poverty Targeting Survey']);
    // The filename literally contains "(Component 2)". It must not become an id.
    expect(set.components.map((c) => c.component_id)).not.toContain('2');
    const finding = set.findings.find((f) => f.code === 'undeclared-pdd');
    expect(finding?.where).toEqual([
      'PDD - Targeting Survey (Component 2) — copied from hh-poverty-targeting',
    ]);
    expect(finding?.fix).toMatch(/Component: <n>/);
  });

  it('is ok overall — an undeclared PDD is a gap to close, not a blocker', () => {
    expect(classifyComponentSet(REAL_SET).ok).toBe(true);
  });
});

describe('classifyComponentSet — the traps', () => {
  it('does not read a cross-reference in prose as an identity', () => {
    // Consumption's body says "Component 5b (cash asset transfer) also uses it".
    const set = classifyComponentSet([input('PDD - Consumpton Support', CONSUMPTION)]);
    expect(set.components).toHaveLength(1);
    expect(set.components[0].component_id).toBe('6');
  });

  it('keeps 5b distinct from 5 — the framework calls it a component, not a variant', () => {
    const cash = PRODUCTIVE_ASSET.replace('Component: 5 of', 'Component: 5b of');
    const set = classifyComponentSet([
      input('in-kind', PRODUCTIVE_ASSET),
      input('cash', cash),
    ]);
    expect(set.components.map((c) => c.component_id)).toEqual(['5', '5b']);
    expect(set.findings.some((f) => f.code === 'duplicate-component-id')).toBe(false);
  });

  it('flags two documents claiming the same component id', () => {
    const set = classifyComponentSet([
      input('a', ENROLLMENT),
      input('b', ENROLLMENT),
    ]);
    const dup = set.findings.find((f) => f.code === 'duplicate-component-id');
    expect(dup?.where).toEqual(['a', 'b']);
  });

  it('reports no-components rather than inventing one', () => {
    const set = classifyComponentSet([input('fw', FRAMEWORK), input('t', TARGETING)]);
    expect(set.ok).toBe(false);
    expect(set.findings.some((f) => f.code === 'no-components')).toBe(true);
  });

  it('handles an empty set without throwing', () => {
    const set = classifyComponentSet([]);
    expect(set.ok).toBe(false);
    expect(set.components).toEqual([]);
  });

  it('survives CRLF, which is what Drive actually returns', () => {
    const crlf = ENROLLMENT.replace(/\n/g, '\r\n');
    expect(classifyComponentSet([input('e', crlf)]).components[0].component_id).toBe('4');
  });
});

describe('compareComponentIds', () => {
  it('orders 5 before 5b before 6', () => {
    expect(['6', '5b', '5', '4'].sort(compareComponentIds)).toEqual(['4', '5', '5b', '6']);
  });
});

//
// ace#2056 — the framework's component INVENTORY.
//
// `planLearnModules` consumed `frameworkComponentIds` for three days with no
// producer anywhere in ACE, so the Learn build memo named 3 absent components
// on a programme missing 9. The producer is a DECLARATION read the same way
// every other identity here is read — never a parse of the framework's prose
// component table.
//
// The framework fixture above carries the real trap in its own third line:
// "Components vs models. The components below are a menu."
//

const FRAMEWORK_WITH_INVENTORY = `Poverty Graduation on Connect: Models and Components Framework
Purpose: A map of the components a graduation program is built from · Components: 1, 2, 3, 4, 5, 5b, 6, 7, 8, 9, 10, 11, 12
Components vs models. The components below are a menu.`;

describe('classifyComponentSet — the framework inventory (ace#2056)', () => {
  it('carries the declared inventory verbatim, sorted, with 5b intact', () => {
    const set = classifyComponentSet([
      input('Graduation Framework', FRAMEWORK_WITH_INVENTORY),
      input('PDD - Enrollment', ENROLLMENT),
      input('PDD - Learn', LEARN),
    ]);
    expect(set.frameworkComponentIds).toEqual([
      '1', '2', '3', '4', '5', '5b', '6', '7', '8', '9', '10', '11', '12',
    ]);
  });

  it('raises no inventory finding once it is declared', () => {
    const set = classifyComponentSet([
      input('Graduation Framework', FRAMEWORK_WITH_INVENTORY),
      input('PDD - Enrollment', ENROLLMENT),
    ]);
    expect(set.findings.map((f) => f.code)).not.toContain('inventory-undeclared');
  });

  it('refuses the framework PROSE component table — "Components vs models" is not a declaration', () => {
    const set = classifyComponentSet(REAL_SET);
    expect(set.frameworkComponentIds).toBeUndefined();
  });

  it('reports the undeclared inventory as a finding naming the one line that closes it', () => {
    const set = classifyComponentSet(REAL_SET);
    const finding = set.findings.find((f) => f.code === 'inventory-undeclared');
    expect(finding).toBeDefined();
    expect(finding!.fix).toContain('Components:');
    // The gap the memo cannot fill without it, named in the finding itself.
    expect(finding!.detail).toContain('6(5)');
  });

  it('does NOT block the set — an undeclared inventory is a loud gap, not a failure', () => {
    expect(classifyComponentSet(REAL_SET).ok).toBe(true);
  });

  it('says nothing about an inventory on the single-PDD path', () => {
    // Every opp before poverty-graduation. No framework, nothing to be missing from.
    const set = classifyComponentSet([input('fw', FRAMEWORK), input('t', TARGETING)]);
    expect(set.findings.map((f) => f.code)).not.toContain('inventory-undeclared');
    expect(set.frameworkComponentIds).toBeUndefined();
  });

  it('never reads a singular Component: 4 identity line as an inventory', () => {
    const set = classifyComponentSet([input('PDD - Enrollment', ENROLLMENT)]);
    expect(set.frameworkComponentIds).toBeUndefined();
  });

  it('accepts two documents that declare the SAME inventory', () => {
    const set = classifyComponentSet([
      input('Graduation Framework', FRAMEWORK_WITH_INVENTORY),
      input('Framework (copy)', FRAMEWORK_WITH_INVENTORY),
      input('PDD - Enrollment', ENROLLMENT),
    ]);
    expect(set.frameworkComponentIds).toHaveLength(13);
    expect(set.findings.map((f) => f.code)).not.toContain('inventory-conflict');
  });

  it('carries NO inventory when two documents disagree — a union of two authorities is a guess', () => {
    const other = `Graduation Framework (2025 edition)
Purpose: superseded · Components: 1, 2, 3`;
    const set = classifyComponentSet([
      input('Graduation Framework', FRAMEWORK_WITH_INVENTORY),
      input('Graduation Framework 2025', other),
      input('PDD - Enrollment', ENROLLMENT),
    ]);
    expect(set.frameworkComponentIds).toBeUndefined();
    const finding = set.findings.find((f) => f.code === 'inventory-conflict');
    expect(finding).toBeDefined();
    expect(finding!.where).toEqual(['Graduation Framework', 'Graduation Framework 2025']);
  });

  it('ignores a declaration below the head — a cross-reference deep in prose is not identity', () => {
    const buried = `Poverty Graduation on Connect: Models and Components Framework
Purpose: A map.
Components vs models.
Line four.
Components: 1, 2, 3`;
    const set = classifyComponentSet([
      input('Graduation Framework', buried),
      input('PDD - Enrollment', ENROLLMENT),
    ]);
    expect(set.frameworkComponentIds).toBeUndefined();
  });
});
