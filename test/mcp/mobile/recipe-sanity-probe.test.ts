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
