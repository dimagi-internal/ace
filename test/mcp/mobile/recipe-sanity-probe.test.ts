import { describe, it, expect } from 'vitest';
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
