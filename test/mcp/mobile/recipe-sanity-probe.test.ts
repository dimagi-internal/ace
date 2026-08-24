import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  probeRecipeSanity,
  extractRecipeParameters,
  type NovaAppSlice,
  type ConnectOpportunitySlice,
} from '../../../mcp/mobile/recipe-sanity-probe.js';

// --- Fixture helpers ---

function recipe(name: string, env: Record<string, string>): { name: string; text: string } {
  const envBlock = Object.entries(env)
    .map(([k, v]) => `  ${k}: "${v}"`)
    .join('\n');
  const text =
    `appId: org.commcare.dalvik\n` +
    (envBlock ? `env:\n${envBlock}\n` : '') +
    `---\n- launchApp\n`;
  return { name, text };
}

function novaApp(app_id: string, mods: Record<string, string[]>): NovaAppSlice {
  return {
    app_id,
    modules: Object.entries(mods).map(([module_name, forms]) => ({
      module_name,
      forms: forms.map((form_name) => ({ form_name })),
    })),
  };
}

const HEALTHY_LEARN_APP: NovaAppSlice = novaApp('app-learn-123', {
  'Health Education': ['Introduction', 'Module Quiz'],
});

const HEALTHY_DELIVER_APP: NovaAppSlice = novaApp('app-deliver-456', {
  'Home Visits': ['Register Visit', 'Follow-up'],
});

const LIVE_OPP: ConnectOpportunitySlice = {
  display_name: 'Maternal Health 2026',
};

describe('extractRecipeParameters', () => {
  it('reads MODULE_NAME and FORM_NAME from env block', () => {
    const r = recipe('J1a.yaml', {
      MODULE_NAME: 'Health Education',
      FORM_NAME: 'Module Quiz',
    });
    const params = extractRecipeParameters(r);
    expect(params.moduleNames.has('Health Education')).toBe(true);
    expect(params.formNames.has('Module Quiz')).toBe(true);
  });

  it('handles a recipe with no env block', () => {
    const r = { name: 'noop.yaml', text: 'appId: x\n---\n- launchApp\n' };
    const params = extractRecipeParameters(r);
    expect(params.moduleNames.size).toBe(0);
    expect(params.formNames.size).toBe(0);
  });

  it('returns empty sets on YAML parse error (doesn`t throw)', () => {
    const r = { name: 'broken.yaml', text: '\tnot: [valid yaml here' };
    const params = extractRecipeParameters(r);
    expect(params.moduleNames.size).toBe(0);
    expect(params.formNames.size).toBe(0);
  });

  // --- ace#1068: nested runFlow.env is the shape Phase 3 emits ---

  it('reads MODULE_NAME/FORM_NAME from a NESTED runFlow.env block', () => {
    // The shape Phase 3 actually emits. Reading only the top-level env
    // returned EMPTY sets, so expected-module-not-in-app and
    // expected-form-not-in-module could never fire (ace#1068).
    const r = {
      name: 'journey-learn.yaml',
      text: [
        'appId: org.commcare.dalvik',
        '---',
        '- runFlow:',
        '    file: learn-tap-module.yaml',
        '    env:',
        '      MODULE_NAME: "Connect Basics"',
        '      FORM_NAME: "Connect Basics Quiz"',
        '',
      ].join('\n'),
    };
    const params = extractRecipeParameters(r);
    expect([...params.moduleNames]).toEqual(['Connect Basics']);
    expect([...params.formNames]).toEqual(['Connect Basics Quiz']);
  });

  it('reads env maps nested several levels deep (runFlow inside runFlow.commands)', () => {
    const r = {
      name: 'journey-learn.yaml',
      text: [
        'appId: org.commcare.dalvik',
        '---',
        '- runFlow:',
        '    when:',
        '      visible:',
        '        text: "Continue Learning"',
        '    commands:',
        '      - runFlow:',
        '          file: learn-tap-module.yaml',
        '          env:',
        '            MODULE_NAME: "Deep Module"',
        '            FORM_NAME: "Deep Form"',
        '',
      ].join('\n'),
    };
    const params = extractRecipeParameters(r);
    expect(params.moduleNames.has('Deep Module')).toBe(true);
    expect(params.formNames.has('Deep Form')).toBe(true);
  });

  it('collects module/form names from BOTH top-level env and nested runFlow.env', () => {
    const r = {
      name: 'journey-learn.yaml',
      text: [
        'appId: org.commcare.dalvik',
        'env:',
        '  MODULE_NAME: "Top Module"',
        '---',
        '- runFlow:',
        '    file: learn-tap-module.yaml',
        '    env:',
        '      MODULE_NAME: "Nested Module"',
        '',
      ].join('\n'),
    };
    const params = extractRecipeParameters(r);
    expect([...params.moduleNames].sort()).toEqual(['Nested Module', 'Top Module']);
  });

  it('ignores unresolved ${...} placeholder bindings', () => {
    // A template passing its own env through must not read as a live
    // module name — that would make expected-module-not-in-app fire on
    // every composed palette step.
    const r = {
      name: 'journey-learn.yaml',
      text: [
        'appId: org.commcare.dalvik',
        '---',
        '- runFlow:',
        '    file: learn-tap-module.yaml',
        '    env:',
        '      MODULE_NAME: "${MODULE_NAME}"',
        '      FORM_NAME: "${FORM_NAME}"',
        '',
      ].join('\n'),
    };
    const params = extractRecipeParameters(r);
    expect(params.moduleNames.size).toBe(0);
    expect(params.formNames.size).toBe(0);
  });
});

describe('probeRecipeSanity — healthy inputs pass', () => {
  it('passes when every recipe parameter resolves to a live app structure', () => {
    const verdict = probeRecipeSanity({
      recipes: [
        recipe('J1a.yaml', { MODULE_NAME: 'Health Education', FORM_NAME: 'Module Quiz' }),
        recipe('J1b.yaml', { MODULE_NAME: 'Home Visits', FORM_NAME: 'Register Visit' }),
      ],
      novaApps: [HEALTHY_LEARN_APP, HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
      recipeOppName: LIVE_OPP.display_name,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toHaveLength(0);
    expect(verdict.observed.recipe_module_names).toEqual(['Health Education', 'Home Visits']);
    expect(verdict.observed.live_opp_name).toBe(LIVE_OPP.display_name);
  });
});

describe('probeRecipeSanity — failure class: module-name-equals-form-name', () => {
  it('flags recipes where MODULE_NAME and FORM_NAME are the same string', () => {
    // Real-world case from PR #331: app authored with a module that has
    // a single form whose name matches the module name verbatim.
    const collisionApp = novaApp('app-x', { 'Daily Visit': ['Daily Visit'] });
    const verdict = probeRecipeSanity({
      recipes: [recipe('J1a.yaml', { MODULE_NAME: 'Daily Visit', FORM_NAME: 'Daily Visit' })],
      novaApps: [collisionApp],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.ok).toBe(false);
    const f = verdict.failures.find((x) => x.class === 'module-name-equals-form-name');
    expect(f).toBeDefined();
    expect(f!.recipe).toBe('J1a.yaml');
    expect(f!.value).toBe('Daily Visit');
    expect(f!.remediation).toMatch(/0\.13\.255/);
  });
});

describe('probeRecipeSanity — failure class: expected-module-not-in-app', () => {
  it('flags recipes that reference modules absent from every provided Nova app', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipe('J1a.yaml', { MODULE_NAME: 'GhostModule', FORM_NAME: 'Module Quiz' })],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'expected-module-not-in-app');
    expect(f).toBeDefined();
    expect(f!.value).toBe('GhostModule');
    expect(f!.remediation).toMatch(/app-test-cases/);
  });
});

describe('probeRecipeSanity — failure class: expected-form-not-in-module', () => {
  it('flags recipes where the FORM_NAME exists in some other module but not the named one', () => {
    const verdict = probeRecipeSanity({
      recipes: [
        recipe('J1a.yaml', { MODULE_NAME: 'Health Education', FORM_NAME: 'Register Visit' }),
      ],
      novaApps: [HEALTHY_LEARN_APP, HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'expected-form-not-in-module');
    expect(f).toBeDefined();
    expect(f!.value).toBe('Register Visit');
  });
});

describe('probeRecipeSanity — failure class: opp-name-mismatch', () => {
  it('flags when recipe-authored OPP_NAME differs from live Connect display_name', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipe('J1a.yaml', { MODULE_NAME: 'Health Education', FORM_NAME: 'Module Quiz' })],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
      recipeOppName: 'Maternal Health 2025', // stale year
    });
    const f = verdict.failures.find((x) => x.class === 'opp-name-mismatch');
    expect(f).toBeDefined();
    expect(f!.detail).toContain('Maternal Health 2025');
    expect(f!.detail).toContain(LIVE_OPP.display_name);
    expect(f!.remediation).toMatch(/connect_get_opportunity|envVars/);
  });

  it('skips opp-name check when recipeOppName is null', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipe('J1a.yaml', { MODULE_NAME: 'Health Education', FORM_NAME: 'Module Quiz' })],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
      recipeOppName: null,
    });
    const f = verdict.failures.find((x) => x.class === 'opp-name-mismatch');
    expect(f).toBeUndefined();
  });
});

describe('probeRecipeSanity — failure class: tile-name-collision', () => {
  it('flags when a sibling tile shares the first-8-char prefix with the target opp', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipe('J1a.yaml', { MODULE_NAME: 'Health Education', FORM_NAME: 'Module Quiz' })],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP, // "Maternal Health 2026"
      visibleTiles: [
        'Maternal Health 2026',
        'Maternal Health 2025', // SAME first-8-char prefix → flagged
        'Family Planning 2026', // different prefix → ignored
      ],
    });
    const f = verdict.failures.find((x) => x.class === 'tile-name-collision');
    expect(f).toBeDefined();
    expect(f!.detail).toContain('Maternal Health 2025');
    expect(f!.detail).not.toContain('Family Planning 2026');
  });

  it('skips tile-collision check when visibleTiles is absent', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipe('J1a.yaml', { MODULE_NAME: 'Health Education', FORM_NAME: 'Module Quiz' })],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'tile-name-collision')).toBeUndefined();
  });
});

describe('probeRecipeSanity — multi-failure recipes', () => {
  it('surfaces all distinct failure classes in one verdict (probe is non-short-circuiting)', () => {
    const verdict = probeRecipeSanity({
      recipes: [
        recipe('J1a.yaml', { MODULE_NAME: 'GhostModule', FORM_NAME: 'GhostModule' }),
      ],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
      recipeOppName: 'wrong-opp',
    });
    expect(verdict.ok).toBe(false);
    const classes = verdict.failures.map((f) => f.class).sort();
    expect(classes).toContain('module-name-equals-form-name');
    expect(classes).toContain('expected-module-not-in-app');
    expect(classes).toContain('opp-name-mismatch');
  });
});

// --- Raw-body fixture for step-list-walking checks ---
function recipeBody(name: string, body: string): { name: string; text: string } {
  return { name, text: `appId: org.commcare.dalvik\n---\n${body}\n` };
}

describe('probeRecipeSanity — failure class: form-advance-without-answer-tap', () => {
  it('flags two adjacent form-advance runFlow steps with no answer between', () => {
    // Canonical malaria-rdt 20260522-1002 incident: J1 chained
    // form-advance.yaml across 10+ required-input quiz questions with
    // zero answer-selection steps in between.
    const body = [
      '- runFlow:',
      '    file: form-advance.yaml',
      '- runFlow:',
      '    file: form-advance.yaml',
      '- runFlow:',
      '    file: form-advance.yaml',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'form-advance-without-answer-tap');
    expect(f).toBeDefined();
    expect(f!.recipe).toBe('J1.yaml');
    expect(f!.detail).toMatch(/form-advance/);
    expect(f!.remediation).toMatch(/get_form|answer/i);
  });

  it('passes when every form-advance is preceded by an answer step in the same section', () => {
    const body = [
      '- tapOn:',
      '    text: "Public hospital"',
      '- runFlow:',
      '    file: form-advance.yaml',
      '- inputText: "Apcolite Stores"',
      '- runFlow:',
      '    file: form-advance.yaml',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'form-advance-without-answer-tap')).toBeUndefined();
  });

  it('flags two consecutive form-nav-next selector taps with nothing between', () => {
    // The `${SELECTOR:form-nav-next}` and `id: nav_btn_next` forms are
    // semantically identical to runFlow: form-advance.yaml.
    const body = [
      '- tapOn: ${SELECTOR:form-nav-next}',
      '- tapOn: ${SELECTOR:form-nav-next}',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J2.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'form-advance-without-answer-tap');
    expect(f).toBeDefined();
  });

  it('does not flag a single form-advance with no preceding answer (could be intro screen)', () => {
    // Some forms open on an info/instructions screen — a single
    // form-advance with no preceding answer step is legitimate. Only
    // flag chained advances (≥ 2 in a row) where the antipattern is
    // unambiguous.
    const body = [
      '- launchApp',
      '- runFlow:',
      '    file: form-advance.yaml',
      '- tapOn:',
      '    text: "Yes"',
      '- runFlow:',
      '    file: form-advance.yaml',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J3.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'form-advance-without-answer-tap')).toBeUndefined();
  });
});

describe('probeRecipeSanity — failure class: brief-label-drift', () => {
  it('flags tapOn:text matchers that use brief-style L<n>/F<n>/M<n> prefixes', () => {
    // jjackson/ace#115 finding 2: PDD brief uses "L0 — Why this matters"
    // but Nova rewrites to "1. Why this matters" — recipes referencing
    // the brief label never match the live screen.
    const body = [
      '- tapOn:',
      '    text: "L0 — Why this matters"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'brief-label-drift');
    expect(f).toBeDefined();
    expect(f!.recipe).toBe('J1.yaml');
    expect(f!.value).toBe('L0 — Why this matters');
    expect(f!.remediation).toMatch(/get_form|Nova/);
  });

  it('flags the ASCII-hyphen variant', () => {
    const body = '- tapOn:\n    text: "F1 - Shop Registration"';
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'brief-label-drift')).toBeDefined();
  });

  it('flags Stage <N> brief naming', () => {
    const body = '- tapOn:\n    text: "Stage 1 — Market Analysis"';
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'brief-label-drift')).toBeDefined();
  });

  it('passes Nova-rendered labels (1. Why this matters)', () => {
    const body = '- tapOn:\n    text: "1. Why this matters"';
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'brief-label-drift')).toBeUndefined();
  });

  it('passes ALL-CAPS Connect surface labels (VIEW OPPORTUNITY DETAILS)', () => {
    const body = '- tapOn:\n    text: "VIEW OPPORTUNITY DETAILS"';
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'brief-label-drift')).toBeUndefined();
  });
});

describe('deliver-smoke-rewalks-learn', () => {
  const baseInputs = (recipes: { name: string; text: string }[]) => ({
    recipes,
    novaApps: [],
    connectOpp: { display_name: 'Opp' },
  });

  it('flags a journey-deliver recipe that runFlows learn-launch', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: connect-login.yaml',
      '- runFlow:',
      '    file: learn-launch.yaml',
      '- takeScreenshot: "journey-deliver-final"',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-deliver.yaml', text }]));
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.class)).toContain('deliver-smoke-rewalks-learn');
  });

  it('flags a journey-deliver recipe with >=2 learn-tap-module runFlows', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-deliver.yaml', text }]));
    expect(v.failures.map((f) => f.class)).toContain('deliver-smoke-rewalks-learn');
  });

  it('does NOT flag a resume-only journey-deliver recipe', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: connect-resume-opp.yaml',
      '- runFlow:',
      '    file: deliver-launch.yaml',
      '- takeScreenshot: "journey-deliver-final"',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-deliver.yaml', text }]));
    expect(v.failures.map((f) => f.class)).not.toContain('deliver-smoke-rewalks-learn');
  });

  it('does NOT flag a journey-learn recipe that walks Learn fully', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: learn-launch.yaml',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-learn.yaml', text }]));
    expect(v.failures.map((f) => f.class)).not.toContain('deliver-smoke-rewalks-learn');
  });

  it('does NOT flag a journey-deliver recipe with a commented-out learn-launch step', () => {
    const text = [
      '# Deliver leg. The journey-learn leg already did the Learn walk:',
      '# - runFlow:',
      '#     file: learn-launch.yaml',
      '#     file: learn-tap-module.yaml',
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: connect-resume-opp.yaml',
      '- runFlow:',
      '    file: deliver-launch.yaml',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-deliver.yaml', text }]));
    expect(v.failures.map((f) => f.class)).not.toContain('deliver-smoke-rewalks-learn');
  });

  it('does NOT flag a journey-deliver recipe with exactly one learn-tap-module', () => {
    const text = [
      'appId: org.commcare.dalvik',
      '---',
      '- runFlow:',
      '    file: connect-resume-opp.yaml',
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '- runFlow:',
      '    file: deliver-launch.yaml',
    ].join('\n');
    const v = probeRecipeSanity(baseInputs([{ name: 'journey-deliver.yaml', text }]));
    expect(v.failures.map((f) => f.class)).not.toContain('deliver-smoke-rewalks-learn');
  });
});

describe('probeRecipeSanity — failure class: inputtext-geopoint-as-string', () => {
  it('flags an inputText of a "lat lon alt accuracy" GPS string', () => {
    // jjackson/ace#686: a native CommCare geopoint is a Capture-button
    // widget; typing a coord string collapses to one token and makes
    // selected-at(<gps>,1) throw at runtime.
    const body = ['- tapOn:', '    text: "Public hospital"', '- inputText: "12.0022 8.5920 500 10"'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'inputtext-geopoint-as-string');
    expect(f).toBeDefined();
    expect(f!.recipe).toBe('journey-deliver.yaml');
    expect(f!.value).toBe('12.0022 8.5920 500 10');
    expect(f!.remediation).toMatch(/Capture|mock location|mobile_set_location/i);
  });

  it('flags an adb-style %s-escaped GPS string', () => {
    const body = ['- inputText: "12.0022%s8.5920%s500%s10"'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'inputtext-geopoint-as-string')).toBeDefined();
  });

  it('does NOT flag a normal free-text inputText (e.g. an outlet name)', () => {
    const body = ['- inputText: "Apcolite Stores"', '- inputText: "200"'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'inputtext-geopoint-as-string')).toBeUndefined();
  });
});

// --- Field-aware checks (#858 label carve-out, #862 group field-lists) ---
//
// Fixtures mirror the real Nova structures named in both issues:
//   learn   DZ290VfHrQJkeYgOdr1C — 4 consecutive top-level `label` fields
//   deliver XPNGcJyT98JkcIKhkedZ — `poverty_scorecard` group (label +
//                                  zone + hh_member_count + ppi_q1..q9)

const LABEL_HEAVY_LEARN_APP: NovaAppSlice = {
  app_id: 'app-learn-labels',
  modules: [
    {
      module_name: 'Health Education',
      forms: [
        {
          form_name: 'Introduction',
          fields: [
            { id: 'intro', kind: 'label', label: 'Welcome to the module' },
            { id: 'read_exactly', kind: 'label', label: 'Read the script exactly' },
            { id: 'leading_vs_neutral', kind: 'label', label: 'Leading vs neutral' },
            { id: 'hidden_score', kind: 'label', label: 'How scoring works' },
            { id: 'q1', kind: 'single_select', label: 'Check your understanding', options: [{ label: 'True' }, { label: 'False' }] },
          ],
        },
      ],
    },
  ],
};

const GROUPED_DELIVER_APP: NovaAppSlice = {
  app_id: 'app-deliver-groups',
  modules: [
    {
      module_name: 'Household Survey',
      forms: [
        {
          form_name: 'Household Poverty Survey Visit',
          fields: [
            { id: 'respondent_role', kind: 'single_select', label: 'Respondent role in household', options: [{ label: 'Household head' }, { label: 'Spouse of the head' }] },
            {
              id: 'poverty_scorecard',
              kind: 'group',
              label: 'Household poverty scorecard (PLACEHOLDER instrument)',
              children: [
                { id: 'scorecard_note', kind: 'label', label: '**PLACEHOLDER instrument.** Stubbed placeholders.' },
                { id: 'zone', kind: 'single_select', label: 'Geopolitical zone (PLACEHOLDER for PPI zone question)', options: [{ label: 'North Central' }, { label: 'North East' }] },
                { id: 'hh_member_count', kind: 'int', label: 'Number of household members (PLACEHOLDER — PPI roster count)' },
                { id: 'ppi_q1', kind: 'single_select', label: 'PPI Indicator 1 (PLACEHOLDER)', options: [{ label: 'Option A' }, { label: 'Option B' }] },
                { id: 'ppi_score', kind: 'hidden' },
              ],
            },
            { id: 'respondent_name', kind: 'text', label: 'Respondent full name' },
          ],
        },
      ],
    },
  ],
};

describe('probeRecipeSanity — #858 label-screen carve-out', () => {
  it('does NOT flag a chain that a run of label screens fully explains', () => {
    // 4 consecutive labels → the legitimate walk is the advance leaving
    // the last answered screen, then one per label = a chain of 5.
    const body = Array.from({ length: 5 }, () => '- runFlow:\n    file: form-advance.yaml').join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', body)],
      novaApps: [LABEL_HEAVY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'form-advance-without-answer-tap')).toBeUndefined();
  });

  it('STILL flags a chain longer than the label run can explain', () => {
    const body = Array.from({ length: 6 }, () => '- runFlow:\n    file: form-advance.yaml').join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', body)],
      novaApps: [LABEL_HEAVY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'form-advance-without-answer-tap');
    expect(f).toBeDefined();
    expect(f!.detail).toMatch(/longest label-screen run/);
  });

  it('is byte-identical to the old behaviour when no field data is supplied', () => {
    // Backward-compat guard: callers that still pass bare {form_name}
    // must keep getting the field-blind threshold of 2.
    const body = ['- runFlow:', '    file: form-advance.yaml', '- runFlow:', '    file: form-advance.yaml'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'form-advance-without-answer-tap')).toBeDefined();
  });

  it('does NOT let labels INSIDE a group raise the allowance', () => {
    // A group is ONE field-list screen however many labels it holds, so
    // scorecard_note must not buy the recipe an extra advance.
    const body = ['- runFlow:', '    file: form-advance.yaml', '- runFlow:', '    file: form-advance.yaml'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [GROUPED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'form-advance-without-answer-tap')).toBeDefined();
  });
});

describe('probeRecipeSanity — failure class: group-field-list-per-question-walk', () => {
  it('flags a form-advance between two children of the same group', () => {
    // The #862 repro: journey-deliver.yaml walked poverty_scorecard
    // per-question and failed at tapOn "North Central" on warning_root.
    const body = [
      '- tapOn:',
      '    text: "North Central"',
      '- runFlow:',
      '    file: form-advance.yaml',
      '- tapOn:',
      '    text: "Option A"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [GROUPED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk');
    expect(f).toBeDefined();
    expect(f!.value).toBe('poverty_scorecard');
    expect(f!.recipe).toBe('journey-deliver.yaml');
    expect(f!.detail).toMatch(/field-list/);
    expect(f!.remediation).toMatch(/ONE trailing form-advance/);
  });

  it('passes a correct single-screen field-list walk', () => {
    // Answer every required child on the one screen, then ONE advance.
    const body = [
      '- tapOn:',
      '    text: "North Central"',
      '- tapOn:',
      '    below:',
      '      text: "Number of household members.*"',
      '- inputText: "6"',
      '- tapOn:',
      '    text: "Option A"',
      '- runFlow:',
      '    file: form-advance.yaml',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [GROUPED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk')).toBeUndefined();
  });

  it('does NOT flag an advance between a non-group field and a group child', () => {
    // respondent_role is its own screen — advancing off it is correct.
    const body = [
      '- tapOn:',
      '    text: "Household head"',
      '- runFlow:',
      '    file: form-advance.yaml',
      '- tapOn:',
      '    text: "North Central"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [GROUPED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk')).toBeUndefined();
  });

  it('matches a literal-prefix + .* matcher against the live label', () => {
    // Recipes compose "<literal prefix>.*" to dodge regex metacharacters
    // in question labels (parentheses) — the probe must still resolve it.
    const body = [
      '- tapOn:',
      '    text: "Number of household members.*"',
      '- runFlow:',
      '    file: form-advance.yaml',
      '- tapOn:',
      '    text: "North Central"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [GROUPED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk')).toBeDefined();
  });

  it('is inert when no field data is supplied', () => {
    const body = [
      '- tapOn:',
      '    text: "North Central"',
      '- runFlow:',
      '    file: form-advance.yaml',
      '- tapOn:',
      '    text: "Option A"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk')).toBeUndefined();
  });
});

// --- ace#1548: two Yes/No field-lists on one form ---

/**
 * The ace#1548 shape: three groups on one Deliver form, two of them
 * plain Yes/No field-lists plus a consent block whose options merely
 * START with "Yes"/"No". Label-prefix attribution sent every bare
 * `tapOn: text: "Yes"` to whichever group enumerates first, so a
 * correct one-advance-per-screen walk read as an advance between two
 * children of a third group.
 * Repro: hh-poverty-targeting/20260819-1435, Deliver
 * 8c57579d-bc5a-40df-8e60-0c26d030bb38.
 */
const TWO_YES_NO_DELIVER_APP: NovaAppSlice = {
  app_id: 'app-deliver-two-yes-no',
  modules: [
    {
      module_name: 'Household Survey',
      forms: [
        {
          form_name: 'Household Poverty Survey Visit',
          fields: [
            {
              id: 'consent_block',
              kind: 'group',
              label: 'Consent',
              children: [
                {
                  id: 'consent_given',
                  kind: 'single_select',
                  label: 'Does the respondent consent to this survey?',
                  options: [{ label: 'Yes, the respondent agrees' }, { label: 'No, the respondent declines' }],
                },
              ],
            },
            {
              id: 'consumption_7d',
              kind: 'group',
              label: 'Consumption in the past 7 days',
              children: [
                { id: 'i3_bread', kind: 'single_select', label: 'In the past 7 days, did anyone in this household consume bread', options: [{ label: 'Yes' }, { label: 'No' }] },
                { id: 'i4_eggs', kind: 'single_select', label: 'In the past 7 days, did anyone in this household consume eggs', options: [{ label: 'Yes' }, { label: 'No' }] },
                { id: 'i5_milk', kind: 'single_select', label: 'In the past 7 days, did anyone in this household consume milk', options: [{ label: 'Yes' }, { label: 'No' }] },
                { id: 'i6_water', kind: 'single_select', label: 'In the past 7 days, did anyone in this household consume bottled water', options: [{ label: 'Yes' }, { label: 'No' }] },
              ],
            },
            {
              id: 'assets',
              kind: 'group',
              label: 'Household assets',
              children: [
                { id: 'i8_sofa', kind: 'single_select', label: 'Does this household own a sofa', options: [{ label: 'Yes' }, { label: 'No' }] },
                { id: 'i9_fridge', kind: 'single_select', label: 'Does this household own a refrigerator', options: [{ label: 'Yes' }, { label: 'No' }] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * The wildcard spellings a `below:` anchor can carry, as RAW RECIPE BYTES
 * (the probe reads bytes, not parsed YAML).
 *
 * `\s` is not a legal escape in a YAML double-quoted scalar, so the idiom
 * `skills/app-test-cases/SKILL.md` mandates — and every authored journey
 * recipe therefore carries — is the TWO-backslash `"[\\s\\S]*…"`. The
 * one-backslash form only survives inside a single-quoted scalar. Both are
 * pinned so neither can regress into a green no-op (ace#1583).
 */
const WILDCARD_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['one-backslash', '[\\s\\S]*'],
  ['two-backslash', '[\\\\s\\\\S]*'],
] as const;

/** One anchored option tap: the `below:` anchor names the question
 * unambiguously, the way an authored journey recipe emits it. */
function anchoredTap(option: string, questionLabel: string, wildcard = '[\\s\\S]*'): string[] {
  return [
    '- tapOn:',
    `    text: "${option}"`,
    '    below:',
    `      text: "${wildcard}${questionLabel}${wildcard}"`,
  ];
}

const ADVANCE = ['- runFlow:', '    file: form-advance.yaml'];

describe('probeRecipeSanity — group attribution with two Yes/No field-lists (ace#1548)', () => {
  it('does NOT flag a correct one-advance-per-field-list walk', () => {
    // Every required child of consumption_7d answered on its one screen,
    // then exactly ONE trailing advance; same for assets. This is the
    // shape the probe's own remediation text asks for.
    const body = [
      ...anchoredTap('Yes, the respondent agrees', 'Does the respondent consent to this survey?'),
      ...ADVANCE,
      ...anchoredTap('Yes', 'In the past 7 days, did anyone in this household consume bread'),
      ...anchoredTap('Yes', 'In the past 7 days, did anyone in this household consume eggs'),
      ...anchoredTap('No', 'In the past 7 days, did anyone in this household consume milk'),
      ...anchoredTap('Yes', 'In the past 7 days, did anyone in this household consume bottled water'),
      ...ADVANCE,
      ...anchoredTap('No', 'Does this household own a sofa'),
      ...anchoredTap('Yes', 'Does this household own a refrigerator'),
      ...ADVANCE,
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [TWO_YES_NO_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk')).toBeUndefined();
  });

  it('STILL flags a real per-question walk, and names the group the anchors point at', () => {
    // Same form, wrong recipe: consumption_7d walked one question per
    // screen. The finding must name consumption_7d — not whichever
    // group happens to enumerate first with a "Yes"-ish option label.
    const body = [
      ...anchoredTap('Yes', 'In the past 7 days, did anyone in this household consume bread'),
      ...ADVANCE,
      ...anchoredTap('Yes', 'In the past 7 days, did anyone in this household consume eggs'),
      ...ADVANCE,
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [TWO_YES_NO_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk');
    expect(f).toBeDefined();
    expect(f!.value).toBe('consumption_7d');
  });

  it('does not attribute an AMBIGUOUS bare option tap to an arbitrary group', () => {
    // No anchors at all: a bare "Yes" is a child of two groups here, so
    // there is no evidence which screen the step is on. Attributing it
    // anyway is what manufactured the false positive.
    const body = [
      '- tapOn:',
      '    text: "Yes"',
      ...ADVANCE,
      '- tapOn:',
      '    text: "No"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [TWO_YES_NO_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk')).toBeUndefined();
  });

  it('resolves a bare option tap when only ONE group carries that label', () => {
    // "Yes, the respondent agrees" belongs to consent_block alone, so a
    // per-question walk of that group is still caught without anchors.
    const body = [
      '- tapOn:',
      '    text: "Yes, the respondent agrees"',
      ...ADVANCE,
      '- tapOn:',
      '    text: "Does the respondent consent to this survey?"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [TWO_YES_NO_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk');
    expect(f).toBeDefined();
    expect(f!.value).toBe('consent_block');
  });
});

describe.each(WILDCARD_SPELLINGS)(
  'probeRecipeSanity — group attribution, %s anchor spelling (ace#1583)',
  (_spelling, W) => {
    const tap = (option: string, label: string) => anchoredTap(option, label, W);

    // NON-VACUITY: this positive case and the negative case below share
    // the same helper and the same app fixture, so a spelling the probe
    // cannot see would fail HERE first — the negative case can never pass
    // merely because attribution went inert.
    it('flags a real per-question walk and names the group the anchors point at', () => {
      const body = [
        ...tap('Yes', 'In the past 7 days, did anyone in this household consume bread'),
        ...ADVANCE,
        ...tap('Yes', 'In the past 7 days, did anyone in this household consume eggs'),
        ...ADVANCE,
      ].join('\n');
      const verdict = probeRecipeSanity({
        recipes: [recipeBody('journey-deliver.yaml', body)],
        novaApps: [TWO_YES_NO_DELIVER_APP],
        connectOpp: LIVE_OPP,
      });
      const f = verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk');
      expect(f).toBeDefined();
      expect(f!.value).toBe('consumption_7d');
    });

    // The ace#1548 false-positive guard, re-run in this spelling: a recipe
    // that answers every child of a field-list on ONE screen must stay
    // clean now that the anchors are legible.
    it('does NOT flag a correct one-advance-per-field-list walk', () => {
      const body = [
        ...tap('Yes, the respondent agrees', 'Does the respondent consent to this survey?'),
        ...ADVANCE,
        ...tap('Yes', 'In the past 7 days, did anyone in this household consume bread'),
        ...tap('Yes', 'In the past 7 days, did anyone in this household consume eggs'),
        ...tap('No', 'In the past 7 days, did anyone in this household consume milk'),
        ...tap('Yes', 'In the past 7 days, did anyone in this household consume bottled water'),
        ...ADVANCE,
        ...tap('No', 'Does this household own a sofa'),
        ...tap('Yes', 'Does this household own a refrigerator'),
        ...ADVANCE,
      ].join('\n');
      const verdict = probeRecipeSanity({
        recipes: [recipeBody('journey-deliver.yaml', body)],
        novaApps: [TWO_YES_NO_DELIVER_APP],
        connectOpp: LIVE_OPP,
      });
      expect(
        verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk'),
      ).toBeUndefined();
    });

    // An anchor whose literal matches NO live label is no evidence about
    // which screen the step is on — silence under uncertainty (ace#1548).
    it('stays silent when the anchor literal matches no live question', () => {
      const body = [
        ...tap('Yes', 'A question this form does not contain'),
        ...ADVANCE,
        ...tap('Yes', 'Another question this form does not contain'),
        ...ADVANCE,
      ].join('\n');
      const verdict = probeRecipeSanity({
        recipes: [recipeBody('journey-deliver.yaml', body)],
        novaApps: [TWO_YES_NO_DELIVER_APP],
        connectOpp: LIVE_OPP,
      });
      expect(
        verdict.failures.find((x) => x.class === 'group-field-list-per-question-walk'),
      ).toBeUndefined();
    });
  },
);

describe('probeRecipeSanity — widening the recogniser starts no false-positive storm (ace#1583)', () => {
  // Teaching RECIPE_WILDCARD_SRC the two-backslash spelling re-arms every
  // check that reaches it. This pins the blast radius against the SHIPPED
  // palette: the static recipes must keep exactly the verdicts they had.
  // `form-advance-without-answer-tap` legitimately fires on three of them,
  // so this asserts about the re-armable classes only.
  const STATIC_DIR = join(import.meta.dirname, '..', '..', '..', 'mcp', 'mobile', 'recipes', 'static');
  const staticRecipes = readdirSync(STATIC_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(STATIC_DIR, f), 'utf8') }));

  it('sees a non-empty shipped palette', () => {
    // Non-vacuity guard: an empty read would make every case below pass.
    expect(staticRecipes.length).toBeGreaterThan(10);
  });

  it('fires neither re-armed check on any shipped static recipe, alone or as one corpus', () => {
    const REARMED = ['group-field-list-per-question-walk', 'answer-tap-before-leading-label-advance'];
    const corpora = [...staticRecipes.map((r) => [r]), staticRecipes];
    for (const recipes of corpora) {
      const verdict = probeRecipeSanity({
        recipes,
        novaApps: [TWO_YES_NO_DELIVER_APP],
        connectOpp: LIVE_OPP,
      });
      const hits = verdict.failures.filter((f) => REARMED.includes(f.class));
      expect(hits.map((f) => `${f.recipe}:${f.class}`)).toEqual([]);
    }
  });
});

describe('probeRecipeSanity — observed records WHICH probe ran', () => {
  it('reports field_data_supplied=false and inert counters without fields', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', '- launchApp')],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.observed.field_data_supplied).toBe(false);
    expect(verdict.observed.max_label_screen_run).toBe(0);
    expect(verdict.observed.nova_groups_seen).toBe(0);
  });

  it('reports the label run and group count when fields ARE supplied', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', '- launchApp')],
      novaApps: [LABEL_HEAVY_LEARN_APP, GROUPED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.observed.field_data_supplied).toBe(true);
    expect(verdict.observed.max_label_screen_run).toBe(4);
    expect(verdict.observed.nova_groups_seen).toBe(1);
  });

  it('reports module_form_checks_ran=false when no recipe binds a MODULE_NAME', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', '- launchApp')],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.observed.module_form_checks_ran).toBe(false);
  });

  it('reports module_form_checks_ran=true when a nested runFlow.env binds one', () => {
    const body = [
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '    env:',
      '      MODULE_NAME: "Health Education"',
      '      FORM_NAME: "Module Quiz"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.observed.module_form_checks_ran).toBe(true);
    expect(verdict.ok).toBe(true);
  });

  it('reports field_data_supplied=true even when only ONE app carries fields', () => {
    // Mixed input is the realistic Phase 6 case (learn fetched, deliver
    // not). The flag says "some checks ran", the counters say how much.
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', '- launchApp')],
      novaApps: [HEALTHY_DELIVER_APP, LABEL_HEAVY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.observed.field_data_supplied).toBe(true);
    expect(verdict.observed.max_label_screen_run).toBe(4);
    expect(verdict.observed.nova_groups_seen).toBe(0);
  });
});

// --- ace#1045: the INVERSE leading-label check ---------------------------
//
// The live repro: Nova Learn app 8c758d89-3a20-4b72-bec1-713c3129a904,
// form `connect_basics_quiz`, field order
//   intro (label) -> q1 (single_select, required) -> q1_score (hidden)
//   -> user_score (hidden) -> pass_msg (label) -> fail_msg (label)
// The golden journey-learn.yaml ran learn-tap-module -> takeScreenshot ->
// tapOn the q1 option with NO intervening advance, so the answer tap
// landed on the `intro` screen (selector-not-found), the Learn leg died,
// learn_progress never hit 100%, Deliver stayed locked, and Phase 6 could
// not complete. #710/#684 fixed this class in PROSE only.

const Q1_OPTION = 'earn payments for verified service deliveries';

const LEADING_LABEL_QUIZ_APP: NovaAppSlice = {
  app_id: '8c758d89-3a20-4b72-bec1-713c3129a904',
  modules: [
    {
      module_name: 'Connect Basics',
      forms: [
        {
          form_name: 'Connect Basics Quiz',
          fields: [
            { id: 'intro', kind: 'label', label: 'Welcome to Connect Basics' },
            {
              id: 'q1',
              kind: 'single_select',
              label: 'What does Connect pay you for?',
              options: [{ label: Q1_OPTION }, { label: 'attending meetings' }],
            },
            { id: 'q1_score', kind: 'hidden' },
            { id: 'user_score', kind: 'hidden' },
            { id: 'pass_msg', kind: 'label', label: 'You passed', relevant: '#form/user_score >= 80' },
            { id: 'fail_msg', kind: 'label', label: 'Please retry', relevant: '#form/user_score < 80' },
          ],
        },
      ],
    },
  ],
};

/** The golden recipe verbatim, parameterised on how many bare advances
 * sit between the menu-walk entry step and the answer tap. */
function learnQuizRecipe(
  advances: number,
  formName = 'Connect Basics Quiz',
  moduleName = 'Connect Basics',
): { name: string; text: string } {
  const body = [
    '- runFlow:',
    '    file: learn-tap-module.yaml',
    '    env:',
    `      MODULE_NAME: "${moduleName}"`,
    `      FORM_NAME: "${formName}"`,
    '- takeScreenshot: "journey-learn-quiz-question"',
    ...Array.from({ length: advances }, () => '- runFlow:\n    file: form-advance.yaml'),
    '- tapOn:',
    `    text: "${Q1_OPTION}"`,
  ].join('\n');
  return recipeBody('journey-learn.yaml', body);
}

describe('probeRecipeSanity — failure class: answer-tap-before-leading-label-advance', () => {
  it('flags the live ace#1045 repro (answer tap with ZERO advances past a leading label)', () => {
    const verdict = probeRecipeSanity({
      recipes: [learnQuizRecipe(0)],
      novaApps: [LEADING_LABEL_QUIZ_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.ok).toBe(false);
    const f = verdict.failures.find((x) => x.class === 'answer-tap-before-leading-label-advance');
    expect(f).toBeDefined();
    expect(f!.recipe).toBe('journey-learn.yaml');
    expect(f!.value).toBe('expected=1,found=0');
    expect(f!.detail).toContain('Connect Basics Quiz');
    expect(f!.detail).toContain('intro');
    expect(f!.remediation).toMatch(/form-advance|app-test-cases/);
  });

  it('passes the SAME recipe once the leading-label advance is emitted', () => {
    const verdict = probeRecipeSanity({
      recipes: [learnQuizRecipe(1)],
      novaApps: [LEADING_LABEL_QUIZ_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((x) => x.class)).not.toContain(
      'answer-tap-before-leading-label-advance',
    );
    expect(verdict.ok).toBe(true);
  });

  it('counts leading labels past `hidden` fields (hidden renders no screen)', () => {
    const app: NovaAppSlice = {
      app_id: 'app-hidden-first',
      modules: [
        {
          module_name: 'Connect Basics',
          forms: [
            {
              form_name: 'Connect Basics Quiz',
              fields: [
                { id: 'calc_setup', kind: 'hidden' },
                { id: 'intro', kind: 'label', label: 'Welcome' },
                { id: 'also_intro', kind: 'label', label: 'How scoring works' },
                {
                  id: 'q1',
                  kind: 'single_select',
                  label: 'What does Connect pay you for?',
                  options: [{ label: Q1_OPTION }],
                },
              ],
            },
          ],
        },
      ],
    };
    const verdict = probeRecipeSanity({
      recipes: [learnQuizRecipe(1)],
      novaApps: [app],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'answer-tap-before-leading-label-advance');
    expect(f).toBeDefined();
    expect(f!.value).toBe('expected=2,found=1');
  });

  it('does NOT count INTERIOR labels toward the leading budget', () => {
    // pass_msg/fail_msg sit AFTER q1 — they are the score-gated result
    // screens, not a leading intro, so they must not raise the budget.
    const app: NovaAppSlice = {
      app_id: 'app-no-leading-label',
      modules: [
        {
          module_name: 'Connect Basics',
          forms: [
            {
              form_name: 'Connect Basics Quiz',
              fields: [
                {
                  id: 'q1',
                  kind: 'single_select',
                  label: 'What does Connect pay you for?',
                  options: [{ label: Q1_OPTION }],
                },
                { id: 'pass_msg', kind: 'label', label: 'You passed' },
                { id: 'fail_msg', kind: 'label', label: 'Please retry' },
              ],
            },
          ],
        },
      ],
    };
    const verdict = probeRecipeSanity({
      recipes: [learnQuizRecipe(0)],
      novaApps: [app],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((x) => x.class)).not.toContain(
      'answer-tap-before-leading-label-advance',
    );
  });

  it('is inert when the caller supplies no field data', () => {
    const verdict = probeRecipeSanity({
      recipes: [learnQuizRecipe(0, 'Module Quiz', 'Health Education')],
      novaApps: [HEALTHY_LEARN_APP], // module/form names resolve, no fields
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((x) => x.class)).not.toContain(
      'answer-tap-before-leading-label-advance',
    );
    expect(verdict.ok).toBe(true);
  });

  it('does NOT fire on a navigation tap that is not one of the form`s answer matchers', () => {
    // Precision guard — the #858/#860 false-positive tax is why the
    // trigger must resolve to a real question/option label.
    const body = [
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '    env:',
      '      MODULE_NAME: "Connect Basics"',
      '      FORM_NAME: "Connect Basics Quiz"',
      '- tapOn:',
      '    text: "VIEW OPPORTUNITY DETAILS"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', body)],
      novaApps: [LEADING_LABEL_QUIZ_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((x) => x.class)).not.toContain(
      'answer-tap-before-leading-label-advance',
    );
  });

  it('is inert without a menu-walk entry step (nothing anchors the budget)', () => {
    const body = ['- tapOn:', `    text: "${Q1_OPTION}"`].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', body)],
      novaApps: [LEADING_LABEL_QUIZ_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((x) => x.class)).not.toContain(
      'answer-tap-before-leading-label-advance',
    );
  });

  it('resolves the form via deliver-form-walk, which binds no env', () => {
    const deliverApp: NovaAppSlice = {
      app_id: 'app-deliver-leading-label',
      modules: [
        {
          module_name: 'Bednet Visit',
          forms: [
            {
              form_name: 'Bednet Visit',
              fields: [
                { id: 'visit_intro', kind: 'label', label: 'Confirm you are at the household' },
                {
                  id: 'nets_hung',
                  kind: 'single_select',
                  label: 'Were the nets hung correctly?',
                  options: [{ label: 'Yes, all nets hung' }, { label: 'No' }],
                },
              ],
            },
          ],
        },
      ],
    };
    const body = [
      '- runFlow:',
      '    file: deliver-form-walk.yaml',
      '- tapOn:',
      '    text: "Yes, all nets hung"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [deliverApp],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'answer-tap-before-leading-label-advance');
    expect(f).toBeDefined();
    expect(f!.value).toBe('expected=1,found=0');
  });
});

describe('probeRecipeSanity — #858 permissive carve-out and the #1045 inverse both hold', () => {
  // LABEL_HEAVY_LEARN_APP: 4 leading `label` screens then a single_select
  // ("True"/"False"). The two checks bound the SAME recipe from opposite
  // sides: fewer than 4 advances is #1045, more than 5 is #858.
  const walk = (advances: number) =>
    recipeBody(
      'journey-learn.yaml',
      [
        '- runFlow:',
        '    file: learn-tap-module.yaml',
        '    env:',
        '      MODULE_NAME: "Health Education"',
        '      FORM_NAME: "Introduction"',
        ...Array.from({ length: advances }, () => '- runFlow:\n    file: form-advance.yaml'),
        '- tapOn:',
        '    text: "True"',
      ].join('\n'),
    );

  it('a label-traversing recipe with ENOUGH advances stays clean in both directions', () => {
    const verdict = probeRecipeSanity({
      recipes: [walk(4)],
      novaApps: [LABEL_HEAVY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures).toHaveLength(0);
    expect(verdict.ok).toBe(true);
  });

  it('the same recipe with TOO FEW advances now fails — and only on the new class', () => {
    const verdict = probeRecipeSanity({
      recipes: [walk(2)],
      novaApps: [LABEL_HEAVY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    const classes = verdict.failures.map((x) => x.class);
    expect(classes).toContain('answer-tap-before-leading-label-advance');
    // The permissive #858 threshold (maxLabelRun + 2 = 6) must stay put.
    expect(classes).not.toContain('form-advance-without-answer-tap');
    const f = verdict.failures.find((x) => x.class === 'answer-tap-before-leading-label-advance');
    expect(f!.value).toBe('expected=4,found=2');
  });
});

// --- ace#1068: module/form checks can now fire, and say when they didn't ---

describe('probeRecipeSanity — nested runFlow.env drives the module/form checks', () => {
  it('fires expected-module-not-in-app for a module named in a NESTED runFlow.env', () => {
    const body = [
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '    env:',
      '      MODULE_NAME: "GhostModule"',
      '      FORM_NAME: "Module Quiz"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.ok).toBe(false);
    const f = verdict.failures.find((x) => x.class === 'expected-module-not-in-app');
    expect(f).toBeDefined();
    expect(f!.value).toBe('GhostModule');
    expect(verdict.observed.recipe_module_names).toEqual(['GhostModule']);
    expect(verdict.observed.recipe_form_names).toEqual(['Module Quiz']);
  });

  it('fires expected-form-not-in-module for a form named in a NESTED runFlow.env', () => {
    const body = [
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '    env:',
      '      MODULE_NAME: "Health Education"',
      '      FORM_NAME: "Register Visit"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP, HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'expected-form-not-in-module')).toBeDefined();
  });
});

describe('probeRecipeSanity — warning class: module-form-checks-not-run', () => {
  it('warns (without failing) when a runFlow recipe binds no MODULE_NAME', () => {
    const body = [
      '- runFlow:',
      '    file: connect-resume-opp.yaml',
      '- runFlow:',
      '    file: deliver-form-walk.yaml',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.ok).toBe(true); // a caveat qualifies a pass, never denies it
    const w = verdict.warnings.find((x) => x.class === 'module-form-checks-not-run');
    expect(w).toBeDefined();
    expect(w!.recipe).toBe('journey-deliver.yaml');
    expect(w!.detail).toContain('expected-module-not-in-app');
    expect(w!.detail).toContain('expected-form-not-in-module');
    expect(w!.remediation).toMatch(/MODULE_NAME|nova_get_app/);
    expect(verdict.observed.module_form_checks_ran).toBe(false);
  });

  it('does NOT warn once the nested runFlow.env binds MODULE_NAME', () => {
    const body = [
      '- runFlow:',
      '    file: learn-tap-module.yaml',
      '    env:',
      '      MODULE_NAME: "Health Education"',
      '      FORM_NAME: "Module Quiz"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-learn.yaml', body)],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.warnings).toHaveLength(0);
    expect(verdict.observed.module_form_checks_ran).toBe(true);
  });

  it('does not warn on a recipe with no runFlow steps at all', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('J1.yaml', '- launchApp')],
      novaApps: [HEALTHY_LEARN_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.warnings).toHaveLength(0);
  });
});

// --- ace#1235: the module/form cross product ---
//
// `expected-form-not-in-module` used to check every collected FORM_NAME
// against every collected MODULE_NAME. For a recipe walking M modules with
// one form each that emits M x (M-1) failures — each message individually
// true ("form X is not in module Y") and the conclusion false, because the
// recipe never bound that pair.
//
// It made every multi-module Learn smoke un-passable at Phase 6 pre-flight,
// and one-form-per-module is a load-bearing ACE pattern (Connect dedups
// deliver units by module slug), so multi-module is the NORMAL shape rather
// than an edge case. Live repro: spark-facilitator 20260812-1635, a 9-module
// Learn app, ~64 spurious failures.
//
// Newly live via ace#1068 — before that `extractRecipeParameters` did not
// walk nested `runFlow.env`, so the check was silently inert.

/** Multi-module recipe in the shape Phase 3 actually emits: one nested
 * `runFlow.env` block per module, each pairing a module with ITS OWN form. */
function multiModuleRecipe(
  name: string,
  pairs: { module: string; form?: string }[],
): { name: string; text: string } {
  const steps = pairs
    .map(({ module, form }) =>
      [
        `- runFlow:`,
        `    file: content-form-finish-to-suite.yaml`,
        `    env:`,
        `      MODULE_NAME: "${module}"`,
        ...(form === undefined ? [] : [`      FORM_NAME: "${form}"`]),
      ].join('\n'),
    )
    .join('\n');
  return { name, text: `appId: org.commcare.dalvik\n---\n${steps}\n` };
}

const THREE_MODULE_APP: NovaAppSlice = novaApp('app-learn-multi', {
  'Lesson 1': ['Read lesson 1'],
  'Lesson 2': ['Read lesson 2'],
  'Lesson 3': ['Read lesson 3'],
});

describe('extractRecipeParameters — module/form pairing (ace#1235)', () => {
  it('records which form was bound alongside which module', () => {
    const r = multiModuleRecipe('journey-learn.yaml', [
      { module: 'Lesson 1', form: 'Read lesson 1' },
      { module: 'Lesson 2', form: 'Read lesson 2' },
    ]);
    const params = extractRecipeParameters(r);
    expect(params.modulePairs).toEqual([
      { moduleName: 'Lesson 1', formName: 'Read lesson 1' },
      { moduleName: 'Lesson 2', formName: 'Read lesson 2' },
    ]);
    // Flat sets still populated — `expected-module-not-in-app` uses them
    // and is correct on the flat set.
    expect(params.moduleNames.size).toBe(2);
    expect(params.formNames.size).toBe(2);
  });

  it('pairs a module bound with no form as formName null', () => {
    const r = multiModuleRecipe('branch-b.yaml', [{ module: 'Lesson 1' }]);
    const params = extractRecipeParameters(r);
    expect(params.modulePairs).toEqual([{ moduleName: 'Lesson 1', formName: null }]);
  });

  it('keeps one pair per env block even when a module repeats', () => {
    const r = multiModuleRecipe('revisit.yaml', [
      { module: 'Lesson 1', form: 'Read lesson 1' },
      { module: 'Lesson 1', form: 'Read lesson 1' },
    ]);
    expect(extractRecipeParameters(r).modulePairs).toHaveLength(2);
    // ...while the flat set still de-duplicates.
    expect(extractRecipeParameters(r).moduleNames.size).toBe(1);
  });
});

describe('probeRecipeSanity — no cross-product failures (ace#1235)', () => {
  it('passes a multi-module recipe where every pair is correct', () => {
    const verdict = probeRecipeSanity({
      recipes: [
        multiModuleRecipe('journey-learn.yaml', [
          { module: 'Lesson 1', form: 'Read lesson 1' },
          { module: 'Lesson 2', form: 'Read lesson 2' },
          { module: 'Lesson 3', form: 'Read lesson 3' },
        ]),
      ],
      novaApps: [THREE_MODULE_APP],
      connectOpp: LIVE_OPP,
    });
    // Pre-fix this emitted 3 x 2 = 6 spurious failures.
    expect(
      verdict.failures.filter((f) => f.class === 'expected-form-not-in-module'),
    ).toEqual([]);
  });

  it('still catches a genuinely mispaired form', () => {
    const verdict = probeRecipeSanity({
      recipes: [
        multiModuleRecipe('journey-learn.yaml', [
          { module: 'Lesson 1', form: 'Read lesson 1' },
          // Real drift: lesson 2's block names lesson 3's form.
          { module: 'Lesson 2', form: 'Read lesson 3' },
        ]),
      ],
      novaApps: [THREE_MODULE_APP],
      connectOpp: LIVE_OPP,
    });
    const formFailures = verdict.failures.filter(
      (f) => f.class === 'expected-form-not-in-module',
    );
    expect(formFailures).toHaveLength(1);
    expect(formFailures[0].value).toBe('Read lesson 3');
    expect(formFailures[0].detail).toContain('Lesson 2');
  });

  it('does not report a missing form when the block binds no FORM_NAME', () => {
    const verdict = probeRecipeSanity({
      recipes: [multiModuleRecipe('branch-b.yaml', [{ module: 'Lesson 1' }])],
      novaApps: [THREE_MODULE_APP],
      connectOpp: LIVE_OPP,
    });
    expect(
      verdict.failures.filter((f) => f.class === 'expected-form-not-in-module'),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1118 — score-gated-quiz-over-advance. On a score-gated
// quiz (#569: trailing relevant-gated result labels, FINISH-only finalize),
// form-submit.yaml performs the answer→result-label advance ITSELF. A recipe
// that chains an explicit form-advance between the last answer and
// form-submit consumes that advance, leaving form-submit tapping a
// nav_btn_next the result screen does not render. Carved out of #1045's
// "second, related miss in the same file"; observed in the same golden
// recipe (bednet-spot-check, Nova Learn app 8c758d89).
// ---------------------------------------------------------------------------

/** Quiz walk parameterised on bare advances between the answer tap and the
 * form-submit palette call (0 = correct for a score-gated quiz). */
function learnQuizSubmitRecipe(advancesAfterAnswer: number): { name: string; text: string } {
  const body = [
    '- runFlow:',
    '    file: learn-tap-module.yaml',
    '    env:',
    '      MODULE_NAME: "Connect Basics"',
    '      FORM_NAME: "Connect Basics Quiz"',
    '- runFlow:\n    file: form-advance.yaml', // past the leading intro label
    '- tapOn:',
    `    text: "${Q1_OPTION}"`,
    ...Array.from({ length: advancesAfterAnswer }, () => '- runFlow:\n    file: form-advance.yaml'),
    '- runFlow:',
    '    file: form-submit.yaml',
    '    env:',
    '      SUBMIT_LABEL: "Submit"',
  ].join('\n');
  return recipeBody('journey-learn.yaml', body);
}

describe('probeRecipeSanity — failure class: score-gated-quiz-over-advance (#1118)', () => {
  it('flags an explicit form-advance between the last answer and form-submit on a score-gated quiz', () => {
    const verdict = probeRecipeSanity({
      recipes: [learnQuizSubmitRecipe(1)],
      novaApps: [LEADING_LABEL_QUIZ_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'score-gated-quiz-over-advance');
    expect(f).toBeDefined();
    expect(f!.recipe).toBe('journey-learn.yaml');
    expect(f!.detail).toContain('Connect Basics Quiz');
    expect(f!.remediation).toMatch(/form-submit|#569/);
  });

  it('passes the same walk with NO advance between answer and form-submit', () => {
    const verdict = probeRecipeSanity({
      recipes: [learnQuizSubmitRecipe(0)],
      novaApps: [LEADING_LABEL_QUIZ_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((x) => x.class)).not.toContain('score-gated-quiz-over-advance');
  });

  it('stays inert when the trailing labels carry no relevance gate (auto-finalize quiz)', () => {
    const ungated: NovaAppSlice = JSON.parse(JSON.stringify(LEADING_LABEL_QUIZ_APP));
    for (const field of ungated.modules[0].forms[0].fields!) delete (field as any).relevant;
    const verdict = probeRecipeSanity({
      recipes: [learnQuizSubmitRecipe(1)],
      novaApps: [ungated],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((x) => x.class)).not.toContain('score-gated-quiz-over-advance');
  });

  it('allows one bare advance per UNGATED trailing label sitting before the gated pair', () => {
    const withThanks: NovaAppSlice = JSON.parse(JSON.stringify(LEADING_LABEL_QUIZ_APP));
    const fields = withThanks.modules[0].forms[0].fields!;
    // an unconditional wrap-up screen between the last question and the
    // score-gated result labels — it renders always and needs its own advance
    fields.splice(fields.length - 2, 0, { id: 'wrap_up', kind: 'label', label: 'Thanks for answering' });
    const one = probeRecipeSanity({
      recipes: [learnQuizSubmitRecipe(1)],
      novaApps: [withThanks],
      connectOpp: LIVE_OPP,
    });
    expect(one.failures.map((x) => x.class)).not.toContain('score-gated-quiz-over-advance');
    const two = probeRecipeSanity({
      recipes: [learnQuizSubmitRecipe(2)],
      novaApps: [withThanks],
      connectOpp: LIVE_OPP,
    });
    expect(two.failures.map((x) => x.class)).toContain('score-gated-quiz-over-advance');
  });

  it('stays inert when the caller supplies no fields (same contract as the sibling checks)', () => {
    const noFields: NovaAppSlice = {
      app_id: 'x',
      modules: [{ module_name: 'Connect Basics', forms: [{ form_name: 'Connect Basics Quiz' }] }],
    };
    const verdict = probeRecipeSanity({
      recipes: [learnQuizSubmitRecipe(1)],
      novaApps: [noFields],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((x) => x.class)).not.toContain('score-gated-quiz-over-advance');
  });
});

describe('probeRecipeSanity — failure class: unguarded-option-tap-below-long-label', () => {
  // The live bednet-check-2-visit/20260814-0856 Deliver-leg failure. The
  // `Consent` group is ONE CommCare field-list holding an ~840-char read-aloud
  // consent script plus `consent_given` (Yes/No). The authored recipe tapped
  // "Yes" bare and died `selector-not-found` — the radios were below the fold.
  //
  // What makes this worth a check rather than a doc line: the SAME authoring
  // pass produced a Learn recipe with a guarded scroll on all ten of its
  // option taps and a Deliver recipe with none. The rule was already written
  // down and still missed.
  const CONSENT_SCRIPT = 'Read this aloud to the household. '.repeat(26); // ~880 chars

  const CONSENT_GROUP_APP = {
    app_id: 'deliver-app',
    modules: [
      {
        name: 'Register Household',
        forms: [
          {
            name: 'Register Household',
            fields: [
              {
                id: 'consent',
                kind: 'group',
                label: 'Consent',
                children: [
                  { id: 'consent_script', kind: 'label', label: CONSENT_SCRIPT },
                  {
                    id: 'consent_given',
                    kind: 'single_select',
                    label: 'Does this household agree to take part?',
                    options: [{ label: 'Yes' }, { label: 'No' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it('flags a bare option tap on a screen whose label pushes it below the fold', () => {
    const body = ['- tapOn:', '    text: "Yes"'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [CONSENT_GROUP_APP as never],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'unguarded-option-tap-below-long-label');
    expect(f, 'the exact defect that killed the live Deliver leg must be caught').toBeDefined();
    expect(f!.value).toBe('Yes');
    expect(f!.recipe).toBe('journey-deliver.yaml');
    expect(f!.detail).toMatch(/below the fold/);
    expect(f!.remediation).toMatch(/scrollUntilVisible/);
  });

  it('passes once the tap is guarded by a scroll for the same option', () => {
    // The idiom journey-learn.yaml used throughout — and journey-deliver
    // used nowhere.
    const body = [
      '- runFlow:',
      '    when:',
      '      notVisible:',
      '        text: "Yes"',
      '    commands:',
      '      - scrollUntilVisible:',
      '          element:',
      '            text: "Yes"',
      '          direction: DOWN',
      '- tapOn:',
      '    text: "Yes"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [CONSENT_GROUP_APP as never],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'unguarded-option-tap-below-long-label'))
      .toBeUndefined();
  });

  it('does NOT fire on a short-label screen — narrow by construction (#858)', () => {
    // A false positive here costs a redundant scroll; the #858 lesson is that
    // careless breadth in this probe is expensive. Same recipe, short label.
    const shortLabelApp = JSON.parse(JSON.stringify(CONSENT_GROUP_APP));
    shortLabelApp.modules[0].forms[0].fields[0].children[0].label = 'Consent';
    const body = ['- tapOn:', '    text: "Yes"'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [shortLabelApp as never],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'unguarded-option-tap-below-long-label'))
      .toBeUndefined();
  });

  it('does not fire when no field data is supplied — field-gated like its siblings', () => {
    const body = ['- tapOn:', '    text: "Yes"'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [{ app_id: 'deliver-app', modules: [{ name: 'Register Household', forms: [{ name: 'Register Household' }] }] } as never],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'unguarded-option-tap-below-long-label'))
      .toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ace#1554 — the two field-list INPUT defects ace#1299 § 4 specified.
//
// #1299 proved on-device (spark-facilitator/20260813-2126) that a CommCare
// form question renders as `label TextView -> optional hint TextView ->
// EditText`. Two independent defects follow, and the probe could see
// NEITHER because `NovaFieldSlice` carried no `hint`:
//
//   1. `input-anchor-skips-hint` — the focus anchor must be the element
//      IMMEDIATELY above the EditText: the field's `hint` when it has one,
//      the question label when it does not. Anchoring a hint-carrying field
//      on its LABEL resolves to the hint TextView, and tapping a TextView
//      moves no focus. 3 of that run's 14 inputs were wrong this way; the
//      symptom is silent data corruption (`cbf_name` =
//      "Thandiwe Banda0991234567", required `phone_number` empty), not a
//      failed leg.
//   2. `input-focus-scroll-is-guarded` — the centring scroll onto that
//      anchor must be UNCONDITIONAL. `when: notVisible: <anchor>` is
//      structurally blind to the real failure ("anchor visible, its
//      EditText still below the fold"), so it suppresses the one scroll
//      that was needed. That half affected all 14 inputs and is, per
//      #1299, "the more important half of the bug".
//
// Both are pure set/string logic over data already in hand → unit-test
// class per CLAUDE.md (precedent ace#1235), not device-truth.
//
// SILENCE UNDER UNCERTAINTY is the governing constraint, not a nicety: a
// false positive here halts Phase 3 with an `incomplete` re-author loop
// (the #858 tax, and precisely the harm ace#1547/PR #1553 removed). Every
// "does NOT flag" case below is load-bearing.

/** The spark-facilitator `facilitator_details` field-list, hints included. */
const HINTED_DELIVER_APP: NovaAppSlice = {
  app_id: 'app-deliver-hints',
  modules: [
    {
      module_name: 'Facilitator Registration',
      forms: [
        {
          form_name: 'Register Facilitator',
          fields: [
            {
              id: 'facilitator_details',
              kind: 'group',
              label: 'Facilitator details',
              children: [
                {
                  id: 'cbf_name',
                  kind: 'text',
                  label: "Facilitator's full name (as on their ID)",
                  hint: 'First name and family name. Spell it exactly as on the ID.',
                },
                {
                  id: 'phone_number',
                  kind: 'text',
                  label: "Facilitator's phone number",
                  hint: 'Ten digits starting with zero.',
                },
                {
                  id: 'hh_represented',
                  kind: 'int',
                  label: 'Households represented at this session',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** Same app with every `hint` stripped — the shape a Step 2.6 caller that
 * has NOT been taught to pass hints produces. Must yield zero findings. */
const HINTLESS_DELIVER_APP: NovaAppSlice = JSON.parse(
  JSON.stringify(HINTED_DELIVER_APP, (k, v) => (k === 'hint' ? undefined : v)),
);

const HINT_ANCHOR = '[\\\\s\\\\S]*Ten digits starting with zero.[\\\\s\\\\S]*';
const LABEL_ANCHOR = "[\\\\s\\\\S]*Facilitator's phone number[\\\\s\\\\S]*";

/** The sanctioned idiom: unconditional centring scroll onto the anchor,
 * then `tapOn: below:` that anchor, then inputText. */
function inputWalk(
  anchor: string,
  opts: { guarded?: boolean; noScroll?: boolean } = {},
): string {
  const scroll = [
    '- scrollUntilVisible:',
    '    element:',
    `      text: "${anchor}"`,
    '    direction: DOWN',
    '    speed: 30',
    '    centerElement: true',
  ];
  const guardedScroll = [
    '- runFlow:',
    '    when:',
    '      notVisible:',
    `        text: "${anchor}"`,
    '    commands:',
    '      - scrollUntilVisible:',
    '          element:',
    `            text: "${anchor}"`,
    '          direction: DOWN',
    '          speed: 30',
    '          centerElement: true',
  ];
  const tap = [
    '- tapOn:',
    '    below:',
    `      text: "${anchor}"`,
    '- inputText: "0991234567"',
    '- hideKeyboard',
  ];
  const prefix = opts.noScroll ? [] : opts.guarded ? guardedScroll : scroll;
  return [...prefix, ...tap].join('\n');
}

describe('probeRecipeSanity — failure class: input-anchor-skips-hint (ace#1554/#1299)', () => {
  it('flags an input anchored on the QUESTION LABEL of a hint-carrying field', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(LABEL_ANCHOR))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'input-anchor-skips-hint');
    expect(f).toBeDefined();
    expect(f!.value).toBe('phone_number');
    expect(f!.recipe).toBe('journey-deliver.yaml');
    expect(f!.detail).toMatch(/hint/);
    expect(f!.remediation).toMatch(/Ten digits starting with zero/);
    expect(verdict.ok).toBe(false);
  });

  it('does NOT flag the same walk anchored on the HINT — non-vacuity control', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(HINT_ANCHOR))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeUndefined();
  });

  it('does NOT flag a HINT-LESS field anchored on its label — that IS the rule', () => {
    // #1299's own table: 8 of 14 inputs had no hint and were correctly
    // anchored on the question label. Flagging them would be the #858 tax.
    const anchor = '[\\\\s\\\\S]*Households represented at this session[\\\\s\\\\S]*';
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(anchor))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeUndefined();
  });

  it('is SILENT when hints were not supplied at all — missing data must never flag', () => {
    // The whole reason ace#1554 was un-bundled from #1553: a caller that
    // has not been taught to pass `hint` must get a no-op, NOT a Phase 3
    // halt on an assumed "no hint".
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(LABEL_ANCHOR))],
      novaApps: [HINTLESS_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeUndefined();
    expect(verdict.observed.hint_data_supplied).toBe(false);
  });

  it('is SILENT when no field data is supplied at all — field-gated like its siblings', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(LABEL_ANCHOR))],
      novaApps: [HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeUndefined();
    expect(verdict.observed.hint_data_supplied).toBe(false);
  });

  it('declines to guess when the anchor resolves to MORE THAN ONE field (ace#1548 philosophy)', () => {
    // "Facilitator's" is a prefix of two question labels. An ambiguous
    // matcher attributes to nothing — the probe does not pick by
    // enumeration order.
    const anchor = "[\\\\s\\\\S]*Facilitator's[\\\\s\\\\S]*";
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(anchor))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeUndefined();
  });

  it('does NOT flag a bare inputText with no below-anchored focus tap (autofocused first field)', () => {
    // CommCare autofocuses the first input of a field-list, so the first
    // value legitimately needs no tap at all. Nothing to check.
    const body = ['- inputText: "Thandiwe Banda"', '- hideKeyboard'].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeUndefined();
  });

  it('does NOT flag a below-anchored tap that is not an input focus tap', () => {
    // `connect-claim-opp.yaml` scopes a View-Opportunity button by
    // `below: text`. No inputText follows, so it is not this class.
    const body = [
      '- tapOn:',
      '    below:',
      `      text: "${LABEL_ANCHOR}"`,
      '- takeScreenshot: after-tap',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeUndefined();
  });

  it('records hint_data_supplied: true when any supplied field carries a hint', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(HINT_ANCHOR))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.observed.hint_data_supplied).toBe(true);
  });
});

describe('probeRecipeSanity — failure class: input-focus-scroll-is-guarded (ace#1554/#1299)', () => {
  it('flags a `when: notVisible: <anchor>` guard around the input focus scroll', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(HINT_ANCHOR, { guarded: true }))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    const f = verdict.failures.find((x) => x.class === 'input-focus-scroll-is-guarded');
    expect(f).toBeDefined();
    expect(f!.recipe).toBe('journey-deliver.yaml');
    expect(f!.detail).toMatch(/notVisible/);
    expect(f!.remediation).toMatch(/unconditional/i);
    expect(verdict.ok).toBe(false);
  });

  it('does NOT flag the sanctioned UNCONDITIONAL centring scroll — non-vacuity control', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(HINT_ANCHOR))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-focus-scroll-is-guarded')).toBeUndefined();
  });

  it('does NOT flag when an unconditional scroll for the anchor ALSO precedes the tap', () => {
    // A stray guarded scroll is harmless as long as the needed
    // unconditional one fires too — the defect is a guard that SUPPRESSES
    // the only scroll, not the presence of a guard anywhere.
    const guardOnly = [
      '- runFlow:',
      '    when:',
      '      notVisible:',
      `        text: "${HINT_ANCHOR}"`,
      '    commands:',
      '      - scrollUntilVisible:',
      '          element:',
      `            text: "${HINT_ANCHOR}"`,
    ].join('\n');
    const body = [guardOnly, inputWalk(HINT_ANCHOR)].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-focus-scroll-is-guarded')).toBeUndefined();
  });

  it('does NOT flag a GUARDED scroll on an OPTION tap — ace#1070 stands there', () => {
    // The discriminator is whether the anchor IS the tap target. For an
    // option it is, so the guard is correct and must never be flagged.
    const body = [
      '- runFlow:',
      '    when:',
      '      notVisible:',
      '        text: "Yes"',
      '    commands:',
      '      - scrollUntilVisible:',
      '          element:',
      '            text: "Yes"',
      '- tapOn:',
      '    text: "Yes"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-focus-scroll-is-guarded')).toBeUndefined();
  });

  it('does NOT flag when there is NO scroll at all — that is a different class', () => {
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(HINT_ANCHOR, { noScroll: true }))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-focus-scroll-is-guarded')).toBeUndefined();
  });

  it('fires without any Nova field data — the guard defect is pure recipe shape', () => {
    // Independent of the hint check: #1299 says the guard half affected
    // all 14 inputs, hint-carrying or not.
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(HINT_ANCHOR, { guarded: true }))],
      novaApps: [HEALTHY_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-focus-scroll-is-guarded')).toBeDefined();
  });

  it('does NOT flag a guarded scroll whose target is a DIFFERENT element from the anchor', () => {
    // Silence under uncertainty: the guard must name the same anchor the
    // focus tap uses before the "structurally blind" analysis applies.
    const body = [
      '- runFlow:',
      '    when:',
      '      notVisible:',
      '        text: "Some other element"',
      '    commands:',
      '      - scrollUntilVisible:',
      '          element:',
      '            text: "Some other element"',
      '- tapOn:',
      '    below:',
      `      text: "${HINT_ANCHOR}"`,
      '- inputText: "0991234567"',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-focus-scroll-is-guarded')).toBeUndefined();
  });
});

describe('probeRecipeSanity — ace#1554 healthy field-list walk stays clean', () => {
  it('passes the full SKILL.md-sanctioned single-screen walk', () => {
    // Autofocused first input (bare inputText), then hint-anchored
    // unconditional scroll + below-tap for the second, then ONE advance.
    const body = [
      '- inputText: "Thandiwe Banda"',
      '- hideKeyboard',
      inputWalk(HINT_ANCHOR),
      '- runFlow:',
      '    file: form-advance.yaml',
    ].join('\n');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', body)],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.map((f) => f.class)).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

describe('probeRecipeSanity — ace#1554 anchor spelling', () => {
  // The probe reads RAW recipe bytes. `\s` is not a legal escape in a YAML
  // double-quoted scalar, so the idiom skills/app-test-cases emits is
  // `"[\\s\\S]*<anchor>[\\s\\S]*"` — TWO backslashes on disk (the spelling
  // every other case in this block uses). The shared RECIPE_WILDCARD_SRC
  // recognises only the one-backslash form, which would have left both
  // ace#1554 checks structurally unable to fire on any real recipe. Pin
  // both spellings so neither can regress into a green no-op.

  it('flags the two-backslash spelling app-test-cases actually emits', () => {
    expect(LABEL_ANCHOR).toContain('[\\\\s\\\\S]*');
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(LABEL_ANCHOR))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeDefined();
  });

  it('flags the one-backslash spelling too', () => {
    const anchor = "[\\s\\S]*Facilitator's phone number[\\s\\S]*";
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(anchor))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeDefined();
  });

  it('flags a bare literal anchor with no wildcards at all', () => {
    const anchor = "Facilitator's phone number";
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(anchor))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeDefined();
  });

  it('stays silent on a bare literal anchor that matches no field exactly', () => {
    // A bare matcher must match the label EXACTLY (ace#1548). A prefix
    // that does not is no evidence about which field this is.
    const anchor = "Facilitator's phone";
    const verdict = probeRecipeSanity({
      recipes: [recipeBody('journey-deliver.yaml', inputWalk(anchor))],
      novaApps: [HINTED_DELIVER_APP],
      connectOpp: LIVE_OPP,
    });
    expect(verdict.failures.find((x) => x.class === 'input-anchor-skips-hint')).toBeUndefined();
  });
});
