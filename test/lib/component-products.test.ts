import { describe, it, expect } from 'vitest';
import { classifyComponentSet } from '../../lib/component-set';
import { assessProgrammeReadiness } from '../../lib/programme-overview';
import {
  buildComponentProducts,
  designModeFor,
  ComponentProductsError,
} from '../../lib/component-products';

const pdd = (id: string, title: string) => ({
  file_id: `file-${id}`,
  name: `PDD - ${title}`,
  text: `Program Design Document (PDD): ${title}\nVersion: 0.1 · Component: ${id} of the graduation component set`,
});

const learn = {
  file_id: 'file-learn',
  name: 'PDD - Learn',
  text: 'Program Design Document (PDD): Learn (Program Training and Certification)\nVersion: 0.4 · Scope: program-level (cross-component)',
};

const framework = {
  file_id: 'file-fw',
  name: 'Graduation Framework',
  text: 'Poverty Graduation on Connect: Models and Components Framework\nPurpose: A map of the components.',
};

// The real poverty-graduation shape.
const SET = classifyComponentSet([
  framework,
  learn,
  pdd('2', 'Household Poverty Targeting Survey'),
  pdd('4', 'Enrollment'),
  pdd('5', 'Productive Asset Transfer (In-Kind)'),
  pdd('6', 'Recurring Consumption Support'),
]);

const BODIES = [
  { component_id: '4', text: 'Inputs from Component 2 and Component 3.' },
  { component_id: '5', text: 'Round two gated on Component 9.' },
  { component_id: '6', text: 'Component 5b also uses it.' },
];

describe('designModeFor', () => {
  it('derives componentized from the documents, not from config', () => {
    expect(designModeFor(SET)).toBe('componentized');
  });

  it('leaves a set with no declared components on the synthesized path', () => {
    expect(designModeFor(classifyComponentSet([framework]))).toBe('synthesized');
  });
});

describe('buildComponentProducts', () => {
  const readiness = assessProgrammeReadiness(SET, BODIES);
  const products = buildComponentProducts(SET, readiness);

  it('hands downstream each component with its OWN pdd file id', () => {
    expect(products.components).toEqual([
      { component_id: '2', title: 'Household Poverty Targeting Survey', pdd_file_id: 'file-2' },
      { component_id: '4', title: 'Enrollment', pdd_file_id: 'file-4' },
      { component_id: '5', title: 'Productive Asset Transfer (In-Kind)', pdd_file_id: 'file-5' },
      { component_id: '6', title: 'Recurring Consumption Support', pdd_file_id: 'file-6' },
    ]);
  });

  it('keeps the program-level PDD addressable rather than folding it into components', () => {
    expect(products.program_level).toEqual([
      { title: 'Learn (Program Training and Certification)', file_id: 'file-learn' },
    ]);
  });

  it('carries the overview obligations, so a later phase can name what is missing', () => {
    const codes = products.overview_obligations.map((o) => o.code);
    expect(codes).toContain('declare-composition');
    expect(codes).toContain('resolve-absent-reference');
  });

  it('carries the unresolved references — 3, 9 and 5b are referenced, not present', () => {
    expect(products.unresolved_references.map((r) => r.to).sort()).toEqual(['3', '5b', '9']);
  });

  it('does not drop the framework into components or program_level', () => {
    const ids = [...products.components.map((c) => c.pdd_file_id), ...products.program_level.map((p) => p.file_id)];
    expect(ids).not.toContain('file-fw');
  });

  it('REFUSES componentized mode with zero components rather than degrading', () => {
    const empty = classifyComponentSet([framework]);
    expect(() => buildComponentProducts(empty, assessProgrammeReadiness(empty, [])))
      .toThrow(ComponentProductsError);
    expect(() => buildComponentProducts(empty, assessProgrammeReadiness(empty, [])))
      .toThrow(/synthesized path/);
  });
});

//
// ace#2056 — the framework inventory travels under ONE name.
//
// The concept had three names and no contract: `frameworkComponentIds` in the
// consumer, a freehand `absent_components` in the run's own YAML (the
// COMPLEMENT, not the inventory), and nothing typed in between. These pin the
// single canonical spelling from classifier to products.
//
const frameworkWithInventory = {
  file_id: 'file-fw',
  name: 'Graduation Framework',
  text:
    'Poverty Graduation on Connect: Models and Components Framework\n' +
    'Purpose: A map of the components · Components: 1, 2, 3, 4, 5, 5b, 6, 7, 8, 9, 10, 11, 12',
};

describe('buildComponentProducts — framework_component_ids (ace#2056)', () => {
  it('carries the declared inventory into products under the canonical name', () => {
    const set = classifyComponentSet([
      frameworkWithInventory,
      learn,
      pdd('2', 'Household Poverty Targeting Survey'),
      pdd('4', 'Enrollment'),
      pdd('5', 'Productive Asset Transfer (In-Kind)'),
      pdd('6', 'Recurring Consumption Support'),
    ]);
    const built = buildComponentProducts(set, assessProgrammeReadiness(set, BODIES));
    expect(built.framework_component_ids).toEqual([
      '1', '2', '3', '4', '5', '5b', '6', '7', '8', '9', '10', '11', '12',
    ]);
  });

  it('OMITS the key entirely when nothing declares an inventory', () => {
    // Not `[]` — an empty array reads as "the framework has no components",
    // which `planLearnModules` would treat as "nothing was skipped". Absent is
    // what makes its inventory-unavailable degrade fire.
    const built = buildComponentProducts(SET, assessProgrammeReadiness(SET, BODIES));
    expect('framework_component_ids' in built).toBe(false);
  });
});
