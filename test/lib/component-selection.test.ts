import { describe, it, expect } from 'vitest';
import { resolveSelection } from '../../lib/component-selection';

const AVAILABLE = ['2', '4', '5', '6']; // the real poverty-graduation library

describe('resolveSelection — the first programme', () => {
  const r = resolveSelection({ availableIds: AVAILABLE });

  it('turns on every component with a PDD', () => {
    expect(r.activeIds).toEqual(['2', '4', '5', '6']);
    expect(r.inactiveIds).toEqual([]);
  });

  it('records that this was the DEFAULT, not a declaration', () => {
    expect(r.defaulted).toBe(true);
    expect(r.findings.map((f) => f.code)).toEqual(['no-selection-declared']);
  });

  it('says the default is intentional rather than missing', () => {
    expect(r.findings[0].fix).toMatch(/intentional, not missing/);
  });
});

describe('resolveSelection — a second programme with a different mix', () => {
  const r = resolveSelection({ availableIds: AVAILABLE, declaredIds: ['2', '4'] });

  it('turns on only what it declares', () => {
    expect(r.activeIds).toEqual(['2', '4']);
  });

  it('reports the rest as inactive — available, built, gated off', () => {
    expect(r.inactiveIds).toEqual(['5', '6']);
  });

  it('is not defaulted, which is what distinguishes it from the first programme', () => {
    expect(r.defaulted).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it('an explicit selection of everything is NOT the same as no selection', () => {
    const explicit = resolveSelection({ availableIds: AVAILABLE, declaredIds: AVAILABLE });
    const implicit = resolveSelection({ availableIds: AVAILABLE });
    expect(explicit.activeIds).toEqual(implicit.activeIds);
    expect(explicit.defaulted).toBe(false);
    expect(implicit.defaulted).toBe(true);
  });
});

describe('resolveSelection — loud about what it cannot build', () => {
  it('flags a component the library does not carry rather than dropping it', () => {
    const r = resolveSelection({ availableIds: AVAILABLE, declaredIds: ['2', '7'] });
    const f = r.findings.find((x) => x.code === 'selects-unavailable-component');
    expect(f?.components).toEqual(['7']);
    expect(r.activeIds).toEqual(['2']);
  });

  it('flags a selection that turns nothing on', () => {
    const r = resolveSelection({ availableIds: AVAILABLE, declaredIds: ['99'] });
    expect(r.findings.map((f) => f.code)).toContain('selects-nothing');
    expect(r.activeIds).toEqual([]);
  });

  it('treats an empty declaration as no declaration, not as selecting nothing', () => {
    expect(resolveSelection({ availableIds: AVAILABLE, declaredIds: [] }).defaulted).toBe(true);
  });

  it('de-duplicates a repeated id', () => {
    const r = resolveSelection({ availableIds: AVAILABLE, declaredIds: ['4', '4', '2'] });
    expect(r.activeIds).toEqual(['2', '4']);
  });
});
