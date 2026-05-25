import { describe, it, expect } from 'vitest';
import { lintRecipeText } from '../../../mcp/mobile/recipe-lint.js';

// Static, parse-free lint pass on Maestro recipe YAML text. Catches the
// known-broken structural shapes that produce unhelpful parser errors at
// runtime and have a documented incident class behind them.
//
// Today's only rule:
//   inputText-scalar-with-sibling-option — a list item whose first key
//   is a *scalar* `inputText:` followed by a sibling mapping key
//   (`optional`, `id`, `label`, etc.) under the same `-`. Maestro
//   rejects this with `expected <block end>, but found '<block mapping
//   start>'`. Caught live on leep Phase 5 attempt 8 (2026-05-12).

describe('lintRecipeText — inputText-scalar-with-sibling-option', () => {
  it('flags `- inputText: "x"` with a sibling key on the next line', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- inputText: "Apcolite Stores"',
      '    optional: true',
      '',
    ].join('\n');
    const { ok, violations } = lintRecipeText(yaml);
    expect(ok).toBe(false);
    expect(violations).toHaveLength(1);
    const v = violations[0];
    expect(v.rule).toBe('inputText-scalar-with-sibling-option');
    expect(v.line).toBeGreaterThan(0);
    expect(v.detail).toMatch(/scalar.*sibling|sibling.*scalar/i);
    expect(v.remediation).toMatch(/mapping form|inputText:\s*\n\s*text:/);
  });

  it('flags both single-quoted and double-quoted scalar forms', () => {
    const yamlSingle = [
      'appId: x',
      '---',
      "- inputText: 'hello'",
      '    optional: true',
      '',
    ].join('\n');
    const yamlDouble = [
      'appId: x',
      '---',
      '- inputText: "hello"',
      '    optional: true',
      '',
    ].join('\n');
    expect(lintRecipeText(yamlSingle).ok).toBe(false);
    expect(lintRecipeText(yamlDouble).ok).toBe(false);
  });

  it('passes the canonical mapping form (text under inputText)', () => {
    const yaml = [
      'appId: x',
      '---',
      '- inputText:',
      '    text: "Apcolite Stores"',
      '    optional: true',
      '',
    ].join('\n');
    const r = lintRecipeText(yaml);
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('passes a bare scalar inputText with no sibling key', () => {
    const yaml = [
      'appId: x',
      '---',
      '- inputText: "Apcolite Stores"',
      '- tapOn:',
      '    text: "Next"',
      '',
    ].join('\n');
    const r = lintRecipeText(yaml);
    expect(r.ok).toBe(true);
  });

  it('flags multiple occurrences independently', () => {
    const yaml = [
      'appId: x',
      '---',
      '- inputText: "one"',
      '    optional: true',
      '- tapOn:',
      '    text: "Continue"',
      '- inputText: "two"',
      '    label: "phone"',
      '',
    ].join('\n');
    const r = lintRecipeText(yaml);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0].line).toBeLessThan(r.violations[1].line);
  });

  it('does not flag a `- tapOn:` mapping with sibling — only inputText carries this trap today', () => {
    // tapOn has the same scalar/mapping ambiguity in principle, but
    // historical incidents only trace to inputText. Keep the rule
    // narrowly scoped to the documented class until a tapOn incident
    // surfaces.
    const yaml = [
      'appId: x',
      '---',
      '- tapOn: "Continue"',
      '    optional: true',
      '',
    ].join('\n');
    const r = lintRecipeText(yaml);
    expect(r.ok).toBe(true);
  });

  it('ignores commented-out lines', () => {
    const yaml = [
      'appId: x',
      '---',
      '# - inputText: "stale"',
      '#     optional: true',
      '- launchApp',
      '',
    ].join('\n');
    const r = lintRecipeText(yaml);
    expect(r.ok).toBe(true);
  });
});
