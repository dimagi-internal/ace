---
name: app-test-cases
description: >
  Bind each PDD user journey to the Nova-built app structure and emit a
  Maestro recipe per journey with real selectors. Use after Nova
  finishes building, before app-release.
disable-model-invocation: true
---

# App Test Cases

Binds Phase 1 UX intent to Phase 2 built structure. Runs after Nova
finishes both apps, before `app-release` — so the recipes exist when
Phase 5 needs them.

## Related skills

- **Successor to:** `qa-plan` (retired in 0.10.x, replaced by this skill).
- **Consumes:** `pdd-to-app-journeys.md` from `pdd-to-app-journeys` (Phase 1).
- **Consumed by:** `app-screenshot-capture` (Phase 5, shallow) and
  `/ace:qa-deep` (full execution).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/pdd-to-app-journeys.md` | journey list + persona + per-journey pass criteria |
| Phase 2 | `2-commcare/pdd-to-learn-app_summary.md` and `pdd-to-deliver-app_summary.md` | nova_app_id per app |
| Nova MCP | `get_app({app_id: <nova_app_id>})` | authoritative form/field IDs to resolve into real Maestro selectors |
| Static | `mcp/mobile/recipes/static/` | recipe palette / templates |

## Outputs

- `2-commcare/app-test-cases.yaml` — per-journey test entries (one per journey, exactly one `is_smoke: true` per app)
- `2-commcare/recipes/J<n>.yaml` — one Maestro recipe per journey (real selectors, no `REPLACE_*` placeholders)

## Process

### Step 1: Read inputs

- `pdd-to-app-journeys.md`
- `app-summaries/learn-app-summary.md`
- `app-summaries/deliver-app-summary.md`
- The Nova blueprints (call `get_app` with each
  app id) for real form/field IDs
- The static-recipe library at `mcp/mobile/recipes/static/`

### Step 2: For each journey, decide its app + smoke flag

Map each journey from `pdd-to-app-journeys.md` to either Learn or Deliver
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

**Use live labels from Nova's `get_form` response, not the PDD
brief's labels** (per [#115 finding 2](https://github.com/jjackson/ace/issues/115)).
The PDD brief uses pre-build naming conventions (`L0 — Why this
matters`, `F1 — Shop Registration`, `Stage 1 — Market Analysis`)
that Nova's autobuild and CommCare's app-editor rewrite into different
strings on the live device (`1. Why this matters`, `Stage 1: shop
visits & interviews`, etc.). `tapOn:text` matchers calibrated against
the brief never hit live screens.

For every `tapOn:text` matcher in a recipe:
- Read the label from `get_form({app_id, form_id})`'s
  response — Nova returns each form's `label` and each field's `label`
  exactly as CommCare will render them after autobuild's scaffold pass.
- Use that string verbatim in the recipe's `tapOn:text` matcher.
- For module-list / form-list screens, read the parent module's `label`
  from `get_module` and apply the same rule.

`mobile_validate_recipe` is a static lint that accepts any
syntactically-valid string — it cannot detect a brief-vs-live drift.
Step 4 (below) adds a runtime smoke check that catches it.

**Write recipes to `ACE/<opp>/runs/<run-id>/2-commcare/recipes/J<n>.yaml`**
(NOT `app-test-cases/recipes/` — earlier drafts of this SKILL.md had
the wrong path and the recipes silently weren't being created;
[#106 finding 3](https://github.com/jjackson/ace/issues/106) fixed
this. The path must mirror the output spec at the top of the file so
Phase 5's `app-screenshot-capture` can find them.)

Create the `2-commcare/recipes/` subfolder via `drive_create_folder`
(idempotent — `findOrCreate: true` is the default) BEFORE writing the
first recipe.

### Step 3.5 (optional): Runtime smoke validator

Static `mobile_validate_recipe` cannot detect brief-vs-live label drift
(see Step 3). The runtime smoke validator catches it by attempting each
`is_smoke: true` recipe against a live AVD and confirming every
`tapOn:text` matcher resolves on a real screen.

**Run only when the operator has mobile bootstrap healthy and opts in.**
Set `--smoke-validate` to enable; default is OFF so non-mobile-bootstrapped
operators can run Phase 2 to completion without an AVD. When the flag is
set:

1. Confirm bootstrap health via `mobile_ensure_avd_running()`. If it
   returns `running: false` and the AVD can't auto-start, log
   `[INFO] smoke validator skipped: AVD unavailable` and continue —
   don't fail Phase 2 over a dev-machine state issue.
2. For each `is_smoke: true` journey's recipe, call:

   ```
   mcp__plugin_ace_ace-mobile__mobile_run_recipe({
     recipe_path: <path/to/J<n>.yaml>,
     dry_run_selectors: true,   // resolve every selector, don't actuate
     env_vars: { OPP_NAME, ... },
   })
   ```

3. If `dry_run_selectors: true` returns any unresolved `tapOn:text`
   matcher, halt with a `[BLOCKER]` naming the offending recipe + step
   + the missing string. The fix is usually to swap the brief label
   for the live `get_form`-derived label per Step 3.

This is a deferred fix — `mobile_run_recipe` doesn't ship a
`dry_run_selectors` mode today. Until it does, this step is a no-op
warning. Tracking: jjackson/ace#115 finding 2.

### Step 4: Emit the consolidated yaml

Write `ACE/<opp>/runs/<run-id>/app-test-cases.yaml` per the template
in `templates/app-test-cases-template.yaml`.

### Step 5: Self-evaluate coverage

(Same shape as pdd-to-test-prompts.) Verify:
- Every journey from `pdd-to-app-journeys.md` has a binding
- Exactly one `is_smoke: true` per app
- **Every `is_smoke: true` journey has a `recipes/J<n>.yaml` file
  written under `2-commcare/recipes/`.** Confirm via
  `drive_list_folder` against the recipes folder — count must equal
  the number of `is_smoke: true` journeys. Phase 5's
  `app-screenshot-capture` reads from this folder; a missing recipe
  silently degrades the deck-build to placeholder screenshots
  ([#106 finding 3](https://github.com/jjackson/ace/issues/106) — the
  leep-paint-collection run hit this exact gap and required two
  manual `/ace:step` retries to recover).
- Every recipe passes `mobile_validate_recipe`
- Every `forms_exercised` entry resolves to a real Nova form ID

**If any check fails, halt with a `[BLOCKER]` in the gate brief.**
Do NOT write `app-test-cases.yaml` until the recipe coverage matches
the `is_smoke` count. This is a pre-write structural gate — no
verdict file is emitted (no LLM-as-Judge in this skill; the deep UX
judging happens later in `app-ux-eval`).

## Mode behavior

- Auto: write everything, halt on blocker
- Review: pause to show the journey→form bindings before composing recipes
- Dry-run: write the yaml + journey bindings; stub recipe paths; state
  tracks as `dry-run-success`

## Failure modes

- pdd-to-app-journeys.md missing or empty → Phase 1 hasn't completed; halt
- Nova blueprint missing for one of the apps → Phase 2 build hasn't
  succeeded; halt with pointer to upstream skill
- mobile_validate_recipe rejects more than 2× per journey → escalate
  with the validator output

## MCP tools used

- ace-gdrive: drive_read_file, drive_create_file, drive_create_folder
- ace-mobile: mobile_resolve_selectors, mobile_validate_recipe
- nova: get_app

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-04 | Initial version. Phase 2 producer for app-test-cases.yaml; binds pdd-to-app-journeys.md to Nova-built structure with Maestro recipe stubs. Successor to qa-plan (retired in same release). | ACE team |
