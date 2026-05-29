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

describe('lintRecipeText — unknown-property-textRegex', () => {
  it('flags `textRegex` on extendedWaitUntil', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- extendedWaitUntil:',
      '    visible:',
      '      textRegex: "(Work History|Opportunities)"',
      '    timeout: 60000',
      '',
    ].join('\n');
    const { ok, violations } = lintRecipeText(yaml);
    expect(ok).toBe(false);
    const tr = violations.find((v) => v.rule === 'unknown-property-textRegex');
    expect(tr).toBeDefined();
    expect(tr!.line).toBe(5);
    expect(tr!.detail).toMatch(/Maestro 2\.5\.1|Unknown Property/);
    expect(tr!.remediation).toMatch(/text:|substring|regex-aware/);
  });

  it('flags `textRegex` on any matcher (not just extendedWaitUntil)', () => {
    const yaml = [
      '- tapOn:',
      '    textRegex: "(Submit|Done|Save)"',
      '',
    ].join('\n');
    const { ok, violations } = lintRecipeText(yaml);
    expect(ok).toBe(false);
    expect(violations.filter((v) => v.rule === 'unknown-property-textRegex')).toHaveLength(1);
  });

  it('does NOT flag `text:` (the valid form)', () => {
    const yaml = [
      '- extendedWaitUntil:',
      '    visible:',
      '      text: "Work History"',
      '    timeout: 60000',
      '',
    ].join('\n');
    const r = lintRecipeText(yaml);
    expect(r.ok).toBe(true);
  });

  it('does NOT flag `textRegex` inside a comment', () => {
    const yaml = [
      '# Avoid textRegex: not supported on Maestro 2.5.1.',
      '- extendedWaitUntil:',
      '    visible:',
      '      text: "Work History"',
      '    timeout: 60000',
      '',
    ].join('\n');
    const r = lintRecipeText(yaml);
    expect(r.ok).toBe(true);
  });
});

describe('lintRecipeText — runFlow-guard-scope-mismatch', () => {
  // Bug class root-caused live on connect-claim-opp.yaml (malaria-itn-app
  // run 20260528-1607 Phase 6): a stale prior-run "Resume" tile higher in
  // the list matched an UNSCOPED `when: visible: { id: btn_resume }` guard,
  // the block entered, and the non-optional title-SCOPED
  // `scrollUntilVisible btn_resume below: text: ${OPP_NAME}` hard-failed
  // because this run's target was a New Opportunity (not in In-Progress).
  // The guard scope and the body scope disagreed.

  // This is the EXACT shape the buggy connect-claim-opp.yaml had before
  // the fix — the rule must fail on it.
  const buggyClaimOppBlock = [
    'appId: org.commcare.dalvik',
    '---',
    '- runFlow:',
    '    when:',
    '      visible:',
    '        id: "org.commcare.dalvik:id/btn_resume"',
    '    commands:',
    '      - scrollUntilVisible:',
    '          element:',
    '            id: "org.commcare.dalvik:id/btn_resume"',
    '            below:',
    '              text: ${OPP_NAME}',
    '          direction: DOWN',
    '          timeout: 10000',
    '',
  ].join('\n');

  it('flags an unscoped `when:` guard wrapping a scoped, non-optional scroll body (the original bug)', () => {
    const { ok, violations } = lintRecipeText(buggyClaimOppBlock);
    expect(ok).toBe(false);
    const v = violations.find((x) => x.rule === 'runFlow-guard-scope-mismatch');
    expect(v).toBeDefined();
    expect(v!.line).toBeGreaterThan(0);
    expect(v!.detail).toMatch(/UNSCOPED.*guard.*SCOPED|below/);
    expect(v!.remediation).toMatch(/optional: true|scope the `when:`/);
  });

  it('PASSES once the scoped body step is marked `optional: true` (fix A)', () => {
    const fixed = buggyClaimOppBlock.replace(
      'timeout: 10000',
      'timeout: 10000\n          optional: true',
    );
    const r = lintRecipeText(fixed);
    expect(r.ok).toBe(true);
    expect(r.violations.filter((v) => v.rule === 'runFlow-guard-scope-mismatch')).toHaveLength(0);
  });

  it('PASSES once the `when:` guard is scoped to the same anchor as the body (fix B)', () => {
    const fixed = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    when:',
      '      visible:',
      '        id: "org.commcare.dalvik:id/btn_resume"',
      '        below:',
      '          text: ${OPP_NAME}',
      '    commands:',
      '      - scrollUntilVisible:',
      '          element:',
      '            id: "org.commcare.dalvik:id/btn_resume"',
      '            below:',
      '              text: ${OPP_NAME}',
      '          direction: DOWN',
      '          timeout: 10000',
      '',
    ].join('\n');
    expect(lintRecipeText(fixed).ok).toBe(true);
  });

  it('does NOT flag a runFlow whose body scroll is unscoped (no scope mismatch)', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    when:',
      '      visible:',
      '        id: "org.commcare.dalvik:id/btn_resume"',
      '    commands:',
      '      - scrollUntilVisible:',
      '          element:',
      '            id: "org.commcare.dalvik:id/btn_resume"',
      '          direction: DOWN',
      '          timeout: 10000',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml).ok).toBe(true);
  });

  it('also flags a scoped, non-optional `tapOn` body under an unscoped guard', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    when:',
      '      visible:',
      '        id: "org.commcare.dalvik:id/btn_resume"',
      '    commands:',
      '      - tapOn:',
      '          id: "org.commcare.dalvik:id/btn_resume"',
      '          below:',
      '            text: ${OPP_NAME}',
      '',
    ].join('\n');
    const { ok, violations } = lintRecipeText(yaml);
    expect(ok).toBe(false);
    expect(violations.some((v) => v.rule === 'runFlow-guard-scope-mismatch')).toBe(true);
  });

  it('does NOT flag the live connect-claim-opp.yaml (its pre-branch scrolls are optional, its branch guards are scoped)', () => {
    const { readFileSync } = require('node:fs');
    const { fileURLToPath } = require('node:url');
    const path = fileURLToPath(
      new URL('../../../mcp/mobile/recipes/static/connect-claim-opp.yaml', import.meta.url),
    );
    const yaml = readFileSync(path, 'utf8');
    const r = lintRecipeText(yaml);
    expect(
      r.violations.filter((v) => v.rule === 'runFlow-guard-scope-mismatch'),
      JSON.stringify(r.violations, null, 2),
    ).toHaveLength(0);
  });
});
