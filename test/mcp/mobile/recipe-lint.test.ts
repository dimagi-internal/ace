import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { lintRecipeText } from '../../../mcp/mobile/recipe-lint.js';
import { loadSelectorTypes } from '../../../mcp/mobile/recipe-resolver.js';

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

describe('lintRecipeText — pre-submit-screenshot-name-claims-outcome (ace#1853)', () => {
  // `SCREENSHOT_NAME_PRE_SUBMIT` is shot on the LAST QUESTION, before the tap
  // that advances, so a name claiming it shows a result is always false — and
  // false in the direction that misleads, because anything reading the
  // manifest by name captions it as the certification screen.
  //
  // Observed as a real frame name on two independent runs:
  //   spark-facilitator/20260828-0703 `journey-learn-m6-assessment-result`
  //   hh-poverty-targeting/20260828-0702 `journey-learn-gate-result`, which
  //   the run manifest files between `…-gate-q9-answered` and
  //   `…-gate-submitted` — i.e. squarely the PRE_SUBMIT frame.

  const head = ['appId: org.commcare.dalvik', '---'];
  const call = (name: string) =>
    [
      ...head,
      '- runFlow:',
      '    file: form-submit.yaml',
      '    env:',
      `      SCREENSHOT_NAME_PRE_SUBMIT: "${name}"`,
      '      SCREENSHOT_NAME_POST_SUBMIT: "journey-learn-gate-submitted"',
      '',
    ].join('\n');

  it('flags the real hh-poverty-targeting name', () => {
    const { ok, violations } = lintRecipeText(call('journey-learn-gate-result'));
    expect(ok).toBe(false);
    const v = violations.find((x) => x.rule === 'pre-submit-screenshot-name-claims-outcome');
    expect(v).toBeDefined();
    expect(v!.detail).toContain('LAST QUESTION');
    expect(v!.line).toBe(3);
  });

  it('flags the real spark-facilitator name and suggests a truthful one', () => {
    const { violations } = lintRecipeText(call('journey-learn-m6-assessment-result'));
    const v = violations.find((x) => x.rule === 'pre-submit-screenshot-name-claims-outcome');
    expect(v).toBeDefined();
    expect(v!.remediation).toContain('journey-learn-m6-assessment-last-item');
  });

  it('names the collision with the honest frame the FINISH branch now captures', () => {
    const { violations } = lintRecipeText(call('journey-learn-gate-result'));
    const v = violations.find((x) => x.rule === 'pre-submit-screenshot-name-claims-outcome')!;
    expect(v.detail).toContain('journey-learn-gate-result-result');
  });

  it.each(['score', 'passed', 'failed', 'certified', 'outcome', 'grade', 'results'])(
    'flags the outcome-claiming segment %s',
    (word) => {
      const { violations } = lintRecipeText(call(`journey-learn-gate-${word}`));
      expect(violations.some((v) => v.rule === 'pre-submit-screenshot-name-claims-outcome')).toBe(
        true,
      );
    },
  );

  it('accepts a truthful pre-submit name', () => {
    const { violations } = lintRecipeText(call('journey-learn-gate-last-item'));
    expect(violations.some((v) => v.rule === 'pre-submit-screenshot-name-claims-outcome')).toBe(
      false,
    );
  });

  it('matches whole segments only — `resulting` is not a claim of a result', () => {
    const { violations } = lintRecipeText(call('journey-learn-gate-resulting-action'));
    expect(violations.some((v) => v.rule === 'pre-submit-screenshot-name-claims-outcome')).toBe(
      false,
    );
  });

  it('leaves POST_SUBMIT alone — that frame legitimately follows the outcome', () => {
    const yaml = [
      ...head,
      '- runFlow:',
      '    file: form-submit.yaml',
      '    env:',
      '      SCREENSHOT_NAME_PRE_SUBMIT: "journey-learn-gate-last-item"',
      '      SCREENSHOT_NAME_POST_SUBMIT: "journey-learn-gate-result"',
      '',
    ].join('\n');
    expect(
      lintRecipeText(yaml).violations.some(
        (v) => v.rule === 'pre-submit-screenshot-name-claims-outcome',
      ),
    ).toBe(false);
  });

  it('does not fire on a different palette that happens to use the word', () => {
    const yaml = [
      ...head,
      '- runFlow:',
      '    file: form-advance.yaml',
      '    env:',
      '      SCREENSHOT_NAME: "journey-learn-gate-result"',
      '',
    ].join('\n');
    expect(
      lintRecipeText(yaml).violations.some(
        (v) => v.rule === 'pre-submit-screenshot-name-claims-outcome',
      ),
    ).toBe(false);
  });
});

describe('lintRecipeText — runFlow-unbound-screenshot-name', () => {
  // dimagi-internal/ace#1033. A palette subflow that names its screenshot
  // from `${SCREENSHOT_NAME*}` carries NO env default (a subflow `env:` block
  // OVERRIDES caller-passed `runFlow: env:` in Maestro 2.5.1, so a default
  // there silently defeats per-journey naming). The caller is the only source
  // of the name, so an unbound call site must fail at authoring time instead
  // of writing a literal `undefined.png` mid-run.

  const head = ['appId: org.commcare.dalvik', '---'];

  it('flags a bare `runFlow: { file: form-advance.yaml }` with no env block', () => {
    const yaml = [...head, '- runFlow:', '    file: form-advance.yaml', ''].join('\n');
    const { ok, violations } = lintRecipeText(yaml);
    expect(ok).toBe(false);
    const v = violations.find((x) => x.rule === 'runFlow-unbound-screenshot-name');
    expect(v).toBeDefined();
    expect(v!.detail).toContain('SCREENSHOT_NAME');
    expect(v!.detail).toContain('form-advance.yaml');
    expect(v!.line).toBe(3);
  });

  it('flags the scalar shorthand, which cannot carry env at all', () => {
    const yaml = [...head, '- runFlow: content-form-finish.yaml', ''].join('\n');
    const { ok, violations } = lintRecipeText(yaml);
    expect(ok).toBe(false);
    expect(violations.some((v) => v.rule === 'runFlow-unbound-screenshot-name')).toBe(true);
  });

  it('flags a PARTIALLY bound form-submit call (pre bound, post missing)', () => {
    // The original #852 symptom: two takeScreenshot steps resolving to the
    // same unset name, so post-submit silently overwrites pre-submit.
    const yaml = [
      ...head,
      '- runFlow:',
      '    file: form-submit.yaml',
      '    env:',
      '      SCREENSHOT_NAME_PRE_SUBMIT: "journey-learn-result"',
      '',
    ].join('\n');
    const { ok, violations } = lintRecipeText(yaml);
    expect(ok).toBe(false);
    const v = violations.find((x) => x.rule === 'runFlow-unbound-screenshot-name');
    expect(v!.detail).toContain('SCREENSHOT_NAME_POST_SUBMIT');
    expect(v!.detail).not.toContain('`SCREENSHOT_NAME_PRE_SUBMIT`');
  });

  it('does NOT flag a fully bound call site', () => {
    // The PRE_SUBMIT name here was `journey-learn-result` until ace#1853.
    // That is the misleading-name class this suite now also lints for — a
    // pre-submit frame is the LAST QUESTION, never a result — and this fixture
    // was a third instance of it, alongside the two live runs, sitting inside
    // ACE's own tests. Renamed to a truthful one; the assertion is scoped to
    // the rule under test so it keeps testing bindedness rather than doubling
    // as an accidental gate on every other rule.
    const yaml = [
      ...head,
      '- runFlow:',
      '    file: form-submit.yaml',
      '    env:',
      '      SCREENSHOT_NAME_PRE_SUBMIT: "journey-learn-last-item"',
      '      SCREENSHOT_NAME_POST_SUBMIT: "journey-learn-submitted"',
      '- runFlow:',
      '    file: ./form-advance.yaml',
      '    env:',
      '      SCREENSHOT_NAME: "journey-learn-q1-answered"',
      '',
    ].join('\n');
    expect(
      lintRecipeText(yaml).violations.some((v) => v.rule === 'runFlow-unbound-screenshot-name'),
    ).toBe(false);
    expect(lintRecipeText(yaml).ok).toBe(true);
  });

  it('flags an unbound call site nested inside a guarded runFlow body', () => {
    const yaml = [
      ...head,
      '- runFlow:',
      '    when:',
      '      visible:',
      '        id: "org.commcare.dalvik:id/nav_btn_next"',
      '    commands:',
      '      - runFlow:',
      '          file: form-advance.yaml',
      '',
    ].join('\n');
    expect(
      lintRecipeText(yaml).violations.some(
        (v) => v.rule === 'runFlow-unbound-screenshot-name',
      ),
    ).toBe(true);
  });

  it('ignores palettes that do not name a screenshot from env', () => {
    const yaml = [
      ...head,
      '- runFlow:',
      '    file: learn-suite-reentry.yaml',
      '- runFlow:',
      '    file: deliver-sync.yaml',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml).ok).toBe(true);
  });
});

describe('rule: repeat-palette-invocation-without-discriminator (ace#1651)', () => {
  // `deliver-form-walk.yaml` names three captures from FIXED strings plus
  // `${WALK_LABEL}`. Invoking it twice in one recipe without a DISTINCT
  // discriminator makes the second invocation overwrite the first's
  // screenshots — silently, on a passing run. Measured on
  // bednet-check-2-visit/20260825-1310: leg A's registration frames were gone,
  // and the only survivors were the two whose names already interpolated
  // `${MODULE_NAME}`.

  const RULE = 'repeat-palette-invocation-without-discriminator';

  function twoLegs(envA: string[], envB: string[]): string {
    return [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: deliver-form-walk.yaml',
      '    env:',
      ...envA.map((l) => `      ${l}`),
      '- runFlow:',
      '    file: deliver-form-walk.yaml',
      '    env:',
      ...envB.map((l) => `      ${l}`),
      '',
    ].join('\n');
  }

  it('does not fire on a SINGLE invocation — this rule is about REPEATS', () => {
    // Scoping check for THIS rule only. A single unbound invocation is still
    // a defect, just a different one: ace#1668 showed it writes the literal
    // `undefined` into every frame name, and `runFlow-unbound-screenshot-name`
    // is the rule that catches it (asserted immediately below).
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: deliver-form-walk.yaml',
      '    env:',
      '      MODULE_NAME: "Register household"',
      '',
    ].join('\n');
    const result = lintRecipeText(yaml);
    expect(result.violations.filter((v) => v.rule === RULE)).toEqual([]);
  });

  it('a single unbound invocation IS caught — by runFlow-unbound-screenshot-name (ace#1668)', () => {
    // #1651 declared WALK_LABEL optional on the premise that an unbound one
    // substitutes to the empty string. It does not — Maestro renders it as
    // the literal `undefined`, and hh-poverty-targeting/20260824-1404 shipped
    // `deliver-form-walk-form-listundefined.png` +3 as a result. A subflow
    // `env:` default is not the fix either (it would clobber both legs,
    // ace#1033), so the binding is REQUIRED at every call site.
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: deliver-form-walk.yaml',
      '    env:',
      '      MODULE_NAME: "Register household"',
      '',
    ].join('\n');
    const hits = lintRecipeText(yaml).violations.filter(
      (v) => v.rule === 'runFlow-unbound-screenshot-name',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain('WALK_LABEL');
    expect(lintRecipeText(yaml).ok).toBe(false);
  });

  it('accepts a single invocation that binds one slug', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: deliver-form-walk.yaml',
      '    env:',
      '      MODULE_NAME: "Register household"',
      '      WALK_LABEL: "-deliver"',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml).ok).toBe(true);
  });

  it('flags a second invocation that binds no WALK_LABEL', () => {
    const result = lintRecipeText(
      twoLegs(['MODULE_NAME: "Register household"'], ['MODULE_NAME: "Follow-up spot-check"']),
    );
    const hits = result.violations.filter((v) => v.rule === RULE);
    expect(hits).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(hits[0].detail).toContain('deliver-form-walk.yaml');
    expect(hits[0].detail).toContain('invocation #2');
    expect(hits[0].remediation).toContain('WALK_LABEL');
  });

  it('flags two invocations that bind the SAME WALK_LABEL', () => {
    const result = lintRecipeText(
      twoLegs(
        ['MODULE_NAME: "Register household"', 'WALK_LABEL: "-walk"'],
        ['MODULE_NAME: "Follow-up spot-check"', 'WALK_LABEL: "-walk"'],
      ),
    );
    const hits = result.violations.filter((v) => v.rule === RULE);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain('the same value');
  });

  it('passes two invocations with DISTINCT WALK_LABELs — the fixed shape', () => {
    const result = lintRecipeText(
      twoLegs(
        ['MODULE_NAME: "Register household"', 'WALK_LABEL: "-register"'],
        ['MODULE_NAME: "Follow-up spot-check"', 'WALK_LABEL: "-followup"'],
      ),
    );
    expect(result.violations.filter((v) => v.rule === RULE)).toEqual([]);
  });

  it('reports the SECOND call site, not the first (that is the one that overwrites)', () => {
    const yaml = twoLegs(['MODULE_NAME: "A"'], ['MODULE_NAME: "B"']);
    const hit = lintRecipeText(yaml).violations.find((v) => v.rule === RULE)!;
    const firstCallLine = yaml.split('\n').findIndex((l) => l.includes('- runFlow:')) + 1;
    expect(hit.line).toBeGreaterThan(firstCallLine);
  });

  it('does not fire for palettes outside the discriminator registry', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: deliver-sync.yaml',
      '- runFlow:',
      '    file: deliver-sync.yaml',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml).violations.filter((v) => v.rule === RULE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1690 — `${SELECTOR:...}` PLACEMENT rules.
//
// Both defects below shipped to a device on spark-facilitator/20260820-0817
// Phase 6 with `lintRecipeText` returning `ok: true`. They are pure static
// checks over the recipe text (plus, for the type rule, the active selector
// map) — the ground truth is the resolver's own substitution contract and
// YAML's grammar, not a device.
// ---------------------------------------------------------------------------

describe('lintRecipeText — selector-inline-key-position (ace#1690)', () => {
  const RULE = 'selector-inline-key-position';

  it('flags a bare ${SELECTOR:...} used INLINE after a step key', () => {
    // Resolves to `- tapOn: text: "RECORD LOCATION"`, which Maestro rejects
    // with `mapping values are not allowed here`. This case FAILS against
    // the pre-#1690 linter (it returned ok: true).
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn: ${SELECTOR:geopoint-record-location}',
      '',
    ].join('\n');
    const { ok, violations } = lintRecipeText(yaml);
    expect(ok).toBe(false);
    const hits = violations.filter((v) => v.rule === RULE);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].detail).toMatch(/INLINE/);
    expect(hits[0].remediation).toMatch(/own line/i);
  });

  it('NEGATIVE CONTROL — a bare ${SELECTOR:...} alone on its own line is valid', () => {
    // The canonical key-position form, used by every static palette
    // (e.g. form-advance.yaml:67). Must never be flagged.
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    ${SELECTOR:form-nav-next}',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml).violations.filter((v) => v.rule === RULE)).toEqual([]);
  });

  it('NEGATIVE CONTROL — a value-position "${SELECTOR:...}" inline is valid', () => {
    // Quoted, so the `:` lives inside a string: raw-YAML-valid even beside
    // sibling matcher keys. This is the form jjackson/ace#650 introduced.
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    id: "${SELECTOR:opp-list-resume-button}"',
      '    below:',
      '      text: ${OPP_NAME}',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml).violations.filter((v) => v.rule === RULE)).toEqual([]);
  });

  it('NEGATIVE CONTROL — placeholders inside comments are prose, not code', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '# Anchored via ${SELECTOR:deliver-suite-menu} and',
      '#   ${SELECTOR:deliver-home-job-card}.',
      '- tapOn:',
      '    ${SELECTOR:deliver-suite-menu}    # display-mode-agnostic',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml).violations.filter((v) => v.rule === RULE)).toEqual([]);
  });

  it('flags an inline bare placeholder under a matcher key too', () => {
    // `text: ${SELECTOR:x}` resolves to `text: text: "..."` — same defect.
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- assertVisible:',
      '    text: ${SELECTOR:form-nav-next}',
      '',
    ].join('\n');
    const hits = lintRecipeText(yaml).violations.filter((v) => v.rule === RULE);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(4);
  });
});

describe('lintRecipeText — selector-value-position-type-mismatch (ace#1690)', () => {
  const RULE = 'selector-value-position-type-mismatch';
  // Mirrors connect-2.63.2.yaml: camera-take-photo is `type: text`.
  const selectorTypes = {
    'camera-take-photo': 'text',
    'form-nav-next': 'id',
  } as const;

  it('flags a value-position selector written under the WRONG matcher key', () => {
    // Resolves to `id: "TAKE PICTURE"` — valid YAML, permanently unmatchable.
    // FAILS against the pre-#1690 linter (it returned ok: true).
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    id: "${SELECTOR:camera-take-photo}"',
      '',
    ].join('\n');
    const { ok, violations } = lintRecipeText(yaml, { selectorTypes });
    expect(ok).toBe(false);
    const hits = violations.filter((v) => v.rule === RULE);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(4);
    expect(hits[0].detail).toMatch(/type: text/);
    expect(hits[0].remediation).toMatch(/text: "\$\{SELECTOR:camera-take-photo\}"/);
  });

  it('NEGATIVE CONTROL — the SAME line under the key the map declares is valid', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    text: "${SELECTOR:camera-take-photo}"',
      '- tapOn:',
      '    id: "${SELECTOR:form-nav-next}"',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml, { selectorTypes }).violations.filter((v) => v.rule === RULE)).toEqual([]);
  });

  it('abstains entirely when no selector map is injected', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    id: "${SELECTOR:camera-take-photo}"',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml).violations.filter((v) => v.rule === RULE)).toEqual([]);
  });

  it('abstains on a name the map does not know — that is the resolver report', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    id: "${SELECTOR:does-not-exist}"',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml, { selectorTypes }).violations.filter((v) => v.rule === RULE)).toEqual([]);
  });

  it('abstains under keys the selector map has no opinion about', () => {
    const yaml = [
      'appId: org.commcare.dalvik',
      '---',
      '- tapOn:',
      '    text: "Submit"',
      '    childOf: "${SELECTOR:camera-take-photo}"',
      '',
    ].join('\n');
    expect(lintRecipeText(yaml, { selectorTypes }).violations.filter((v) => v.rule === RULE)).toEqual([]);
  });
});

describe('lintRecipeText — ace#1690 rules do not fire on the shipped palette', () => {
  it('every static recipe lints clean under BOTH new rules', () => {
    // The false-positive guard. A new detection that rejects a recipe which
    // is actually fine would halt a future Phase 6 on a good walk — strictly
    // worse than the defect being fixed.
    const NEW = new Set(['selector-inline-key-position', 'selector-value-position-type-mismatch']);
    const dir = new URL('../../../mcp/mobile/recipes/static/', import.meta.url);
    const selectorTypes = loadSelectorTypes('2.63.2');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const body = readFileSync(new URL(f, dir), 'utf8');
      for (const v of lintRecipeText(body, { selectorTypes }).violations) {
        if (NEW.has(v.rule)) offenders.push(`${f}:${v.line} [${v.rule}]`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
