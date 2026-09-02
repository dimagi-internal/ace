---
name: training-deck-generate
description: >
  Generate a training deck spec.yaml from PDD, app summaries, screenshot
  manifests, and a template bundle. The spec is the source of truth for the
  training deck — training-deck-render produces Google Slides from it.
disable-model-invocation: false
---

# Training Deck Generate

Produce a `training-deck-spec.yaml` — the structured spec that
`training-deck-render` parses into a real Google Slides deck. Replaces
the legacy `training-deck-outline` skill, which emitted a markdown
outline; the spec format is machine-parseable and template-driven.

## When to run

Phase 6 (`qa-and-training`), after `app-screenshot-capture` completes.
Upstream of `training-deck-render`.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | Opportunity description, requirements, targets |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/pdd-to-learn-app_summary.md` | Learn app structure, form names, module names |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/pdd-to-deliver-app_summary.md` | Deliver app structure, form names, module names |
| Common assets | `ACE/_common/connect-screenshots/<v>/manifest.yaml` | Platform setup screenshots |
| Phase 6 Step 1 (`app-screenshot-capture`) | `ACE/<opp>/runs/<run-id>/6-qa-and-training/app-screenshot-capture_manifest.yaml` | Per-opp app screenshots |
| Current run | `run_state.yaml` | Opportunity metadata, payment info, verification rules |
| Plugin repo | `templates/training-deck/connect-training-atomic/` | Skeleton + generation prompt |

## Output

Single file: `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-spec.yaml`.

## Process

1. **Read archetype from PDD.** Parse the `Archetype:` line from PDD
   frontmatter. Default to `atomic-visit` if absent.

2. **Select template bundle.** Map archetype to template directory
   under `templates/training-deck/`:
   - `atomic-visit` → `connect-training-atomic`
   - `focus-group` → `connect-training-fgd` (future)
   - `multi-stage` → `connect-training-multistage` (future)

   If the archetype's template doesn't exist yet, fall back to
   `connect-training-atomic` and emit a WARN in the verdict.

3. **Read template bundle.** Three files from the selected template
   directory:
   - `template.yaml` — template metadata (name, archetype, version)
   - `spec.template.yaml` — the spec skeleton with `{{placeholder}}`
     tokens
   - `generate.prompt.md` — the generation prompt with layout selection
     rules and content guidance

4. **Read all inputs.** Drive paths in the table above:
   - PDD (`idea-to-pdd.md`)
   - Learn app summary (`pdd-to-learn-app_summary.md`)
   - Deliver app summary (`pdd-to-deliver-app_summary.md`)
   - `run_state.yaml` (for `connect.payment_units`,
     `connect.verification_flags`, opportunity metadata)

5. **Read screenshot manifests (C1 — per-opp wiring).** Build a merged
   manifest map `{ alias -> {file_id, drive_url} }`:
   - Common-pool aliases from
     `ACE/_common/connect-screenshots/<v>/manifest.yaml` (e.g.,
     `connect-signin-splash`, `claim-opp-detail`, `commcare-welcome`).
     These cover the Connect platform onboarding flow and are shared
     across all opportunities.
   - Per-opp aliases from
     `ACE/<opp>/runs/<run-id>/6-qa-and-training/app-screenshot-capture_manifest.yaml`.
     Format: each entry has `alias:`, `journey_id:`, `step_name:`,
     `drive_path:`, `file_id:`. Alias convention: `<recipe-base>-<step-name>`
     e.g. `journey-learn-mod-1-step-3`, `journey-deliver-form-photo-step-1`.

   - **Template assets** from `templates/training-deck/_common/assets/assets.yaml`
     into `manifest.template` (ace#873). These are committed deck artwork, NOT
     captures — see that file for the per-asset contract and the verified
     reason each one is uncapturable. An asset still marked `status: needed`
     has no PNG yet: emit the step caption-only and surface
     `[TEMPLATE-ASSET-MISSING] <alias>`. That is a **template-bundle** defect,
     never an opp capture failure, and it does **not** feed the coverage gate
     below.

   Cross-pool alias collisions: `opp` > `common` > `template` — most specific
   wins (`resolveManifest`, `lib/training-deck-spec.ts`).

   **If the per-opp manifest is missing or empty:** the upstream
   `app-screenshot-capture` skill in Phase 6 step 1 didn't produce
   screenshots (likely due to a smoke-recipe failure). Emit the affected
   walkthrough slides using `content` layout (no image), surface
   `[WARN] no per-opp screenshots — `your-opportunity` walkthroughs degraded
   to content-only slides` in the verdict's `auto_surfaced` list, **and then
   apply the visual-coverage gate in step 5b — which this case will fail.**

   **Partial per-app screenshots.** The screenshot manifest may contain
   `journey-learn/` screenshots but no `journey-deliver/` (or vice versa)
   when one capture leg failed/was-deferred (see
   `app-screenshot-capture` per-app legs). Use whichever app's screenshots
   are present; for the missing app, emit the same "screenshot placeholder
   — capture in a future AVD-enabled QA run" treatment already used when
   the whole bundle is absent. One missing leg is a WARN that carries its
   coverage number; **both** legs missing is a gate failure.

### Step 5b: Visual-coverage gate (dimagi-internal/ace#856)

**A training deck whose walkthrough spine has no screens IS the placeholder.**
CLAUDE.md's "fail loud — don't ship placeholders, don't soft-fail" applies at
the *deliverable* level, not just the screenshot step. Text-only prose
artifacts (FAQ, quick-reference) degrade honestly; a deck cannot, because
showing the screens is the entire reason it exists.

1. Compute `expectedOppVisualSlides` — the number of opp-specific visual
   slides this deck *should* carry. It is the Deliver form count + Learn module
   count from the app summaries, i.e. the same number step 11's C2 check
   already derives. **Do NOT count emitted image slots.**
2. Call `computeVisualCoverage(spec, { expectedOppVisualSlides })` from
   `lib/training-deck-spec.ts`.
3. Record `visual_coverage: { expected, filled, ratio, pool_filled,
   template_filled }` in the verdict.

| Condition | Outcome |
|---|---|
| `ratio >= 0.5` | proceed |
| `ratio < 0.5`, one app leg present | `[WARN]` quoting the ratio; proceed |
| `ratio < 0.5` with **no** per-opp captures at all, or both legs missing | **`verdict: fail`, `severity: BLOCKER`. Do not proceed to render.** |

On a BLOCKER the phase writes `status: blocked` (see `agents/qa-and-training.md`)
and the run reports the blocker instead of offering the deck as a deliverable.

**Why the denominator is not the emitted slot count.** This step downgrades an
unbacked walkthrough slide to `content` layout — and a downgraded slide is
schematically indistinguishable from one that was always meant to be text-only,
so it silently leaves the numerator *and* the denominator. On
hh-poverty-targeting/20260702-1456 that arithmetic gave **4 images / 4 slots =
100%** while true opp coverage was **0 of 6**; the deck shipped 39 empty slides
of 43 and the render self-eval scored it 9.5. Pinned by the regression test in
`test/lib/training-deck-spec.test.ts` ("a hollow deck reads 0, not 100%").

**Why only `manifest.opp` counts.** Several pool aliases are permanently
uncapturable — the PersonalID completion half (now template assets, ace#873)
and the three Play-Store install screens, which need a Google-signed-in AVD. A
gate that counted them would fire on 100% of runs, on every opp, forever.
Scoping to `manifest.opp` excludes them by construction, needs no allowlist,
and measures the right thing: the pool is not this run's work product, and a
screenshot-blocked run cannot lose it.

**Note on verdict vocabulary.** `blocked` is a legal *phase* status
(`lib/run-state-validator.ts`) but NOT a legal *skill* verdict
(`lib/verdict-schema.ts`). At skill level use `fail` + `severity: BLOCKER`.

   **Screenshot-claim consistency (dimagi-internal/ace#866 + #867).**
   Four hard rules when mapping manifest images onto slides:

   - **Never place the same image `file_id` on two slides/panels whose
     captions claim different moments.** If the manifest offers only
     duplicates for two claimed moments, use the image ONCE and rewrite
     the other panel/slide as `content` layout (no image) or drop it.
   - **Steps marked `duplicate_of:` in the capture manifest are NOT
     distinct panels.** A `duplicate_of` step is the same moment as its
     canonical step — never give it its own slide/panel or caption it as
     a separate moment.
   - **Never caption a screenshot with an assertion the pixels visibly
     contradict.** The shipped example: "there is no gallery option, on
     purpose" over a widget showing CHOOSE IMAGE
     (hh-poverty-targeting/20260702-1456 deck slide 27,
     dimagi-internal/ace#867). If the app contradicts the PDD, surface it
     as a defect in the verdict's `auto_surfaced` list instead of
     asserting the design intent.
   - **Captions must describe the surface actually shown** — a CommCare
     screen must not be captioned as a Connect screen (or vice versa).

6. **Read common modules.** Load shared module fragments from
   `templates/training-deck/_common/`:
   - `platform-setup.yaml` — Connect sign-in, claim, install slides
   - `facilitation.yaml` — ice-breaker pool, group exercise patterns
   - `resources.yaml` — help contacts, support links template

7. **Fill the spec skeleton.** Following the generation prompt
   instructions, produce a complete spec with 6 modules:

   - **`welcome`** module: cover slide (title, subtitle, date
     placeholder), agenda slide, ice-breaker slide from facilitation
     pool
   - **`platform-setup`** module: include `_common/platform-setup.yaml`
     verbatim — Connect sign-in, claim opportunity, install app steps
     with common-pool screenshot refs
   - **`your-opportunity`** module — structured around the 4 Connect
     lifecycle pillars (Learn / Deliver / Verify / Pay) with `section`
     divider slides between them. Order:
     1. Opportunity overview (1-2 content slides)
     2. `section` divider titled `"Learn"`
     3. One `content` slide per Learn module (Learn-app preview),
        titled with the app's module name **verbatim** — same rule as
        the `practice` module below, and for the same reason (ace#1829).
        **A body list of the suite's sections is numbered by the app's
        own labels, never by list position.** Slide 14 of
        `hh-poverty-targeting/20260828-0702` printed `4. What makes a
        visit payable` directly beside the suite-root screenshot
        labelling that same item "Module 3" — the contradiction sat on
        one slide, next to its own evidence.
     4. "Who you will visit" (1 content slide)
     5. `section` divider titled `"Deliver"`
     6. **C2 REQUIRED:** one `walkthrough` slide per Deliver form.
        Title `"Form N: <display-name>"`, body cites 2-3 actual field
        labels, image is the per-opp `@alias` if the manifest has one
        (else fall back to `content` layout — do NOT invent screenshot
        aliases). A 6-form Deliver app produces 6 walkthrough slides;
        do NOT collapse.
     7. `section` divider titled `"Verify"`
     8. Quality and verification (1-2 content slides)
     9. `section` divider titled `"Pay"`
     10. Payment details (stats slide preferred)
     11. Safety and ethics (1 content slide, cross-pillar)
   - **`practice`** module (C2 — REQUIRED per-opp content): emit one
     `exercise` slide per Learn module (enumerated from the Learn app
     summary). Title `"Complete: <module-label>"` where `<module-label>`
     is the Learn app's module name **verbatim** — body names the key
     concept + assessment threshold. Plus 1 form-practice slide + 1
     role-play slide.

     **NEVER synthesise an ordinal (ace#1829).** The app's module names
     already carry their own numbers, so a number you derive from a
     slide's position in this list can only ever disagree with them. On
     `hh-poverty-targeting/20260828-0702` this section counted the
     unnumbered `Pre-Assessment` tile as Module 1 and shifted every real
     module up by one, while the reference section four modules earlier
     printed the app's names correctly — two incompatible numberings in
     one deck:

     ```
     app  : Pre-Assessment | Module 1 - Administering… | Module 2 - Consent… | Module 3 - What makes a visit payable | …
     deck : Module 1: Pre-Assessment | Module 2: Administering… | Module 3: Consent… | Module 4: What Makes a Visit Payable | …
     ```

     These are TIMED hands-on instructions ("Complete Learn Module 4:
     What Makes a Visit Payable", 20 min). A first-day FLW follows the
     slide, opens the app, finds no Module 4 by that name — it is
     Module 3 — and stalls inside a timed block. This is the population
     `content_substance` exists to protect.

     The authoritative labels are available two ways on every run and
     they agree: `3-commcare/pdd-to-learn-app_summary.md`, and the
     capture manifest's `learn-tap-module-after-<name>.png` step names.
     Copy from those; do not count.
   - **`evaluation`** module: checklist slide from PDD acceptance
     criteria, timeline-to-go-live slide, "what happens next" framing
   - **`resources`** module: include `_common/resources.yaml`, replace
     `{{LLO_CONTACT}}` with "your LLO manager", add OCS widget URL
     from `ocs-setup_widget-handoff.md` if available

8. **Resolve `ref:` module references** via `resolveModuleRefs()` from
   `lib/training-deck-spec.ts`. Any module declared with
   `ref: _common/<name>` (e.g. `_common/platform-setup`,
   `_common/resources`) gets inlined by loading
   `templates/training-deck/_common/<name>.yaml` and substituting
   `{{KEY}}` tokens from the module's `overrides:` map (recursively
   across all string leaves). Pass the same `loadModule` adapter used
   by the orchestrator (fs-based when running from a repo checkout,
   Drive-based when running from a deployed skill).

   **Why this step is non-optional.** The render skill validates the
   spec against `TrainingDeckSpecSchema`, which requires every module
   to have inline `slides[]`. A spec that still contains `ref:` modules
   fails parse and the render emits zero slides for those modules.
   Pre-2026-05-25 specs that shipped with `ref: _common/platform-setup`
   (the malaria-rdt run) lost their platform-setup slides for exactly
   this reason — fixed by always inlining refs at generate time.

9. **Validate the expanded spec — BEFORE writing it to Drive.** Run
   `parseTrainingSpec(yamlStr)` (which applies `TrainingDeckSpecSchema`)
   against the serialized spec. **This is a hard gate, not a review
   step: if it throws, fix the spec and re-validate — do NOT write the
   artifact.** Every `@alias` image ref must also resolve against the
   merged manifest from step 5; flag any unresolvable refs as a hard
   fail.

   Validating here rather than at render time is the whole point. An
   unvalidated spec still *writes* successfully and the step still marks
   itself `done`, so the shape violation only surfaces later when
   `training-deck-render` calls `parseTrainingSpec` and hard-fails —
   at which point Phase 6 has no deck and `verify_phase_products` fails
   the boundary fence, because `products.training.deck` is a REQUIRED
   handoff key the ace-web summary renders.

   **Three shapes that have actually shipped broken** (dimagi-internal/ace#1049,
   spark-facilitator/20260728-1338) — the skeleton's placeholders sit in
   scalar position, so filling them literally produces the wrong type:

   - `manifest.common` / `manifest.opp` are **maps** (`alias -> URL`).
     Emit `{}` when a pool resolved to nothing. A scalar fails.
   - `voice.estimated_duration_minutes` is a **number**. A quoted value
     fails.
   - agenda `items` is a **list of `{label, duration}` objects**. A list
     of bare strings fails.

10. **Write** the fully-expanded `training-deck-spec.yaml` to
    `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-spec.yaml`
    via `drive_create_file`. Overwrite if it already exists. The
    written spec MUST be schema-clean for `TrainingDeckSpecSchema`
    (no `ref` modules remain).

11. **Self-evaluate.** Five criteria — the first four are programmatic
    checks (run BEFORE the LLM judge), the fifth is the soft slide-count
    warning:

    - **Module coverage:** all 6 modules present (`welcome`,
      `platform-setup`, `your-opportunity`, `practice`, `evaluation`,
      `resources`). FAIL if any missing.
    - **Content concreteness:** strict `/{{[A-Z_]+}}/` regex sweep
      across all string leaves of the spec — any match is an unfilled
      token leak (the `{{STAT1_LABEL}}` class of bug from the
      malaria-rdt deck). FAIL if any found.
    - **Image ref validity:** all `@alias` refs in walkthrough and
      mobile_flow slides resolve against the merged manifest. FAIL if
      any unresolvable.
    - **Speaker notes presence:** every slide has a non-empty `notes:`
      field. FAIL if any slide is missing notes. The deck must be
      facilitatable (talking points, timing cues, transitions,
      knowledge-check answers). See generation prompt § Tone and
      Language Guidelines for what notes should contain.
    - **Per-opp Learn/Deliver mapping (C2):** count Learn modules and
      Deliver forms in the app summaries. Verify the spec contains:
        - In `your-opportunity` module: ≥ `<deliver-form-count>` slides
          with `id` matching `/form-/` or title beginning `"Form "`
        - In `practice` module: ≥ `<learn-module-count>` slides with
          `id` matching `/guided-learn|module-/` or title beginning
          `"Complete Learn Module "`
      FAIL if undercounted by more than 1 in either dimension. WARN if
      exactly equal to N-1 (acceptable to collapse a single-form case).
      Catches the failure mode where the generator emits one
      "Module 1" slide regardless of the opp's actual Learn structure.
    - **Module-label fidelity (C2 — HARD GATE, ace#1829):** every
      module label the deck shows a worker must match the deployed
      Learn app. Run it; do not eyeball it:

      ```ts
      import { checkDeckModuleLabels, formatDeckLabelReport }
        from '../../lib/deck-module-labels';
      const report = checkDeckModuleLabels(allSlides, learnModuleLabels);
      ```

      `learnModuleLabels` is the Learn app's module list, **in app
      order, verbatim, including unnumbered entries** like
      `Pre-Assessment` — their presence is exactly what caused the
      off-by-one, so dropping them from the input hides the defect from
      the check. Source it from
      `3-commcare/pdd-to-learn-app_summary.md`, cross-checked against
      the capture manifest's `learn-tap-module-after-<name>.png` step
      names.

      **FAIL on any finding**, and fix by lifting the app's label rather
      than by renumbering to taste. The three shapes it catches:
      `module-number-mismatch` (the deck's number for a module differs
      from the app's — including an ordinal list item with no "Module"
      keyword, the slide-14 shape), `module-number-not-in-app` (the deck
      sends a worker to a module that does not exist), and
      `module-name-not-in-app` (the deck names a module the app does not
      ship). Record `formatDeckLabelReport(...)` in the verdict either
      way.

      Note this is the check the SLIDE-COUNT check above cannot be:
      counting slides confirms the practice section has one entry per
      module, and the shipped deck passed that while every one of those
      entries carried the wrong number. A count never reads a label.

    - **4-pillar section dividers:** `your-opportunity` module contains
      exactly 4 `section`-layout slides with titles `"Learn"`,
      `"Deliver"`, `"Verify"`, `"Pay"` (in that order, single-word
      titles per v5.5 — was `"Learn — ..."` etc but those wrap on
      the section stencil). FAIL if any pillar header is missing
      or out of order. Catches the failure mode where the generator
      emits a flat sequence of content slides without the lifecycle
      structure.
    - **Slide count:** total slides in 25-50 range. WARN if outside.
      Smoke opps (1 Learn module + 1 Deliver form) naturally land at
      the 25-30 floor; do NOT pad. Large opps (5+ modules + 6+ forms)
      land 40-50.

    Write a verdict YAML to
    `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-generate_verdict.yaml`
    in the standard shape (see `lib/verdict-schema.ts`). `passed: true`
    only if the first four criteria pass (slide count is WARN-only).

12. **Hand off.** Print the spec's Drive URL + the verdict summary.
    Phase 6 orchestrator dispatches `training-deck-render` next.

## Archetypes

- **`atomic-visit`** (default): Standard 6-module deck. Module 3
  (`your-opportunity`) focuses on the single-visit delivery workflow —
  one slide per Deliver form section.
- **`focus-group`**: Module 3 restructured around FGD facilitation —
  session prep, running the FGD, attestation form, gdoc writing. Uses
  template `connect-training-fgd` (future).
- **`multi-stage`**: Per-stage sub-modules within Module 3. Each stage
  gets its own slides; follow-up stages treat the FLW as a returning
  user. Uses template `connect-training-multistage` (future).

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`

No live Slides API or AVD — this skill is pure spec generation. The
Slides side is `training-deck-render`'s job.

## Mode Behavior

- **Auto:** Run end-to-end. Write spec, write verdict.
- **Review:** Pause after step 8 (validation), present the generated
  spec, resume on approval.
- **Dry-run:** Steps 1-8 in memory, skip `drive_create_file`. Verdict
  written with `dry_run: true`.

## Products

- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-spec.yaml`
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-generate_verdict.yaml`
- `run_state.yaml.phases.qa-and-training.steps.training-deck-generate` — step record with `artifact: 6-qa-and-training/training-deck-spec.yaml` (+ file_id). **Do NOT write a `products.training.docs.deck_spec` slot** — `lib/phase-products-schema.ts` enumerates only `llo_guide/flw_guide/quick_reference/faq/onboarding_email` under `products.training.docs`, and the only deck product slot is `products.training.deck`, written by `training-deck-render` after the Slides render (jjackson/ace#748; drift class jjackson/ace#705). The spec is an intermediate artifact tracked via the step record, not a typed product handoff. See `agents/qa-and-training.md § Products` for the full slot table.

## Downstream

`training-deck-render` reads `training-deck-spec.yaml` to produce
Google Slides. The spec is the single source of truth for the deck
content — render never invents content, it only lays out what the spec
declares.

## Why this replaces training-deck-outline

The legacy `training-deck-outline` emitted a markdown outline with
inline `drive:<fileId>` refs and `## Slide:` markers. That format was
loosely structured: `parseDeckOutline` was brittle, image refs were
resolved during generation (not validated against a manifest), and the
outline mixed content decisions with layout hints.

The spec format separates concerns:
- **Content** (what to say, which images) lives in the spec.
- **Layout** (slide dimensions, font sizes, positioning) lives in the
  render skill.
- **Template** (module structure, common modules) lives in the template
  bundle.

This makes independent iteration on each concern possible without
cross-contamination.

## Screenshot citations (shared contract)

Follow `skills/_training-template.md § Screenshot citations — canonical frames
only` (dimagi-internal/ace#1304): select captures via `canonicalCaptures` from
`lib/capture-manifest.ts`, and run `findDuplicateCitations` over the steps this
artifact cites before writing. A `duplicate_of` capture is byte-identical to
its canonical step — the same moment, never a second one.

**Checking that every `file_id` resolves does not cover this.** That is
existence; this is distinctness. Two producers asserted the former, self-scored
`image_hygiene` near 10, and still captioned alias frames as distinct states.
The self-eval criterion must assert duplicate handling explicitly.

## Change Log

- 2026-09-02: **Module labels are lifted from the Learn app, never renumbered (ace#1829).** The deck numbered the Learn suite TWO incompatible ways at once: slides 16-19 printed the app's names correctly while slides 34-39 renumbered from list position, counting the unnumbered `Pre-Assessment` tile as Module 1 and shifting every real module up by one. Slide 14 carried the contradiction beside its own evidence — an ordinal list item `4. What makes a visit payable` next to the suite-root screenshot labelling it "Module 3". Slides 34-39 are TIMED hands-on blocks, so a first-day FLW follows "Complete Learn Module 4: What Makes a Visit Payable", opens the app, finds Module 3 under that name and stalls. The step-11 slide-COUNT check could never catch it: counting confirms one practice slide per module, and the shipped deck passed that with every one of those slides carrying a wrong number — a count never reads a label. Three changes: the practice title template drops its synthesised `N` for the app's label verbatim; the `your-opportunity` Learn-preview rule says the same thing explicitly (it was only accidentally right, having no template at all); and step 11 gains a HARD GATE running `lib/deck-module-labels.ts`, whose input must include the UNNUMBERED app entries because their presence is the whole cause. *Enforced:* `test/lib/deck-module-labels.test.ts` (negative control: a position-counting detector — the bug's own logic — fails 9 of 13, inverting both controls) + `test/skills/training-deck-module-numbering.test.ts` (all 6 red against the pre-fix skill text).
- v1: Initial skill. Replaces `training-deck-outline`. Produces
  `training-deck-spec.yaml` via template bundle + generation prompt.
  Archetype-aware with `atomic-visit` as the only shipped template.
- 2026-07-13: Screenshot-claim consistency rules in step 5
  (dimagi-internal/ace#866 + #867) — no duplicate `file_id` across
  slides claiming different moments, `duplicate_of` steps are not
  distinct panels, captions must not assert what the pixels contradict,
  captions must describe the surface actually shown.
