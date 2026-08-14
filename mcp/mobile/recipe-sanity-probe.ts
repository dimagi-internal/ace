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
  | 'answer-tap-before-leading-label-advance'
  | 'group-field-list-per-question-walk'
  | 'score-gated-quiz-over-advance'
  | 'brief-label-drift'
  | 'inputtext-geopoint-as-string'
  | 'unguarded-option-tap-below-long-label'
  | 'deliver-smoke-rewalks-learn';

/** Non-blocking caveat classes. A warning NEVER flips `ok` — it names a
 * check that could not RUN, so a clean verdict isn't read as a clean
 * app. Same "configured vs configured *correctly*" gap the
 * `field_data_supplied` flag closes for the screen-shape checks. */
export type SanityWarningClass = 'module-form-checks-not-run';

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

export interface SanityWarning {
  class: SanityWarningClass;
  /** Human-readable detail naming the checks that did NOT run. */
  detail: string;
  /** How to make the un-run check actually run. */
  remediation: string;
  /** Which recipe the caveat applies to (when applicable). */
  recipe?: string;
}

export interface SanityVerdict {
  /** Overall pass/fail. Pass iff `failures` is empty. Warnings do NOT
   * flip it — they qualify a pass, they don't deny one. */
  ok: boolean;
  /** Each failure carries its class + canonical remediation. */
  failures: SanityFailure[];
  /** Non-blocking caveats: checks that were INERT for these inputs.
   * Read them before reporting an unqualified pass (ace#1068). */
  warnings: SanityWarning[];
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
    /** Whether ANY supplied form carried `fields[]`.
     *
     * **Read this before trusting a clean verdict.** When false, the two
     * screen-shape checks did NOT run: the form-advance chain check is
     * field-blind (and false-positives on label-heavy Learn apps), and
     * `group-field-list-per-question-walk` cannot fire at all. A verdict
     * is otherwise byte-identical whether those checks ran or were inert,
     * which is exactly the "configured vs configured *correctly*" gap
     * CLAUDE.md names — so it gets recorded in the verdict YAML. */
    field_data_supplied: boolean;
    /** Longest run of consecutive `label` screens found (0 without field
     * data). The form-advance chain threshold is this + 2. */
    max_label_screen_run: number;
    /** How many Nova `group` field-lists were seen (0 without field
     * data). Zero on an app that HAS groups means the caller passed
     * `fields` without `children[]`. */
    nova_groups_seen: number;
    /** Whether ANY recipe bound a MODULE_NAME the probe could read.
     *
     * **Read this before trusting a clean verdict** — same contract as
     * `field_data_supplied`. When false, `expected-module-not-in-app`
     * and `expected-form-not-in-module` did NOT run for any recipe, and
     * the verdict is byte-identical to one where they ran and passed
     * (ace#1068). The matching `module-form-checks-not-run` warning
     * names the recipe(s). */
    module_form_checks_ran: boolean;
  };
}

/** Minimal Nova FIELD shape the probe consumes — the subset of
 * `nova_get_form().form.fields[]` that determines SCREEN SHAPE.
 *
 * Only three kinds change how CommCare renders a form, and every
 * field-aware check here turns on that distinction:
 *
 * - `hidden`   → renders NO screen at all (calculates only).
 * - `label`    → renders a screen with NOTHING to answer. The only way
 *                past it is a nav-next tap, so consecutive labels
 *                legitimately produce consecutive form-advances.
 * - `group`    → compiles to a CommCare **field-list**: ALL children
 *                (labels + questions) render on ONE scrollable screen,
 *                answered together, then ONE trailing form-advance.
 *
 * Everything else (`single_select`, `text`, `int`, `image`, `geopoint`,
 * …) is one answerable screen each. */
export interface NovaFieldSlice {
  id: string;
  /** Nova field kind verbatim — `label` / `group` / `hidden` /
   * `single_select` / `text` / `int` / `image` / `geopoint` / … */
  kind: string;
  /** Question/label text as it renders on-screen. */
  label?: string;
  /** Select options, when the kind carries them. */
  options?: { label?: string }[];
  /** Relevance condition verbatim, when the field carries one. The probe
   * only reads its PRESENCE (a trailing relevant-gated `label` pair is
   * the score-gated-quiz signature, #569/#1118); it never parses it. */
  relevant?: string;
  /** Present iff `kind === 'group'` — the field-list's children. */
  children?: NovaFieldSlice[];
}

/** Minimal Nova app shape the probe consumes. Matches the relevant
 * subset of what `nova_get_app` returns. Keeping it minimal so the
 * probe doesn't get coupled to Nova's full app schema. */
export interface NovaAppSlice {
  app_id: string;
  modules: {
    module_name: string;
    forms: {
      form_name: string;
      /** Optional. When supplied (from `nova_get_form`), the
       * form-advance-chain check becomes label-aware and the
       * `group-field-list-per-question-walk` check switches on. When
       * absent, both degrade to their prior field-blind behaviour —
       * so existing callers keep working unchanged. */
      fields?: NovaFieldSlice[];
    }[];
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
  const warnings: SanityWarning[] = [];
  const recipeModuleNames = new Set<string>();
  const recipeFormNames = new Set<string>();

  // Screen-shape facts derived once from the Nova structures. All are
  // inert when callers don't supply `fields` (see NovaAppSlice).
  const maxLabelRun = maxConsecutiveLabelScreens(inputs.novaApps);
  const groupScreens = collectGroupScreens(inputs.novaApps);
  const formShapes = collectFormShapes(inputs.novaApps);
  const fieldDataSupplied = inputs.novaApps.some((app) =>
    app.modules.some((mod) => mod.forms.some((form) => form.fields !== undefined)),
  );

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
    //
    // LABEL CARVE-OUT (#858). `label` screens have nothing to answer and
    // can ONLY be crossed by consecutive nav-next taps, so a content-rich
    // Learn app makes a correct recipe look like the antipattern. A walk
    // over N consecutive label screens legitimately reads as a chain of
    // N+1: the advance that LEAVES the last answered screen, then one per
    // label. So the flag threshold is (longest label run) + 2.
    //
    // Deliberate bias: this trades a little recall for precision. A
    // missed chain still fails loud on-device with forensics at the Learn
    // leg; a false positive demands an `incomplete` halt + re-author
    // (SKILL.md Step 2.6) whose remediation is a no-op for label screens,
    // so it loops forever. Blocking beats leaky here.
    //
    // With no field data supplied, maxLabelRun is 0 → threshold 2 →
    // byte-identical to the pre-#858 behaviour.
    const advanceChain = findFormAdvanceChain(recipe.text, maxLabelRun + 2);
    if (advanceChain) {
      failures.push({
        class: 'form-advance-without-answer-tap',
        detail: `recipe ${recipe.name} chains ${advanceChain.count} consecutive form-advance steps starting at line ${advanceChain.firstLine} with no answer-selection step (tapOn:text/index/id or inputText) between them — required-input questions will stall on warning_root${maxLabelRun > 0 ? ` (longest label-screen run in the supplied Nova structure is ${maxLabelRun}, so chains up to ${maxLabelRun + 1} are treated as legitimate label traversal)` : ''}`,
        remediation: `for each required field between these advances, read its label/options via Nova get_form and emit a tapOn:text:"<literal option label>" (or inputText for kind:text/decimal, photo-capture sequence for kind:image) BEFORE the form-advance step`,
        recipe: recipe.name,
        parameter: 'form-advance-chain',
        value: String(advanceChain.count),
      });
    }

    // 6.5 group-field-list-per-question-walk → a Nova `group` compiles
    // to a CommCare field-list: every child renders on ONE scrollable
    // screen. A recipe that advances the form BETWEEN two children of
    // the same group is therefore structurally wrong — it taps nav-next
    // on a screen whose other required children are still unanswered,
    // tripping `warning_root` ("Sorry, this response is required!"), and
    // reaches for options that may be above/below the fold (#862).
    //
    // The signal is deliberately narrow: an advance strictly BETWEEN two
    // matched children of the SAME group. That cannot be legitimate —
    // they are on one screen, so there is nothing to advance to. Counting
    // advances against a screen budget was the wider alternative and was
    // rejected: recipes that walk a form twice (multi-visit Deliver
    // smokes) would false-positive, and #858 is precisely the cost of a
    // careless false positive here.
    const groupWalk = findGroupInternalAdvance(recipe.text, groupScreens);
    if (groupWalk) {
      failures.push({
        class: 'group-field-list-per-question-walk',
        detail: `recipe ${recipe.name} advances the form at line ${groupWalk.line} between two children of the Nova group "${groupWalk.groupId}" ("${groupWalk.firstMatch}" then "${groupWalk.secondMatch}") — a group compiles to a CommCare field-list, so both render on ONE screen and the advance fires with required children still unanswered (warning_root)`,
        remediation: `re-author the group as a single-screen field-list walk via /ace:step app-test-cases: answer every REQUIRED child on the one screen (scrollUntilVisible + tap per select; for label-less EditTexts use a bare below:-scoped tap then inputText), then emit exactly ONE trailing form-advance — never a per-child advance`,
        recipe: recipe.name,
        parameter: 'group-field-list',
        value: groupWalk.groupId,
      });
    }

    // 6.6 unguarded-option-tap-below-long-label → an answer tap on a
    // REQUIRED select sharing a field-list screen with a long read-aloud
    // label, with no scroll guard. The label pushes the options below the
    // fold and the bare tap dies `selector-not-found`. Live:
    // bednet-check-2-visit/20260814-0856 Deliver leg — an ~840-char consent
    // script above `consent_given`, killed the whole leg on its first answer.
    // Field-gated like its siblings: needs `fields` supplied.
    const unguarded = findUnguardedOptionTapBelowLongLabel(recipe.text, groupScreens);
    if (unguarded) {
      failures.push({
        class: 'unguarded-option-tap-below-long-label',
        detail: `recipe ${recipe.name} taps option "${unguarded.matcher}" at line ${unguarded.line} with no preceding scrollUntilVisible — it shares the Nova group "${unguarded.groupId}" (a CommCare field-list, so ONE screen) with a ${unguarded.labelChars}-character label, which pushes the options below the fold`,
        remediation: `guard the tap with a scrollUntilVisible for the same option text before it (centerElement: true), per skills/app-test-cases § group-field-list walk. An unnecessary guard is a runtime no-op, so applying it is always safe; a missing one is selector-not-found on a live device`,
        recipe: recipe.name,
        parameter: 'unguarded-option-tap',
        value: unguarded.matcher,
      });
    }

    // 6.6 answer-tap-before-leading-label-advance → the INVERSE of the
    // #858 carve-out above, and the static enforcement of the #710/#684
    // prose rule (skills/app-test-cases/SKILL.md § Quiz / required-input
    // answer-tap rule → "Leading (and interior) display/label screens").
    //
    // A `kind: label` node renders as its OWN screen with nothing to
    // answer. So a form whose field list OPENS with N label nodes
    // (`hidden` nodes render nothing and don't count) needs N bare
    // form-advance steps between the menu-walk entry step
    // (learn-tap-module / deliver-form-walk) and the first answer tap.
    // Emit fewer and the answer tap fires while the intro screen is
    // still up: `selector-not-found`, the Learn leg dies, learn_progress
    // never reaches 100%, Deliver stays locked, Phase 6 cannot complete
    // (ace#1045, live on bednet-spot-check/20260729-0002).
    //
    // #858's threshold made the probe label-aware in the PERMISSIVE
    // direction only (don't flag a legitimate label traversal). This is
    // the restrictive direction — and the two cannot conflict, because
    // this one only fires on an advance count BELOW what the form's own
    // leading labels require, while #858's only fires ABOVE.
    //
    // Precision guards (the #858/#860 false-positive tax is the reason):
    //   * the answer step must resolve to a REAL answerable matcher of
    //     the walked form (question label or option label) — a
    //     navigation tap can't trigger it;
    //   * when the entry step doesn't name a FORM_NAME (deliver-form-walk
    //     takes none), every supplied form is a candidate and the
    //     requirement is the MINIMUM across the ones the tap matched;
    //   * inert when the caller supplies no `fields` (same contract as
    //     group-field-list-per-question-walk).
    const labelMiss = findAnswerTapBeforeLeadingLabelAdvance(
      recipe.text,
      formShapes,
      params.formNames,
    );
    if (labelMiss) {
      failures.push({
        class: 'answer-tap-before-leading-label-advance',
        detail: `recipe ${recipe.name} taps an answer ("${labelMiss.matched}", line ${labelMiss.line}) after only ${labelMiss.found} bare form-advance step(s), but form "${labelMiss.formName}" opens with ${labelMiss.expected} leading kind:label screen(s) (${labelMiss.leadingLabels.join(', ')}) — each renders as its own screen, so the answer selector is not present yet and the tap fails selector-not-found`,
        remediation: `emit ${labelMiss.expected} bare form-advance step(s) (no answer tap) between the menu-walk entry step and the first answer tap, one per leading label node, per skills/app-test-cases/SKILL.md § Quiz / required-input answer-tap rule → Leading (and interior) display/label screens (ace#710); re-author via /ace:step app-test-cases`,
        recipe: recipe.name,
        parameter: 'leading-label-advances',
        value: `expected=${labelMiss.expected},found=${labelMiss.found}`,
      });
    }

    // 6.7 score-gated-quiz-over-advance → on a SCORE-GATED quiz (#569:
    // trailing relevant-gated result labels, FINISH-only finalize),
    // form-submit.yaml performs the answer→result-label advance ITSELF.
    // An explicit form-advance chained between the last answer and
    // form-submit consumes that advance, leaving form-submit tapping a
    // nav_btn_next the result screen does not render (ace#1118, carved
    // out of #1045; same golden recipe, bednet-spot-check Learn app).
    //
    // Precision guards (same tax as 6.5/6.6):
    //   * armed only when a candidate form's trailing label run carries
    //     a `relevant`-gated label — an auto-finalize quiz legitimately
    //     advances into nav_btn_next, so it must never fire there;
    //   * every UNGATED label in the trailing run renders as its own
    //     unconditional screen and licenses one bare advance — only
    //     advances BEYOND that budget are flagged;
    //   * ambiguous candidates: fires only when EVERY candidate form is
    //     score-gated, against the most permissive budget among them;
    //   * inert when the caller supplies no `fields`.
    const overAdvance = findScoreGatedQuizOverAdvance(
      recipe.text,
      formShapes,
      params.formNames,
    );
    if (overAdvance) {
      failures.push({
        class: 'score-gated-quiz-over-advance',
        detail: `recipe ${recipe.name} chains ${overAdvance.found} bare form-advance step(s) between the last answer tap and form-submit (last advance at line ${overAdvance.line}), but form "${overAdvance.formName}" is score-gated (${overAdvance.gatedLabels.join(', ')} are relevant-gated result labels) — form-submit.yaml performs the answer→result advance itself (#569), so the extra advance leaves it tapping nav_btn_next on the FINISH-only result screen${overAdvance.expected > 0 ? ` (${overAdvance.expected} advance(s) are licensed by ungated trailing label screens; found ${overAdvance.found})` : ''}`,
        remediation: `remove the explicit form-advance between the last required answer and the form-submit runFlow — on a score-gated quiz form-submit.yaml owns that advance (skills/app-test-cases/SKILL.md § Quiz / required-input answer-tap rule, ace#569/#1118); re-author via /ace:step app-test-cases`,
        recipe: recipe.name,
        parameter: 'post-answer-advances',
        value: `expected<=${overAdvance.expected},found=${overAdvance.found}`,
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

    // 7.5 inputtext-geopoint-as-string → the recipe types a GPS
    // "lat lon alt accuracy" string into a question. A native CommCare
    // geopoint is a Capture-button widget, NOT a free-text field: the
    // string can't be entered as multiple space-separated tokens, so the
    // form's `selected-at(<gps>, 1)` calc throws `Calculation Error …
    // list with only 1 element` at runtime (jjackson/ace#686). The
    // signature is unambiguous: an inputText value of two (or more)
    // space/`%s`-separated signed decimals = a lat/lon pair. The correct
    // capture path is a mock-location fix + Capture-button tap (see
    // skills/app-test-cases/SKILL.md Step 3 item 4.5).
    const geoInputs = findGeopointStringInputs(recipe.text);
    for (const { value, line } of geoInputs) {
      failures.push({
        class: 'inputtext-geopoint-as-string',
        detail: `recipe ${recipe.name} types a GPS coordinate string via inputText "${value}" (line ${line}) — a native CommCare geopoint is a Capture-button widget, not a free-text field; the typed value collapses to one token and selected-at(<gps>,1) throws "Calculation Error … list with only 1 element" at runtime`,
        remediation: `drive the geopoint via its Capture flow instead: set an emulator mock location (mobile_set_location / cold-boot mock-loc baseline), then tap the live-calibrated geopoint Capture-button selector — never inputText a "lat lon alt accuracy" string (skills/app-test-cases/SKILL.md Step 3 item 4.5)`,
        recipe: recipe.name,
        parameter: 'inputText',
        value,
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

    // 3. expected-form-not-in-module → recipe binds a FORM_NAME alongside
    // a MODULE_NAME in the SAME env block, but that form is not in that
    // module. Only check when MODULE_NAME resolves to a known module.
    //
    // Iterate the PAIRS, never the cross product of the two flat sets.
    // The cross product emits M x (M-1) failures on a recipe that walks M
    // modules with one form each — every message individually true, every
    // conclusion false, because the recipe never bound that pair. That made
    // multi-module Learn smokes un-passable at Phase 6 pre-flight, and
    // one-form-per-module is a load-bearing ACE pattern, so multi-module is
    // the normal shape (ace#1235). A pair with no FORM_NAME is skipped:
    // the palette derives the form name from the module there, so "no form
    // bound" is not "form missing".
    for (const { moduleName, formName } of params.modulePairs) {
      if (formName === null) continue;
      const knownForms = moduleToForms.get(moduleName);
      if (!knownForms) continue;
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

    // 3.5 module-form-checks-not-run (WARN, never a failure) → checks 2
    // and 3 are driven entirely by the MODULE_NAME/FORM_NAME the recipe
    // binds. A recipe that composes palette steps but binds neither
    // silently skips both, and the verdict is byte-identical to one where
    // they ran and passed. Name the inert checks instead (ace#1068) —
    // same caveat contract as `field_data_supplied` for the screen-shape
    // checks. Deliver smokes legitimately land here: `deliver-form-walk`
    // taps the first row at each menu level and takes no env, so the WARN
    // is the honest answer, not a defect to suppress.
    if (params.moduleNames.size === 0 && /^\s*-?\s*runFlow:/m.test(recipe.text)) {
      warnings.push({
        class: 'module-form-checks-not-run',
        detail: `recipe ${recipe.name} composes runFlow steps but binds no MODULE_NAME in any env block (top-level or nested runFlow.env), so expected-module-not-in-app and expected-form-not-in-module did NOT run for it — a clean verdict here does not mean the recipe's module/form names exist in the live app`,
        remediation: `pass MODULE_NAME (and FORM_NAME) in the entry step's runFlow env — e.g. runFlow: {file: learn-tap-module.yaml, env: {MODULE_NAME: "<live module>", FORM_NAME: "<live form>"}} — or, for a palette step that takes no env (deliver-form-walk), verify the module/form names by hand against nova_get_app and record that in the verdict`,
        recipe: recipe.name,
      });
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
    warnings,
    observed: {
      recipe_module_names: [...recipeModuleNames].sort(),
      recipe_form_names: [...recipeFormNames].sort(),
      live_opp_name: inputs.connectOpp.display_name,
      recipe_opp_name: recipeOppName,
      field_data_supplied: fieldDataSupplied,
      max_label_screen_run: maxLabelRun,
      nova_groups_seen: groupScreens.length,
      module_form_checks_ran: recipeModuleNames.size > 0,
    },
  };
}

/** Extract the MODULE_NAME / FORM_NAME values a recipe binds — from the
 * recipe's top-level `env:`/`params:` block AND from every NESTED
 * `runFlow.env` map, at any depth. Returns sets — a single recipe may
 * bind multiple module/form names across its steps.
 *
 * The nested form is the one Phase 3 actually emits:
 *
 * ```yaml
 * - runFlow:
 *     file: learn-tap-module.yaml
 *     env:
 *       MODULE_NAME: "Connect Basics"
 *       FORM_NAME: "Connect Basics"
 * ```
 *
 * Reading only the top-level block returned EMPTY sets for that shape,
 * which made `expected-module-not-in-app` and `expected-form-not-in-module`
 * structurally unable to fire while the verdict still read `ok: true`
 * (ace#1068). */
export function extractRecipeParameters(recipe: RecipeText): {
  moduleNames: Set<string>;
  formNames: Set<string>;
  /** Each env/params block that bound a MODULE_NAME, paired with the
   * FORM_NAME bound ALONGSIDE it in that same block (null when the block
   * bound no form).
   *
   * The flat sets above cannot express this. Checking every form name
   * against every module name is a cross product: for a recipe walking M
   * modules with one form each it emits M x (M-1) failures whose detail
   * text is individually true and whose conclusion is false, because the
   * recipe never bound that pair (ace#1235). One-form-per-module is a
   * deliberate, load-bearing ACE pattern — Connect dedups deliver units by
   * module slug — so multi-module is the NORMAL shape, and the cross
   * product made every multi-module Learn smoke un-passable at Phase 6
   * pre-flight. `expected-module-not-in-app` stays on the flat set; it is
   * correct there. */
  modulePairs: { moduleName: string; formName: string | null }[];
} {
  const moduleNames = new Set<string>();
  const formNames = new Set<string>();
  const modulePairs: { moduleName: string; formName: string | null }[] = [];

  // Parse the YAML. Maestro recipes ALMOST ALWAYS use multi-document
  // form (`appId + env` as doc 1, step list as doc 2 after `---`), so
  // we must use `parseAllDocuments`. The top-level env block lives in
  // the first document; the step lists in later docs carry the nested
  // `runFlow.env` maps, so BOTH are walked.
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(recipe.text);
  } catch {
    return { moduleNames, formNames, modulePairs };
  }

  /** Read one env/params map. Unresolved `${...}` placeholders are NOT
   * names — recording them would make `expected-module-not-in-app` fire
   * on a template. */
  const readEnvMap = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const envMap = candidate as Record<string, unknown>;
    const module = envMap.MODULE_NAME;
    const form = envMap.FORM_NAME;
    const moduleOk =
      typeof module === 'string' && module.trim() !== '' && !module.includes('${');
    const formOk = typeof form === 'string' && form.trim() !== '' && !form.includes('${');
    if (moduleOk) {
      moduleNames.add(module as string);
    }
    if (formOk) {
      formNames.add(form as string);
    }
    // Record the PAIRING, not just the membership. A block binding a
    // module and no form yields formName null and must be SKIPPED by the
    // form check — not reported as a missing form (the same-name Branch B
    // case, where the palette derives the form name from the module).
    if (moduleOk) {
      modulePairs.push({
        moduleName: module as string,
        formName: formOk ? (form as string) : null,
      });
    }
  };

  const walk = (node: unknown, depth: number): void => {
    if (depth > 24 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const map = node as Record<string, unknown>;
    readEnvMap(map.env);
    readEnvMap(map.params);
    for (const value of Object.values(map)) walk(value, depth + 1);
  };

  for (const doc of docs) {
    walk(doc.toJS(), 0);
  }

  return { moduleNames, formNames, modulePairs };
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

/** Split a recipe into top-level list items by scanning lines for `- `
 * at the same indent as the first list-item dash. The static palette
 * uses 0-indent dashes; recipes follow suit. */
function splitTopLevelSteps(
  yaml: string,
): { text: string; startLine: number }[] {
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
  return items;
}

/** Longest run of consecutive `label` SCREENS in any single form across
 * the supplied apps.
 *
 * `hidden` fields render no screen, so they don't break a run. A `group`
 * DOES break it: the whole field-list is one answerable screen no matter
 * how many labels sit inside it, so group children are never counted
 * here. Returns 0 when no caller supplied field data. */
function maxConsecutiveLabelScreens(apps: NovaAppSlice[]): number {
  let max = 0;
  for (const app of apps) {
    for (const mod of app.modules) {
      for (const form of mod.forms) {
        if (!form.fields) continue;
        let run = 0;
        for (const field of form.fields) {
          if (field.kind === 'hidden') continue;
          if (field.kind === 'label') {
            run++;
            if (run > max) max = run;
          } else {
            run = 0;
          }
        }
      }
    }
  }
  return max;
}

/** One supplied form reduced to the two facts the leading-label check
 * needs: how many `label` screens it OPENS with, and which on-screen
 * strings count as ANSWERING it. */
interface FormShape {
  formName: string;
  /** Count of leading `kind: label` fields, skipping `hidden` (which
   * render no screen). Stops at the first answerable field. */
  leadingLabelCount: number;
  /** Ids of those leading label fields, for the failure detail. */
  leadingLabels: string[];
  /** Question labels + select-option labels of every ANSWERABLE field
   * (group children included). Excludes `label`/`hidden` fields — their
   * text is display-only, so tapping it is never an answer. */
  answerMatchers: string[];
  /** Ids of the relevant-gated `label` fields in the form's TRAILING
   * label run (skipping `hidden`). Non-empty = the #569 score-gated
   * finalize signature: the result screen is FINISH-only, and
   * form-submit.yaml performs the answer→result advance itself. */
  trailingGatedLabels: string[];
  /** Count of UNGATED `label` fields in that same trailing run. Each
   * renders unconditionally as its own screen, so each licenses one
   * bare form-advance between the last answer and form-submit. */
  trailingUngatedLabelBudget: number;
}

/** One FormShape per supplied form. Empty when no caller passed
 * `fields`, which is what makes the leading-label check inert by
 * default (same contract as `group-field-list-per-question-walk`). */
function collectFormShapes(apps: NovaAppSlice[]): FormShape[] {
  const out: FormShape[] = [];
  for (const app of apps) {
    for (const mod of app.modules) {
      for (const form of mod.forms) {
        if (!form.fields) continue;
        let leadingLabelCount = 0;
        const leadingLabels: string[] = [];
        let stillLeading = true;
        const answerMatchers: string[] = [];
        for (const field of form.fields) {
          if (field.kind === 'hidden') continue;
          if (field.kind === 'label') {
            if (stillLeading) {
              leadingLabelCount++;
              leadingLabels.push(field.id);
            }
            continue;
          }
          stillLeading = false;
          if (field.kind === 'group') {
            for (const child of field.children ?? []) {
              if (child.kind === 'hidden' || child.kind === 'label') continue;
              if (child.label) answerMatchers.push(child.label);
              for (const opt of child.options ?? []) {
                if (opt.label) answerMatchers.push(opt.label);
              }
            }
            continue;
          }
          if (field.label) answerMatchers.push(field.label);
          for (const opt of field.options ?? []) {
            if (opt.label) answerMatchers.push(opt.label);
          }
        }
        // Trailing label run, scanned from the end (hidden renders no
        // screen and is skipped; stop at the first answerable field).
        const trailingGatedLabels: string[] = [];
        let trailingUngatedLabelBudget = 0;
        for (let i = form.fields.length - 1; i >= 0; i--) {
          const field = form.fields[i];
          if (field.kind === 'hidden') continue;
          if (field.kind !== 'label') break;
          if (field.relevant) trailingGatedLabels.unshift(field.id);
          else trailingUngatedLabelBudget++;
        }
        out.push({
          formName: form.form_name,
          leadingLabelCount,
          leadingLabels,
          answerMatchers,
          trailingGatedLabels,
          trailingUngatedLabelBudget,
        });
      }
    }
  }
  return out;
}

/** Menu-walk entry steps — the palette recipes that land the device on a
 * form's FIRST screen. Everything between one of these and the first
 * answer tap is the leading-label budget. */
const ENTRY_STEP_RE = /file:\s*(?:learn-tap-module|deliver-form-walk)\.yaml/;

/** Find the first answer tap that fires with fewer bare form-advance
 * steps behind it than the walked form's leading `label` screens require
 * — the #710/#684 class, statically (ace#1045). Returns null when no
 * field data was supplied, no entry step is present, or every segment
 * clears its budget. */
function findAnswerTapBeforeLeadingLabelAdvance(
  yaml: string,
  shapes: FormShape[],
  recipeFormNames: Set<string>,
): {
  formName: string;
  expected: number;
  found: number;
  line: number;
  matched: string;
  leadingLabels: string[];
} | null {
  if (!shapes.length) return null;
  if (!ENTRY_STEP_RE.test(yaml)) return null;

  const items = splitTopLevelSteps(yaml);
  let candidates: FormShape[] | null = null;
  let advances = 0;

  for (const item of items) {
    if (ENTRY_STEP_RE.test(item.text)) {
      // A new form walk starts here. Prefer the FORM_NAME the entry step
      // itself binds; fall back to the recipe's single bound form name;
      // otherwise every supplied form is a candidate (deliver-form-walk
      // takes no env at all).
      const named = readStepFormName(item.text);
      const fallback =
        named === null && recipeFormNames.size === 1 ? [...recipeFormNames][0] : named;
      const resolved = fallback === null ? shapes : shapes.filter((s) => s.formName === fallback);
      candidates = resolved.length ? resolved : null;
      advances = 0;
      continue;
    }
    if (!candidates) continue;

    const kind = classifyStepBlock(item.text);
    if (kind === 'form-advance') {
      advances++;
      continue;
    }
    if (kind !== 'answer') continue;

    // Only a tap/inputText that resolves to a REAL answerable matcher of
    // a candidate form counts — navigation taps must not trigger this.
    const matchers = stepTextMatchers(item.text);
    if (!matchers.length) continue;
    const matchedShapes: FormShape[] = [];
    let matchedText = '';
    for (const shape of candidates) {
      for (const matcher of matchers) {
        if (shape.answerMatchers.some((c) => c === matcher || c.startsWith(matcher))) {
          matchedShapes.push(shape);
          if (!matchedText) matchedText = matcher;
          break;
        }
      }
    }
    if (!matchedShapes.length) continue;

    // Ambiguous match (shared option labels across forms) → require the
    // MINIMUM, i.e. flag only when every candidate would still be short.
    const worstCase = matchedShapes.reduce((min, s) =>
      s.leadingLabelCount < min.leadingLabelCount ? s : min,
    );
    if (advances < worstCase.leadingLabelCount) {
      return {
        formName: worstCase.formName,
        expected: worstCase.leadingLabelCount,
        found: advances,
        line: item.startLine,
        matched: matchedText,
        leadingLabels: worstCase.leadingLabels,
      };
    }
    // Budget cleared — this segment is done.
    candidates = null;
  }
  return null;
}

/** Find a bare form-advance chained between the last answer tap and a
 * form-submit palette call on a score-gated quiz — the #569 over-advance,
 * statically (ace#1118). Returns null when no field data was supplied, no
 * entry step is present, no candidate is score-gated, or the advance count
 * stays within the ungated-trailing-label budget. */
function findScoreGatedQuizOverAdvance(
  yaml: string,
  shapes: FormShape[],
  recipeFormNames: Set<string>,
): {
  formName: string;
  expected: number;
  found: number;
  line: number;
  gatedLabels: string[];
} | null {
  if (!shapes.length) return null;
  if (!ENTRY_STEP_RE.test(yaml)) return null;

  const items = splitTopLevelSteps(yaml);
  let candidates: FormShape[] | null = null;
  let sawAnswer = false;
  let advancesSinceAnswer = 0;
  let lastAdvanceLine = 0;

  for (const item of items) {
    if (ENTRY_STEP_RE.test(item.text)) {
      const named = readStepFormName(item.text);
      const fallback =
        named === null && recipeFormNames.size === 1 ? [...recipeFormNames][0] : named;
      const resolved = fallback === null ? shapes : shapes.filter((s) => s.formName === fallback);
      candidates = resolved.length ? resolved : null;
      sawAnswer = false;
      advancesSinceAnswer = 0;
      continue;
    }
    if (!candidates) continue;

    if (/file:\s*form-submit\.yaml/.test(item.text)) {
      if (sawAnswer && advancesSinceAnswer > 0) {
        // Fire only when EVERY candidate is score-gated — if any candidate
        // auto-finalizes, the advance could be legitimate for it.
        const armed = candidates.filter((s) => s.trailingGatedLabels.length > 0);
        if (armed.length === candidates.length) {
          // Most permissive budget across candidates — flag only when the
          // recipe over-advances against ALL of them.
          const budget = Math.max(...armed.map((s) => s.trailingUngatedLabelBudget));
          if (advancesSinceAnswer > budget) {
            const shape = armed.reduce((max, s) =>
              s.trailingUngatedLabelBudget > max.trailingUngatedLabelBudget ? s : max,
            );
            return {
              formName: shape.formName,
              expected: budget,
              found: advancesSinceAnswer,
              line: lastAdvanceLine,
              gatedLabels: shape.trailingGatedLabels,
            };
          }
        }
      }
      // This form walk is finalized — a later entry step starts the next.
      candidates = null;
      continue;
    }

    const kind = classifyStepBlock(item.text);
    if (kind === 'answer') {
      sawAnswer = true;
      advancesSinceAnswer = 0;
      continue;
    }
    if (kind === 'form-advance' && sawAnswer) {
      advancesSinceAnswer++;
      lastAdvanceLine = item.startLine;
    }
  }
  return null;
}

/** Read a `FORM_NAME:` binding out of one step block (the nested
 * `runFlow.env` shape). Returns null when the step binds none. */
function readStepFormName(stepText: string): string | null {
  const m = stepText.match(/^\s*FORM_NAME:\s*(?:"([^"]*)"|'([^']*)'|([^\s#][^#\n]*?))\s*$/m);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  if (!raw || raw.includes('${')) return null;
  return raw;
}

/** A Nova group flattened to the on-screen strings a recipe could match
 * against — child question labels plus every select option label. */
interface GroupScreen {
  groupId: string;
  matchers: string[];
  /**
   * Longest LABEL-kind child on this screen, in characters. A group is a
   * CommCare field-list, so a long read-aloud passage (consent script,
   * behaviour-change segment) shares the screen with the questions it
   * governs and pushes their options below the fold.
   */
  longestLabelChars: number;
  /** Option labels belonging to REQUIRED select children of this group. */
  requiredOptionMatchers: string[];
}

/**
 * Character budget above which a label child is assumed to push its
 * screen-mates below the fold on a 1080x2400 device.
 *
 * Calibrated from the live failure (bednet-check-2-visit/20260814-0856): an
 * ~840-char consent script put the Yes/No radios of the SAME field-list off
 * screen, and the recipe's bare `tapOn` died `selector-not-found`. 400 is
 * deliberately well below that — the cost of a false positive here is one
 * redundant guarded scroll, which is a no-op when the option is already
 * visible; the cost of a false negative is a dead Phase 6 leg.
 */
const BELOW_FOLD_LABEL_CHARS = 400;

/** Collect one GroupScreen per `kind: group` field across the supplied
 * apps. Hidden children contribute nothing (they never render). */
function collectGroupScreens(apps: NovaAppSlice[]): GroupScreen[] {
  const out: GroupScreen[] = [];
  for (const app of apps) {
    for (const mod of app.modules) {
      for (const form of mod.forms) {
        for (const field of form.fields ?? []) {
          if (field.kind !== 'group' || !field.children?.length) continue;
          const matchers: string[] = [];
          const requiredOptionMatchers: string[] = [];
          let longestLabelChars = 0;
          for (const child of field.children) {
            if (child.kind === 'hidden') continue;
            if (child.label) matchers.push(child.label);
            if (child.kind === 'label' && child.label) {
              longestLabelChars = Math.max(longestLabelChars, child.label.length);
            }
            // `NovaFieldSlice` carries no `required` flag, so every select on
            // the screen counts. That is the right side to err on here: an
            // OPTIONAL select below the fold is equally untappable, and the
            // remediation (a guarded scroll) is a runtime no-op when the
            // option is already visible.
            const isSelect = child.kind === 'single_select' || child.kind === 'multi_select';
            for (const opt of child.options ?? []) {
              if (!opt.label) continue;
              matchers.push(opt.label);
              if (isSelect) requiredOptionMatchers.push(opt.label);
            }
          }
          if (matchers.length) {
            out.push({ groupId: field.id, matchers, longestLabelChars, requiredOptionMatchers });
          }
        }
      }
    }
  }
  return out;
}

/**
 * An answer tap on a REQUIRED select whose field-list screen also carries a
 * long read-aloud label, with no scroll guard for that option anywhere
 * earlier in the recipe.
 *
 * This is the `bednet-check-2-visit/20260814-0856` Deliver-leg failure. The
 * Register Household `Consent` group is one field-list holding an ~840-char
 * consent script plus `consent_given` (Yes/No). The authored recipe tapped
 * "Yes" bare and died `selector-not-found` — the radios were below the fold.
 *
 * The asymmetry that makes this worth enforcing rather than documenting: the
 * SAME authoring pass produced a Learn recipe with a guarded scroll on all
 * ten of its option taps and a Deliver recipe with none. The rule was
 * already written down (§ group-field-list remediation says "scrollUntilVisible
 * + tap per select") and was still missed, which is the definition of a rule
 * that needs a check behind it.
 *
 * Narrow by construction, per the #858 false-positive lesson: it fires only
 * when the screen has BOTH a label over the character budget AND a required
 * select, and only when NO scroll targeting that option appears earlier.
 * A guarded scroll that is unnecessary is a no-op at runtime, so the
 * remediation is always safe to apply.
 */
function findUnguardedOptionTapBelowLongLabel(
  recipeText: string,
  groupScreens: GroupScreen[],
): { line: number; groupId: string; matcher: string; labelChars: number } | null {
  const risky = groupScreens.filter(
    (g) => g.longestLabelChars >= BELOW_FOLD_LABEL_CHARS && g.requiredOptionMatchers.length > 0,
  );
  if (risky.length === 0) return null;

  const lines = recipeText.split('\n');
  const blockAt = (start: number): string => {
    const block = [lines[start]];
    for (let j = start + 1; j < lines.length && !/^\s*-\s+\S/.test(lines[j]); j++) block.push(lines[j]);
    return block.join('\n');
  };
  const matches = (a: string, b: string): boolean =>
    a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));

  // Every scroll guard in the recipe, with the line it starts on. A guard
  // hoisted into a `when: notVisible` runFlow still counts — what matters is
  // that a scroll targeting this option happens before the tap.
  const guards: { line: number; matchers: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/scrollUntilVisible/.test(lines[i])) continue;
    guards.push({ line: i, matchers: stepTextMatchers(blockAt(i)) });
  }

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s+tapOn:/.test(lines[i])) continue;
    const taps = stepTextMatchers(blockAt(i));
    if (taps.length === 0) continue;

    for (const g of risky) {
      for (const opt of g.requiredOptionMatchers) {
        if (!taps.some((t) => matches(opt, t))) continue;
        const guarded = guards.some(
          (guard) => guard.line < i && guard.matchers.some((t) => matches(opt, t)),
        );
        if (!guarded) {
          return { line: i + 1, groupId: g.groupId, matcher: opt, labelChars: g.longestLabelChars };
        }
      }
    }
  }
  return null;
}

/** Extract the `text:` matchers a step selects on, normalised for
 * comparison against live Nova labels. Recipes commonly use a literal
 * PREFIX plus `.*` to dodge regex metacharacters in question labels
 * (see #862), so a trailing `.*` is stripped and matching is
 * prefix-based. */
function stepTextMatchers(stepText: string): string[] {
  const out: string[] = [];
  const re = /text:\s*(?:"([^"]*)"|'([^']*)'|([^\s{}[\],]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stepText)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    out.push(raw.replace(/\.\*$/, '').trim());
  }
  return out;
}

/** Which group (if any) a step's matchers point at. Returns the group id
 * and the matched string, or null. */
function matchGroupForStep(
  stepText: string,
  groups: GroupScreen[],
): { groupId: string; matched: string } | null {
  const matchers = stepTextMatchers(stepText);
  if (!matchers.length) return null;
  for (const matcher of matchers) {
    for (const group of groups) {
      for (const candidate of group.matchers) {
        if (candidate === matcher || candidate.startsWith(matcher)) {
          return { groupId: group.groupId, matched: matcher };
        }
      }
    }
  }
  return null;
}

/** Find the first form-advance that sits strictly BETWEEN two matched
 * children of the SAME Nova group — the #862 antipattern. Returns null
 * when no group data was supplied or no such advance exists. */
function findGroupInternalAdvance(
  yaml: string,
  groups: GroupScreen[],
): { groupId: string; line: number; firstMatch: string; secondMatch: string } | null {
  if (!groups.length) return null;
  const items = splitTopLevelSteps(yaml);
  let pendingGroup: string | null = null;
  let pendingMatch = '';
  let advanceLine = -1;
  for (const item of items) {
    const kind = classifyStepBlock(item.text);
    if (kind === 'form-advance') {
      // Only the FIRST advance after a group match matters; later ones
      // in the same run would report the same defect twice.
      if (pendingGroup && advanceLine === -1) advanceLine = item.startLine;
      continue;
    }
    const hit = matchGroupForStep(item.text, groups);
    if (!hit) continue;
    if (pendingGroup === hit.groupId && advanceLine !== -1) {
      return {
        groupId: hit.groupId,
        line: advanceLine,
        firstMatch: pendingMatch,
        secondMatch: hit.matched,
      };
    }
    pendingGroup = hit.groupId;
    pendingMatch = hit.matched;
    advanceLine = -1;
  }
  return null;
}

/** Walk a recipe's step list and return the first chain of `minChain`+
 * consecutive form-advance steps with no answer step between them.
 * Returns null when no such chain exists. */
function findFormAdvanceChain(
  yaml: string,
  minChain = 2,
): { count: number; firstLine: number } | null {
  const items = splitTopLevelSteps(yaml);

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
      if (chainCount >= minChain) {
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

/**
 * Find inputText steps whose value is a GPS coordinate string — the
 * broken "type a geopoint as text" pattern (jjackson/ace#686). A native
 * CommCare geopoint is a Capture-button widget; typing a
 * "lat lon [alt accuracy]" string collapses to one token (spaces don't
 * survive entry into the field) and makes the form's
 * `selected-at(<gps>, 1)` calc throw `Calculation Error … list with only
 * 1 element` at runtime. The signature is unambiguous: a value that
 * starts with two space- or `%s`-separated signed decimals (a lat/lon
 * pair) — a real form option label or text answer never looks like that.
 * Matches scalar `inputText: "..."` and a mapping-form `text: "..."`,
 * including adb-style `%s`/`%20`-escaped spaces.
 */
function findGeopointStringInputs(
  yaml: string,
): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  const lines = yaml.split('\n');
  const geoSig = /^\s*-?\d{1,3}\.\d+(?:\s+|%s|%20)-?\d{1,3}\.\d+/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    // scalar form: `- inputText: "12.0 8.5 500 10"` (quotes optional).
    // Requires a non-empty value, so a bare `inputText:` mapping opener
    // (no value on the line) is not matched here.
    const scalar = line.match(/\binputText:\s*["']?([^"'\n]+?)["']?\s*$/);
    if (scalar && geoSig.test(scalar[1])) {
      out.push({ value: scalar[1].trim(), line: i + 1 });
      continue;
    }
    // mapping form: a `text: "..."` value line (under an inputText block).
    const textVal = line.match(/^\s*text:\s*["']?([^"'\n]+?)["']?\s*$/);
    if (textVal && geoSig.test(textVal[1])) {
      out.push({ value: textVal[1].trim(), line: i + 1 });
    }
  }
  return out;
}
