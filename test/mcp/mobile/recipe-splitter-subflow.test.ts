// ---------------------------------------------------------------------------
// dimagi-internal/ace#1570 — nested (subflow) screenshots must be splittable.
//
// ACE's own Phase-3 authoring idiom (skills/app-test-cases/SKILL.md) composes a
// journey almost entirely out of `runFlow: file: <palette>.yaml` steps, and
// EVERY palette in mcp/mobile/recipes/static/ takes its own screenshots. The
// splitter only ever saw TOP-LEVEL `takeScreenshot:` steps, so a whole Learn
// journey collapsed to `chunk 1/1`: one Maestro invocation, one watchdog
// budget, and one UI dump (the failure one) for the entire walk.
//
// Live consequence on hh-poverty-targeting/20260819-1435: a 97-step Learn
// journey ran as a single chunk, was killed by the then-flat 600s watchdog
// while still advancing, and permanently consumed the one-way Learn
// precondition for that (test user, opportunity) — the only restore being a
// fresh `/ace:run`.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseAllDocuments } from 'yaml';
import {
  splitRecipeAtScreenshots,
  describeSubflowScreenshots,
} from '../../../mcp/mobile/recipe-splitter.js';
import { subflowResolverFor, SUBFLOW_SPLIT_ENV } from '../../../mcp/mobile/backends/maestro.js';

const STATIC = new URL('../../../mcp/mobile/recipes/static/', import.meta.url);

/** Reads the REAL static palette — no hand-written stand-ins. */
const resolveStaticSubflow = (filename: string): string | null => {
  try {
    return readFileSync(new URL(filename.replace(/^\.\//, ''), STATIC), 'utf8');
  } catch {
    return null;
  }
};

/** The Learn journey shape documented in skills/app-test-cases/SKILL.md. */
const JOURNEY_LEARN = `appId: org.commcare.dalvik
---
- runFlow:
    file: learn-launch.yaml
- runFlow:
    file: learn-tap-module.yaml
    env:
      MODULE_NAME: "1. Program Orientation"
      FORM_NAME: "Program Orientation"
- runFlow:
    file: content-form-finish.yaml
    env:
      SCREENSHOT_NAME: "journey-learn-m0-orientation-finished"
- runFlow:
    file: learn-suite-reentry.yaml
- runFlow:
    file: learn-tap-module.yaml
    env:
      MODULE_NAME: "2. Module 1 Quiz"
      FORM_NAME: "Module 1 Quiz"
- tapOn:
    text: "Yes"
- runFlow:
    file: form-advance.yaml
    env:
      SCREENSHOT_NAME: "journey-learn-m1-q2"
- tapOn:
    text: "No"
- runFlow:
    file: form-submit.yaml
    env:
      SCREENSHOT_NAME_PRE_SUBMIT: "journey-learn-result"
      SCREENSHOT_NAME_POST_SUBMIT: "journey-learn-submitted"
`;

describe('recipe-splitter — nested subflow screenshots (ace#1570)', () => {
  it('collapses a palette-composed journey to one chunk when no resolver is supplied', () => {
    // The pre-fix behaviour, pinned deliberately: with no resolver the splitter
    // cannot see into another file and MUST behave exactly as it did before.
    // That is the seam keeping every existing caller and test unaffected.
    const chunks = splitRecipeAtScreenshots(JOURNEY_LEARN);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].screenshotName).toBeUndefined();
  });

  it('splits a palette-composed journey once a subflow resolver is supplied', () => {
    const chunks = splitRecipeAtScreenshots(JOURNEY_LEARN, {
      resolveSubflow: resolveStaticSubflow,
    });
    expect(chunks.length).toBeGreaterThan(1);
    const names = chunks.map((c) => c.screenshotName).filter(Boolean) as string[];
    // Caller-bound names come through verbatim — the dump has to pair with the
    // PNG Maestro writes from that very same env binding.
    expect(names).toContain('journey-learn-m0-orientation-finished');
    expect(names).toContain('journey-learn-m1-q2');
    expect(names).toContain('journey-learn-result');
    expect(names).toContain('journey-learn-submitted');
    // Palettes with hard-coded names contribute those too.
    expect(names).toContain('learn-launch-suite-root');
    expect(names).toContain('learn-suite-reentry-suite-root');
    expect(new Set(names).size).toBe(names.length);
  });

  it('places a leading-screenshot boundary BEFORE the runFlow that captures it', () => {
    // form-advance.yaml screenshots FIRST and taps second (ace#1291), so the
    // dump window pairing with that PNG is the one BEFORE the subflow runs.
    // The chunk carrying the name must therefore NOT contain the runFlow.
    const chunks = splitRecipeAtScreenshots(JOURNEY_LEARN, {
      resolveSubflow: resolveStaticSubflow,
    });
    const q2 = chunks.find((c) => c.screenshotName === 'journey-learn-m1-q2');
    expect(q2).toBeDefined();
    expect(q2!.yaml).not.toContain('journey-learn-m1-q2');
  });

  it('collapses a trailing boundary meeting a leading one into a single window', () => {
    // `learn-tap-module` ends on the form's first question and the
    // `form-advance` that follows screenshots that same question before
    // tapping. Nothing runs in between, so a second dump there would
    // photograph the identical surface at the full cost of an extra
    // `maestro test` invocation. One window, named for the earlier PNG.
    const back_to_back = `appId: org.commcare.dalvik
---
- runFlow:
    file: learn-tap-module.yaml
    env:
      MODULE_NAME: "M"
      FORM_NAME: "F"
- runFlow:
    file: form-advance.yaml
    env:
      SCREENSHOT_NAME: "q1"
- tapOn: "Done"
`;
    const names = splitRecipeAtScreenshots(back_to_back, { resolveSubflow: resolveStaticSubflow })
      .map((c) => c.screenshotName)
      .filter(Boolean);
    expect(names).toEqual(['learn-tap-module-after-M']);
  });

  it('places a trailing-screenshot boundary AFTER the runFlow that captures it', () => {
    // form-submit.yaml's LAST top-level step screenshots the post-submit
    // surface, so that dump belongs to the chunk that ran the subflow.
    const chunks = splitRecipeAtScreenshots(JOURNEY_LEARN, {
      resolveSubflow: resolveStaticSubflow,
    });
    const post = chunks.find((c) => c.screenshotName === 'journey-learn-submitted');
    expect(post).toBeDefined();
    expect(post!.yaml).toContain('form-submit.yaml');
  });

  it('never emits a chunk with no steps, and every chunk parses', () => {
    const chunks = splitRecipeAtScreenshots(JOURNEY_LEARN, {
      resolveSubflow: resolveStaticSubflow,
    });
    for (const c of chunks) {
      const flow = c.yaml.split(/^---\s*$/m)[1] ?? '';
      expect(
        flow.split('\n').some((l) => /^-\s+\S/.test(l)),
        `chunk ${c.index} (${c.screenshotName ?? 'unnamed'}) has no top-level step`,
      ).toBe(true);
      for (const doc of parseAllDocuments(c.yaml)) {
        expect(doc.errors, `chunk ${c.index} parse errors`).toEqual([]);
      }
    }
  });

  it('leaves a boundary unnamed rather than emitting an unresolved placeholder', () => {
    // An unbound call site (which `mobile_validate_recipe` rejects at authoring
    // time anyway) must never produce a literal `${SCREENSHOT_NAME}.xml`.
    const unbound = `appId: org.commcare.dalvik
---
- tapOn: "Start"
- runFlow:
    file: form-advance.yaml
- tapOn: "Done"
`;
    const chunks = splitRecipeAtScreenshots(unbound, { resolveSubflow: resolveStaticSubflow });
    for (const c of chunks) {
      expect(c.screenshotName ?? '').not.toContain('${');
    }
  });

  it('ignores an inline runFlow (when/commands) — those stay atomic', () => {
    const inline = `appId: org.commcare.dalvik
---
- tapOn: "Start"
- runFlow:
    when:
      visible:
        id: "x"
    commands:
      - takeScreenshot: "nested-inline"
      - tapOn: "y"
- tapOn: "Done"
`;
    const chunks = splitRecipeAtScreenshots(inline, { resolveSubflow: resolveStaticSubflow });
    expect(chunks).toHaveLength(1);
  });

  it('ignores a runFlow whose file cannot be resolved', () => {
    const missing = `appId: org.commcare.dalvik
---
- tapOn: "Start"
- runFlow:
    file: not-a-real-palette.yaml
- tapOn: "Done"
`;
    const chunks = splitRecipeAtScreenshots(missing, { resolveSubflow: resolveStaticSubflow });
    expect(chunks).toHaveLength(1);
  });
});

describe('recipe-splitter — every static palette is split-visible (ace#1570 preventer)', () => {
  // The regression class is "a palette takes screenshots the splitter cannot
  // see, so chunking silently switches off for every journey that calls it."
  // This pins the boundary contract of the REAL palette, file by file: move
  // where a palette screenshots, or add a palette that screenshots somewhere
  // the splitter can't act on, and this test names it instead of a Phase 6
  // Learn leg discovering it by burning a run.
  const EXPECTED: Record<string, { leading?: string; trailing?: string }> = {
    'connect-claim-opp.yaml': { trailing: 'claim-opp-handoff-learn-home' },
    'connect-login.yaml': { trailing: 'connect-login-home' },
    'connect-register-from-otp.yaml': {},
    'connect-register-to-otp.yaml': {},
    'connect-resume-opp.yaml': { trailing: 'connect-resume-opp-landed' },
    'content-form-finish-to-suite.yaml': { trailing: '${SCREENSHOT_NAME}' },
    'content-form-finish.yaml': { trailing: '${SCREENSHOT_NAME}' },
    'deliver-case-select.yaml': { trailing: 'deliver-case-select-selected' },
    // ace#1651: the fixed captures carry a per-invocation `${WALK_LABEL}`
    // discriminator, so the trailing NAME TEMPLATE (which is what the splitter
    // records) now includes it. Unbound it expands to the empty string, so the
    // frame on disk is unchanged for a single-invocation caller.
    'deliver-form-walk.yaml': { trailing: 'deliver-form-walk-form-question${WALK_LABEL}' },
    'deliver-launch.yaml': { trailing: 'deliver-launch-home' },
    'deliver-sync.yaml': {
      leading: 'deliver-sync-pre',
      trailing: 'deliver-sync-visit-registered',
    },
    'form-advance.yaml': { leading: '${SCREENSHOT_NAME}' },
    'form-submit.yaml': {
      leading: '${SCREENSHOT_NAME_PRE_SUBMIT}',
      trailing: '${SCREENSHOT_NAME_POST_SUBMIT}',
    },
    'learn-launch.yaml': { trailing: 'learn-launch-suite-root' },
    'learn-suite-reentry-from-module.yaml': {
      trailing: 'learn-suite-reentry-from-module-suite-root',
    },
    'learn-suite-reentry.yaml': { trailing: 'learn-suite-reentry-suite-root' },
    // No leading entry: learn-tap-module opens with an `extendedWaitUntil`,
    // so the surface at a parent boundary need not yet be the one its
    // screenshot captures. Conservative by design — see SCREEN_NEUTRAL_STEPS.
    'learn-tap-module.yaml': { trailing: 'learn-tap-module-after-${MODULE_NAME}' },
  };

  it('pins the leading/trailing screenshot contract of every palette file', () => {
    const actual: Record<string, { leading?: string; trailing?: string }> = {};
    for (const name of readdirSync(STATIC)
      .filter((f) => f.endsWith('.yaml'))
      .sort()) {
      const c = describeSubflowScreenshots(readFileSync(new URL(name, STATIC), 'utf8'));
      actual[name] = {
        ...(c.leading ? { leading: c.leading } : {}),
        ...(c.trailing ? { trailing: c.trailing } : {}),
      };
    }
    expect(actual).toEqual(EXPECTED);
  });

  it('is wired through the production resolver seam', () => {
    // The splitter is pure; `subflowResolverFor` is what makes it see the
    // palette on a real run. Staged on disk the way `prepareRecipeForMaestro`
    // stages it: palette files as siblings of the resolved recipe.
    const dir = mkdtempSync(join(tmpdir(), 'ace-subflow-wire-'));
    writeFileSync(join(dir, 'form-advance.yaml'), readFileSync(new URL('form-advance.yaml', STATIC)));
    const recipe = join(dir, 'journey.yaml');
    const body = `appId: org.commcare.dalvik
---
- tapOn: "Start"
- runFlow:
    file: form-advance.yaml
    env:
      SCREENSHOT_NAME: "q1"
- tapOn: "Done"
`;
    writeFileSync(recipe, body, 'utf8');
    const chunks = splitRecipeAtScreenshots(body, {
      resolveSubflow: subflowResolverFor(recipe, {}),
    });
    expect(chunks.map((c) => c.screenshotName).filter(Boolean)).toEqual(['q1']);
  });

  it('makes a one-runFlow parent chunkable for every screenshot-taking palette', () => {
    for (const [name, contract] of Object.entries(EXPECTED)) {
      if (!contract.leading && !contract.trailing) continue;
      const parent = `appId: org.commcare.dalvik\n---\n- tapOn: "Start"\n- runFlow:\n    file: ${name}\n- tapOn: "Done"\n`;
      const chunks = splitRecipeAtScreenshots(parent, { resolveSubflow: resolveStaticSubflow });
      expect(chunks.length, `${name} did not open a chunk boundary`).toBeGreaterThan(1);
    }
  });
});

describe('subflowResolverFor — the production seam', () => {
  const stage = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-subflow-resolver-'));
    writeFileSync(join(dir, 'journey.yaml'), 'appId: x\n---\n- tapOn: "a"\n', 'utf8');
    writeFileSync(join(dir, 'form-advance.yaml'), 'appId: x\n---\n- takeScreenshot: "s"\n', 'utf8');
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'deep.yaml'), 'appId: x\n---\n- tapOn: "b"\n', 'utf8');
    return { dir, recipe: join(dir, 'journey.yaml') };
  };

  it('reads a palette sibling of the resolved recipe', () => {
    const { recipe } = stage();
    const resolve = subflowResolverFor(recipe, {});
    expect(resolve).toBeDefined();
    expect(resolve!('form-advance.yaml')).toContain('takeScreenshot');
    expect(resolve!('./form-advance.yaml')).toContain('takeScreenshot');
  });

  it('refuses anything outside the recipe directory, and the recipe itself', () => {
    const { recipe } = stage();
    const resolve = subflowResolverFor(recipe, {})!;
    expect(resolve('../escape.yaml')).toBeNull();
    expect(resolve('/etc/hosts')).toBeNull();
    expect(resolve('nested/deep.yaml')).toBeNull();
    expect(resolve('journey.yaml')).toBeNull();
    expect(resolve('absent.yaml')).toBeNull();
  });

  it('is disarmed by the kill switch, restoring pre-ace#1570 splitting', () => {
    const { recipe } = stage();
    expect(subflowResolverFor(recipe, { [SUBFLOW_SPLIT_ENV]: 'off' })).toBeUndefined();
    expect(subflowResolverFor(recipe, { [SUBFLOW_SPLIT_ENV]: ' OFF ' })).toBeUndefined();
    // Anything else leaves it armed — a typo must not silently disable
    // chunking, which is the very failure ace#1570 is about.
    expect(subflowResolverFor(recipe, { [SUBFLOW_SPLIT_ENV]: 'no' })).toBeDefined();
    expect(subflowResolverFor(recipe, { [SUBFLOW_SPLIT_ENV]: '' })).toBeDefined();
  });
});
