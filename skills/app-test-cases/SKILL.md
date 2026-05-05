---
name: app-test-cases
description: >
  After Nova builds the Learn and Deliver apps, bind each user journey
  from expected-journeys.md to the actual built structure, emit a
  Maestro recipe stub per journey with real selectors (not REPLACE_*),
  and write the consolidated app-test-cases.yaml. Phase 5 reads this
  for shallow execution; /ace:qa-deep reads it for full execution.
  Successor to qa-plan (which is retired in this same release).
---

# App Test Cases

Binds Phase 1 UX intent to Phase 2 built structure. Runs after Nova
finishes both apps, before `app-release` — so the recipes exist when
Phase 5 needs them.

## Process

### Step 1: Read inputs

- `expected-journeys.md`
- `app-summaries/learn-app-summary.md`
- `app-summaries/deliver-app-summary.md`
- The Nova blueprints (call `mcp__plugin_nova_nova__get_app` with each
  app id) for real form/field IDs
- The static-recipe library at `mcp/mobile/recipes/static/`

### Step 2: For each journey, decide its app + smoke flag

Map each journey from `expected-journeys.md` to either Learn or Deliver
based on whether the journey describes assessment behavior (Learn) or
visit/delivery behavior (Deliver). Multi-stage opps may have both.

**Smoke flag rules:**
- Exactly ONE journey per app gets `is_smoke: true`
- The smoke journey is the simplest happy-path that exercises the
  app's primary submission/completion flow
- If two journeys could plausibly be the smoke, pick the one with the
  smallest `pdd_time_budget_seconds`

### Step 3: For each journey, compose the Maestro recipe

Compose each recipe using the static palette pattern (one Maestro
step per UI interaction, with `${SELECTOR:logical-name}`
placeholders resolved at write time, and `takeScreenshot` calls
between major form sections):

- Recipes here are journey-keyed, not module-keyed (`J1.yaml`, `J2.yaml`)
- Each journey's recipe MUST include a final
  `takeScreenshot: "sc-J<n>-final"` for the deep UX judge to grade
- Resolve any `${SELECTOR:logical-name}` placeholders via
  `mobile_resolve_selectors` against the current APK selector map
  before validating
- Validate via `mobile_validate_recipe` before writing

Write recipes to `ACE/<opp>/runs/<run-id>/app-test-cases/recipes/J<n>.yaml`.

### Step 4: Emit the consolidated yaml

Write `ACE/<opp>/runs/<run-id>/app-test-cases.yaml` per the template
in `templates/app-test-cases-template.yaml`.

### Step 5: Self-evaluate coverage

(Same shape as pdd-to-test-prompts.) Verify:
- Every journey from `expected-journeys.md` has a binding
- Exactly one `is_smoke: true` per app
- Every recipe passes `mobile_validate_recipe`
- Every `forms_exercised` entry resolves to a real Nova form ID

If any check fails, return to the relevant step and fix before writing
the yaml. This is a pre-write structural gate — no verdict file is
emitted (no LLM-as-Judge in this skill; the deep UX judging happens
later in `app-ux-eval`).

## Mode behavior

- Auto: write everything, halt on blocker
- Review: pause to show the journey→form bindings before composing recipes
- Dry-run: write the yaml + journey bindings; stub recipe paths; state
  tracks as `dry-run-success`

## Failure modes

- expected-journeys.md missing or empty → Phase 1 hasn't completed; halt
- Nova blueprint missing for one of the apps → Phase 2 build hasn't
  succeeded; halt with pointer to upstream skill
- mobile_validate_recipe rejects more than 2× per journey → escalate
  with the validator output

## MCP tools used

- ace-gdrive: drive_read_file, drive_create_file, drive_create_folder
- ace-mobile: mobile_resolve_selectors, mobile_validate_recipe
- nova: mcp__plugin_nova_nova__get_app

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-04 | Initial version. Phase 2 producer for app-test-cases.yaml; binds expected-journeys.md to Nova-built structure with Maestro recipe stubs. Successor to qa-plan (retired in same release). | ACE team |
