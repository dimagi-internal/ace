---
name: training-deck-generate
description: >
  Generate a training deck spec.yaml from PDD, app summaries, screenshot
  manifests, and a template bundle. The spec is the source of truth for the
  training deck — training-deck-render produces Google Slides from it.
disable-model-invocation: true
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
     `drive_path:`, `file_id:`. Alias convention: `<journey-id>-<step-name>`
     e.g. `J1-learn-mod-1-step-3`, `J2-deliver-form-photo-step-1`.

   Cross-pool alias collisions: per-opp wins (more specific).

   **If the per-opp manifest is missing or empty:** the upstream
   `app-screenshot-capture` skill in Phase 6 step 1 didn't produce
   screenshots (likely due to a smoke-recipe failure). Don't halt the
   deck generation — emit walkthrough slides using `content` layout
   (no image) and surface `[WARN] no per-opp screenshots — `your-opportunity`
   walkthroughs degraded to content-only slides` in the verdict's
   `auto_surfaced` list. The deck still ships; the operator can
   replace screenshots manually post-launch.

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
     3. One `content` slide per Learn module (Learn-app preview)
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
     summary). Title `"Complete Learn Module N: <module-name>"`, body
     names the key concept + assessment threshold. Plus 1 form-practice
     slide + 1 role-play slide.
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

9. **Validate the expanded spec.** Check against
   `TrainingDeckSpecSchema` (Zod). Every `@alias` image ref must
   resolve against the merged manifest from step 5; flag any
   unresolvable refs as a hard fail.

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
- `run_state.yaml.phases.qa-and-training.products.training.docs.deck_spec` — `{file_id, title: "Training deck spec", web_view_link}` typed handoff. Multi-writer block: apply via read-modify-write per `skills/synthetic-data-generate/SKILL.md § Step 6`. See `agents/qa-and-training.md § Products` for the full slot table.

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

## Change Log

- v1: Initial skill. Replaces `training-deck-outline`. Produces
  `training-deck-spec.yaml` via template bundle + generation prompt.
  Archetype-aware with `atomic-visit` as the only shipped template.
