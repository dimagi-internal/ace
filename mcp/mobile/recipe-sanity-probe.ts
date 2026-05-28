// mcp/mobile/recipe-sanity-probe.ts
//
// Static pre-flight: compare what a smoke recipe EXPECTS against what
// the live Nova app + Connect opportunity actually have, before booting
// the AVD or running any recipe. The probe is pure-data — callers pass
// in already-fetched Nova / Connect responses; this module compares
// them against parsed recipe parameters and returns a structured
// verdict the skill (or operator) can act on.
//
// Why: today's Phase 6 retry loop (turmeric 20260515-0536) surfaced 8
// distinct failure classes one-at-a-time, each costing ~10-12 min
// wall-clock per attempt. A static probe would have caught attempts
// #5 (wrong-opp-claimed) and #7 (module-name == form-name) at attempt
// #1. The recipe-error → failure-mode table in
// `skills/app-screenshot-capture/SKILL.md § Step 5` is the runtime
// second-line classifier; this is the pre-flight first-line one.
//
// Scope discipline:
//   * Pure data in, structured verdict out — NO MCP calls, NO process
//     side-effects. The skill (or its caller) is responsible for
//     fetching the Nova app + Connect opp via `nova_get_app` /
//     `connect_get_opportunity` and passing them in.
//   * No tile-list classification yet — the probe accepts an OPTIONAL
//     pre-captured tile list (from `mobile_capture_ui_dump` after a
//     quick login) and checks for prefix collisions. Skipping the
//     ui-dump just means the `tile-name-collision` class isn't
//     surfaced; everything else still runs.
//   * Detection only, no remediation execution. The verdict names the
//     remediation command per failure class; the operator runs it.

import { parseAllDocuments } from 'yaml';

/** Failure classes the probe can surface. Stable strings — telemetry
 * and the SKILL.md remediation table reference them by name. */
export type SanityFailureClass =
  | 'module-name-equals-form-name'
  | 'expected-module-not-in-app'
  | 'expected-form-not-in-module'
  | 'tile-name-collision'
  | 'opp-name-mismatch'
  | 'form-advance-without-answer-tap'
  | 'brief-label-drift'
  | 'deliver-smoke-rewalks-learn';

export interface SanityFailure {
  class: SanityFailureClass;
  /** Human-readable detail. Stable enough to grep for. */
  detail: string;
  /** Single canonical remediation command/action. */
  remediation: string;
  /** Which recipe + parameter triggered the failure (when applicable). */
  recipe?: string;
  parameter?: string;
  value?: string;
}

export interface SanityVerdict {
  /** Overall pass/fail. Pass iff `failures` is empty. */
  ok: boolean;
  /** Each failure carries its class + canonical remediation. */
  failures: SanityFailure[];
  /** Echo of what the probe found, for the verdict YAML. */
  observed: {
    /** Distinct module names referenced across all parsed recipes. */
    recipe_module_names: string[];
    /** Distinct form names referenced across all parsed recipes. */
    recipe_form_names: string[];
    /** Canonical OPP_NAME from connect_get_opportunity (or null). */
    live_opp_name: string | null;
    /** OPP_NAME the recipe expects (from envVars / parameters). */
    recipe_opp_name: string | null;
  };
}

/** Minimal Nova app shape the probe consumes. Matches the relevant
 * subset of what `nova_get_app` returns. Keeping it minimal so the
 * probe doesn't get coupled to Nova's full app schema. */
export interface NovaAppSlice {
  app_id: string;
  modules: {
    module_name: string;
    forms: { form_name: string }[];
  }[];
}

/** Minimal Connect opportunity shape the probe consumes. */
export interface ConnectOpportunitySlice {
  /** Display-name the user sees on their Connect tile list. */
  display_name: string;
}

export interface RecipeText {
  /** Recipe identifier (e.g. "J1a.yaml") used in failure reports. */
  name: string;
  /** Raw YAML text. */
  text: string;
}

export interface ProbeInputs {
  /** Smoke recipes parsed for parameter extraction. */
  recipes: RecipeText[];
  /** The Nova app(s) the recipes target. Keyed by some operator-known
   * label (e.g. "learn" / "deliver") — the probe doesn't care what the
   * keys are, only that every recipe-referenced module/form lives in
   * at least one of them. */
  novaApps: NovaAppSlice[];
  /** Live Connect opp (from `connect_get_opportunity`). */
  connectOpp: ConnectOpportunitySlice;
  /** OPP_NAME the recipe was authored against (from the recipe's
   * envVars block or app-test-cases.yaml). If null, opp-name-mismatch
   * detection is skipped. */
  recipeOppName?: string | null;
  /** Optional: display names of the test user's currently-visible
   * tiles (from `mobile_capture_ui_dump` after login). If absent,
   * tile-name-collision detection is skipped. */
  visibleTiles?: string[];
}

/**
 * Static pre-flight probe. Pure function — same inputs always produce
 * the same verdict. No MCP calls, no env reads, no fs access.
 */
export function probeRecipeSanity(inputs: ProbeInputs): SanityVerdict {
  const failures: SanityFailure[] = [];
  const recipeModuleNames = new Set<string>();
  const recipeFormNames = new Set<string>();

  for (const recipe of inputs.recipes) {
    const params = extractRecipeParameters(recipe);

    for (const moduleName of params.moduleNames) {
      recipeModuleNames.add(moduleName);
    }
    for (const formName of params.formNames) {
      recipeFormNames.add(formName);
    }

    // 6. form-advance-without-answer-tap → consecutive form-advance
    // steps (runFlow: form-advance.yaml OR form-nav-next selector tap
    // OR id: nav_btn_next tap) with no answer step (tapOn:text/index/
    // id, inputText) between them. Catches the malaria-rdt 20260522
    // class where required-input quiz questions were skipped, stalling
    // the recipe on `warning_root` ("Sorry, this response is required").
    // Single form-advance with no preceding answer is legitimate (info
    // screens) — only flag chains of ≥ 2 where the antipattern is
    // unambiguous.
    const advanceChain = findFormAdvanceChain(recipe.text);
    if (advanceChain) {
      failures.push({
        class: 'form-advance-without-answer-tap',
        detail: `recipe ${recipe.name} chains ${advanceChain.count} consecutive form-advance steps starting at line ${advanceChain.firstLine} with no answer-selection step (tapOn:text/index/id or inputText) between them — required-input questions will stall on warning_root`,
        remediation: `for each required field between these advances, read its label/options via Nova get_form and emit a tapOn:text:"<literal option label>" (or inputText for kind:text/decimal, photo-capture sequence for kind:image) BEFORE the form-advance step`,
        recipe: recipe.name,
        parameter: 'form-advance-chain',
        value: String(advanceChain.count),
      });
    }

    // 7. brief-label-drift → a tapOn:text matcher uses a PDD brief-
    // style prefix (L<n>, F<n>, M<n>, Stage <n> followed by a dash)
    // that Nova rewrites into a different live label during autobuild.
    // Catches the #115 finding-2 class deterministically.
    const briefLabels = findBriefStyleTapOnLabels(recipe.text);
    for (const { label, line } of briefLabels) {
      failures.push({
        class: 'brief-label-drift',
        detail: `recipe ${recipe.name} has tapOn:text:"${label}" (line ${line}) which matches a PDD-brief naming pattern (^[LFM]\\d+ or ^Stage \\d+) — Nova's autobuild rewrites these labels and the matcher will not resolve on the live screen`,
        remediation: `read the live label from Nova get_form/get_module and use it verbatim in the matcher (per skills/app-test-cases/SKILL.md § Use live labels from Nova)`,
        recipe: recipe.name,
        parameter: 'tapOn:text',
        value: label,
      });
    }

    // 1. module-name == form-name → the intermediate-list edge case
    // PR #331 handled in v0.13.255. Recipes authored before that fix
    // are flagged so the operator knows to re-run with a current
    // palette or accept the (now-handled) intermediate list.
    for (const moduleName of params.moduleNames) {
      if (params.formNames.has(moduleName)) {
        failures.push({
          class: 'module-name-equals-form-name',
          detail: `recipe ${recipe.name} parameterizes both MODULE_NAME and FORM_NAME with "${moduleName}" — Connect renders an intermediate list when the names collide`,
          remediation: `verify ace plugin >= 0.13.255 (handled by learn-tap-module); if older, re-author the recipe via /ace:step app-test-cases`,
          recipe: recipe.name,
          parameter: 'MODULE_NAME==FORM_NAME',
          value: moduleName,
        });
      }
    }

    // 2. expected-module-not-in-app → recipe references a module name
    // that doesn't exist in any of the provided Nova apps.
    const allModuleNames = new Set<string>();
    const moduleToForms = new Map<string, Set<string>>();
    for (const app of inputs.novaApps) {
      for (const mod of app.modules) {
        allModuleNames.add(mod.module_name);
        if (!moduleToForms.has(mod.module_name)) {
          moduleToForms.set(mod.module_name, new Set());
        }
        const formSet = moduleToForms.get(mod.module_name)!;
        for (const f of mod.forms) {
          formSet.add(f.form_name);
        }
      }
    }

    for (const moduleName of params.moduleNames) {
      if (!allModuleNames.has(moduleName)) {
        failures.push({
          class: 'expected-module-not-in-app',
          detail: `recipe ${recipe.name} references MODULE_NAME "${moduleName}" but no Nova app has a module with that name (apps checked: ${inputs.novaApps.map(a => a.app_id).join(', ')})`,
          remediation: `recipe needs re-author via /ace:step app-test-cases — the live app structure has drifted from what the recipe expects`,
          recipe: recipe.name,
          parameter: 'MODULE_NAME',
          value: moduleName,
        });
      }
    }

    // 3. expected-form-not-in-module → recipe references a form name
    // that exists in some module, but not in the module the recipe
    // names. Only check when MODULE_NAME resolves to a known module.
    for (const moduleName of params.moduleNames) {
      const knownForms = moduleToForms.get(moduleName);
      if (!knownForms) continue;
      for (const formName of params.formNames) {
        if (!knownForms.has(formName)) {
          failures.push({
            class: 'expected-form-not-in-module',
            detail: `recipe ${recipe.name} references FORM_NAME "${formName}" inside module "${moduleName}" but that form is not present in the module (forms in module: ${[...knownForms].join(', ')})`,
            remediation: `recipe needs re-author via /ace:step app-test-cases — module/form structure has drifted`,
            recipe: recipe.name,
            parameter: 'FORM_NAME',
            value: formName,
          });
        }
      }
    }

    // 8. deliver-smoke-rewalks-learn → a journey-deliver recipe that
    // re-walks Learn. Post-decoupling the journey-learn leg walks Learn
    // to completion and unlocks Deliver; the Deliver leg must only
    // resume from the unlocked state (connect-resume-opp ->
    // deliver-launch). A Deliver recipe that re-walks Learn is the
    // pre-decoupling monolith antipattern (the leep 20260527 J2 class).
    // Match only non-comment lines — composed recipes carry header
    // comments (and commented-out steps) that may reference
    // learn-launch / learn-tap-module descriptively; a commented mention
    // is not a re-walk. Mirrors the `^\s*#` skipping the
    // brief-label-drift + form-advance-chain checks already use.
    if (/^journey-deliver/.test(recipe.name)) {
      const stepLines = recipe.text
        .split('\n')
        .filter((l) => !/^\s*#/.test(l));
      const learnLaunches = stepLines.filter((l) => /file:\s*learn-launch\.yaml/.test(l)).length;
      const learnTaps = stepLines.filter((l) => /file:\s*learn-tap-module\.yaml/.test(l)).length;
      if (learnLaunches > 0 || learnTaps >= 2) {
        failures.push({
          class: 'deliver-smoke-rewalks-learn',
          detail: `deliver recipe ${recipe.name} contains a Learn walk (learn-launch x${learnLaunches}, learn-tap-module x${learnTaps}) — post-decoupling the journey-learn leg completes Learn; the Deliver leg must resume from the unlocked state via deliver-launch.yaml only`,
          remediation: `re-compose the Deliver smoke as: connect-resume-opp -> runFlow deliver-launch.yaml -> first Deliver form. Remove the Learn-walk steps (journey-learn handles Learn completion).`,
          recipe: recipe.name,
          parameter: 'learn-walk-in-deliver',
          value: `learn-launch=${learnLaunches},learn-tap-module=${learnTaps}`,
        });
      }
    }
  }

  // 4. opp-name-mismatch → recipe was authored against a synthesized
  // OPP_NAME that doesn't match the live Connect opp's display_name.
  // Only check when the caller provided a recipeOppName.
  const recipeOppName = inputs.recipeOppName ?? null;
  if (recipeOppName !== null && recipeOppName !== inputs.connectOpp.display_name) {
    failures.push({
      class: 'opp-name-mismatch',
      detail: `recipe expects OPP_NAME "${recipeOppName}" but Connect opp display_name is "${inputs.connectOpp.display_name}"`,
      remediation: `pass OPP_NAME="${inputs.connectOpp.display_name}" explicitly in envVars, OR resolve from connect_get_opportunity at recipe-run time`,
      parameter: 'OPP_NAME',
      value: recipeOppName,
    });
  }

  // 5. tile-name-collision → multiple visible tiles share a prefix
  // with the target opp name. Only check when caller passed
  // visibleTiles. "Shares a prefix" = first 8 chars match (Connect's
  // tile labels truncate visually around there).
  if (inputs.visibleTiles && inputs.visibleTiles.length > 0) {
    const targetName = inputs.connectOpp.display_name;
    const targetPrefix = targetName.slice(0, 8).toLowerCase();
    const collisions = inputs.visibleTiles.filter(
      (t) => t !== targetName && t.slice(0, 8).toLowerCase() === targetPrefix,
    );
    if (collisions.length > 0) {
      failures.push({
        class: 'tile-name-collision',
        detail: `${collisions.length} other tile(s) share the first-8-char prefix "${targetPrefix}" with target opp "${targetName}": ${collisions.join(', ')}`,
        remediation: `clean up prior-run invites from the test user OR ensure the recipe uses the Resume-branch (claims the opp by exact match, not prefix scan)`,
      });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    observed: {
      recipe_module_names: [...recipeModuleNames].sort(),
      recipe_form_names: [...recipeFormNames].sort(),
      live_opp_name: inputs.connectOpp.display_name,
      recipe_opp_name: recipeOppName,
    },
  };
}

/** Extract the MODULE_NAME / FORM_NAME values a recipe binds. Looks at
 * the recipe's `env:` block (`appId.env`) and `${MODULE_NAME}` /
 * `${FORM_NAME}` substring references. Returns sets — a single recipe
 * may bind multiple module/form names across its steps. */
export function extractRecipeParameters(recipe: RecipeText): {
  moduleNames: Set<string>;
  formNames: Set<string>;
} {
  const moduleNames = new Set<string>();
  const formNames = new Set<string>();

  // Parse the YAML. Maestro recipes ALMOST ALWAYS use multi-document
  // form (`appId + env` as doc 1, step list as doc 2 after `---`), so
  // we must use `parseAllDocuments`. The env block lives in the first
  // document; later docs are step lists we ignore for parameter
  // extraction.
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(recipe.text);
  } catch {
    return { moduleNames, formNames };
  }

  for (const doc of docs) {
    const parsed = doc.toJS();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const env = (parsed as Record<string, unknown>).env;
      if (env && typeof env === 'object') {
        const envMap = env as Record<string, unknown>;
        if (typeof envMap.MODULE_NAME === 'string') moduleNames.add(envMap.MODULE_NAME);
        if (typeof envMap.FORM_NAME === 'string') formNames.add(envMap.FORM_NAME);
      }
    }
  }

  return { moduleNames, formNames };
}

/** Step-kind classification for the form-advance-chain walker. */
type StepKind =
  | 'form-advance'   // any of: runFlow form-advance.yaml | tapOn form-nav-next selector | tapOn nav_btn_next id
  | 'answer'         // tapOn:text/index/id OR inputText
  | 'other';         // launchApp, runFlow other, takeScreenshot, extendedWaitUntil, etc.

/** Classify a single step's first non-blank, non-comment line text.
 * Conservative — anything ambiguous returns 'other'. */
function classifyStepBlock(stepText: string): StepKind {
  const lower = stepText.toLowerCase();
  // form-advance forms (these are mutually exclusive with answer steps,
  // and chaining them is the documented antipattern).
  if (/file:\s*form-advance\.yaml/.test(stepText)) return 'form-advance';
  if (/\$\{selector:form-nav-next\}/i.test(stepText)) return 'form-advance';
  if (/id:\s*["']?[^"'\n]*:id\/nav_btn_next["']?/.test(stepText)) return 'form-advance';
  // answer steps — tapOn (text/index/id, but NOT form-advance forms
  // already caught above) OR inputText (scalar or mapping form).
  if (/^\s*-\s+tapOn:/m.test(stepText)) return 'answer';
  if (/^\s*-\s+inputText:/m.test(stepText)) return 'answer';
  return 'other';
}

/** Walk a recipe's step list and return the first chain of ≥ 2
 * consecutive form-advance steps with no answer step between them.
 * Returns null when no such chain exists. */
function findFormAdvanceChain(
  yaml: string,
): { count: number; firstLine: number } | null {
  // Split into top-level list items by scanning lines for `- ` at the
  // same indent as the first list-item dash. The static palette uses
  // 0-indent dashes; recipes follow suit.
  const lines = yaml.split('\n');
  let dashIndent = -1;
  const items: { text: string; startLine: number }[] = [];
  let current: { text: string; startLine: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const dashMatch = line.match(/^(\s*)-\s/);
    if (dashMatch) {
      const indent = dashMatch[1].length;
      if (dashIndent === -1) dashIndent = indent;
      if (indent === dashIndent) {
        if (current) items.push(current);
        current = { text: line, startLine: i + 1 };
        continue;
      }
    }
    if (current) current.text += '\n' + line;
  }
  if (current) items.push(current);

  // Walk items, tracking consecutive form-advance runs. Reset on any
  // 'answer' kind. 'other' kinds (launchApp, takeScreenshot,
  // extendedWaitUntil, runFlow-not-form-advance) are pass-through —
  // they don't reset the chain (an extendedWaitUntil between two
  // chained form-advances is still the antipattern). The chain breaks
  // only on an explicit answer step.
  let chainCount = 0;
  let chainStartLine = -1;
  for (const item of items) {
    const kind = classifyStepBlock(item.text);
    if (kind === 'form-advance') {
      if (chainCount === 0) chainStartLine = item.startLine;
      chainCount++;
      if (chainCount >= 2) {
        return { count: chainCount, firstLine: chainStartLine };
      }
    } else if (kind === 'answer') {
      chainCount = 0;
      chainStartLine = -1;
    }
  }
  return null;
}

/** Find `tapOn: text: "..."` matchers whose text matches a known PDD-
 * brief naming pattern that Nova rewrites during autobuild. The
 * specific patterns are documented in skills/app-test-cases/SKILL.md
 * § Use live labels from Nova's `get_form` response. */
function findBriefStyleTapOnLabels(
  yaml: string,
): { label: string; line: number }[] {
  const out: { label: string; line: number }[] = [];
  const lines = yaml.split('\n');
  // Match either:
  //   - tapOn: { text: "X" }
  //   - tapOn:
  //       text: "X"
  // We look for `text: "X"` lines that appear after a `tapOn:` opener.
  // Single regex sweep over the whole file is enough for the static-
  // text case (no $vars allowed — those are resolved later).
  const briefPatterns: RegExp[] = [
    /^[LFM]\d+\s*[—\-]\s+\S/, // L0 — Why this matters, F1 - Shop Registration, M1 — Module
    /^Stage\s+\d+\s*[—\-]\s+\S/i, // Stage 1 — Market Analysis
  ];
  let inTapOnBlock = false;
  let tapOnIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    // Inline mapping form: `- tapOn: { text: "..." }` (one line)
    const inline = line.match(/tapOn:\s*\{[^}]*text:\s*["']([^"']+)["']/);
    if (inline) {
      const label = inline[1];
      if (briefPatterns.some((p) => p.test(label))) {
        out.push({ label, line: i + 1 });
      }
      continue;
    }
    // Mapping-form opener: `<indent>- tapOn:` or `<indent>tapOn:` with
    // no value on the same line.
    const tapOnOpen = line.match(/^(\s*)(?:-\s+)?tapOn:\s*$/);
    if (tapOnOpen) {
      inTapOnBlock = true;
      tapOnIndent = tapOnOpen[1].length;
      continue;
    }
    if (inTapOnBlock) {
      // Continue while we're inside the tapOn mapping (deeper indent
      // than the opener). Exit on a shallower-or-equal line.
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      if (line.trim() === '' ) continue;
      if (indent <= tapOnIndent) {
        inTapOnBlock = false;
        // Fall through to re-check this line as a possible new opener.
        i--;
        continue;
      }
      const textMatch = line.match(/^\s*text:\s*["']([^"']+)["']/);
      if (textMatch) {
        const label = textMatch[1];
        if (briefPatterns.some((p) => p.test(label))) {
          out.push({ label, line: i + 1 });
        }
      }
    }
  }
  return out;
}
