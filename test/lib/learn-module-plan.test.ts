import { describe, it, expect } from 'vitest';
import { planLearnModules, type PlannedComponent } from '../../lib/learn-module-plan';

// The real poverty-graduation set: four components with PDDs.
const COMPONENTS: PlannedComponent[] = [
  { component_id: '2', title: 'Household Poverty Targeting Survey', pdd_file_id: 'f2' },
  { component_id: '4', title: 'Enrollment', pdd_file_id: 'f4' },
  { component_id: '5', title: 'Productive Asset Transfer (In-Kind)', pdd_file_id: 'f5' },
  { component_id: '6', title: 'Recurring Consumption Support', pdd_file_id: 'f6' },
];

// The framework's real inventory: 1-12 plus 5b.
const FRAMEWORK = ['1', '2', '3', '4', '5', '5b', '6', '7', '8', '9', '10', '11', '12'];

// From products.unresolved_references on the real set.
const REFERENCED_ABSENT = ['3', '9', '5b'];

describe('planLearnModules — the first programme', () => {
  const plan = planLearnModules({
    components: COMPONENTS,
    frameworkComponentIds: FRAMEWORK,
    referencedAbsentIds: REFERENCED_ABSENT,
  });

  it('always builds foundations', () => {
    expect(plan.foundations).toBe(true);
  });

  it('builds one module per component WITH a PDD, and no others', () => {
    expect(plan.modules.map((m) => m.component_id)).toEqual(['2', '4', '5', '6']);
    expect(plan.modules.every((m) => m.built)).toBe(true);
  });

  it('shows all of them by default — every component with a PDD is on', () => {
    expect(plan.modules.every((m) => m.shown)).toBe(true);
  });

  it('names every framework component skipped for having no PDD (Learn PDD 6.5)', () => {
    const gap = plan.gaps.find((g) => g.code === 'framework-component-without-pdd');
    expect(gap?.components).toEqual(['1', '3', '5b', '7', '8', '9', '10', '11', '12']);
    expect(plan.buildMemoNotes.join(' ')).toMatch(/9 of 13 framework components/);
  });

  it('scopes the question bank to foundations plus the active components', () => {
    expect(plan.questionBankScope).toEqual({ foundations: true, components: ['2', '4', '5', '6'] });
  });
});

describe('planLearnModules — built is NOT shown', () => {
  it('keeps a built module that this model turns off, and hides it', () => {
    const plan = planLearnModules({
      components: COMPONENTS,
      activeComponentIds: ['2', '4'],
      frameworkComponentIds: FRAMEWORK,
    });
    expect(plan.modules.map((m) => m.component_id)).toEqual(['2', '4', '5', '6']); // all BUILT
    expect(plan.modules.filter((m) => m.shown).map((m) => m.component_id)).toEqual(['2', '4']);
  });

  it('excludes hidden modules from the question bank — tested on what they deliver', () => {
    const plan = planLearnModules({ components: COMPONENTS, activeComponentIds: ['2', '4'] });
    expect(plan.questionBankScope.components).toEqual(['2', '4']);
  });

  it('records the built-but-hidden set in the build memo', () => {
    const plan = planLearnModules({ components: COMPONENTS, activeComponentIds: ['2'] });
    expect(plan.buildMemoNotes.join(' ')).toMatch(/Built but hidden for this model: 4, 5, 6/);
  });

  it('ignores a model activating a component that was never built', () => {
    const plan = planLearnModules({ components: COMPONENTS, activeComponentIds: ['2', '99'] });
    expect(plan.questionBankScope.components).toEqual(['2']);
    expect(plan.modules.some((m) => m.component_id === '99')).toBe(false);
  });
});

describe('planLearnModules — degrading loudly without the inventory', () => {
  const plan = planLearnModules({
    components: COMPONENTS,
    referencedAbsentIds: REFERENCED_ABSENT,
  });

  it('does NOT report "no gaps" when it simply cannot enumerate them', () => {
    expect(plan.gaps.some((g) => g.code === 'inventory-unavailable')).toBe(true);
    expect(plan.buildMemoNotes.join(' ')).toMatch(/not exhaustive/);
  });

  it('still names the absent components it has evidence for', () => {
    const gap = plan.gaps.find((g) => g.code === 'referenced-component-absent');
    expect(gap?.components).toEqual(['3', '5b', '9']);
  });

  it('raises no absent-reference gap when every reference resolves', () => {
    const p = planLearnModules({ components: COMPONENTS, referencedAbsentIds: ['2', '4'] });
    expect(p.gaps.some((g) => g.code === 'referenced-component-absent')).toBe(false);
  });
});

describe('planLearnModules — ordering and edges', () => {
  it('orders modules numerically, keeping 5b between 5 and 6', () => {
    const plan = planLearnModules({
      components: [
        { component_id: '6', title: 'six', pdd_file_id: 'a' },
        { component_id: '5b', title: 'five-b', pdd_file_id: 'b' },
        { component_id: '5', title: 'five', pdd_file_id: 'c' },
      ],
    });
    expect(plan.modules.map((m) => m.component_id)).toEqual(['5', '5b', '6']);
  });

  it('handles a programme with a single component', () => {
    const plan = planLearnModules({ components: [COMPONENTS[0]], frameworkComponentIds: ['2'] });
    expect(plan.modules).toHaveLength(1);
    expect(plan.gaps.some((g) => g.code === 'framework-component-without-pdd')).toBe(false);
  });
});
