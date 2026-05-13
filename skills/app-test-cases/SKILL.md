---
name: app-test-cases
description: >
  Bind each PDD user journey to the Nova-built app structure and emit a
  Maestro recipe per journey with real selectors. Use after Nova
  finishes building, before app-release.
disable-model-invocation: true
---

# App Test Cases

Binds Phase 1 UX intent to Phase 3 built structure. Runs after Nova
finishes both apps, before `app-release` — so the recipes exist when
Phase 6 needs them.

## Related skills

- **Successor to:** `qa-plan` (retired in 0.10.x, replaced by this skill).
- **Consumes:** `pdd-to-app-journeys.md` from `pdd-to-app-journeys` (Phase 1).
- **Consumed by:** `app-screenshot-capture` (Phase 6, shallow) and
  `/ace:qa-deep` (full execution).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `2-scenarios/pdd-to-app-journeys.md` | journey list + persona + per-journey pass criteria |
| Phase 3 | `3-commcare/pdd-to-learn-app_summary.md` and `pdd-to-deliver-app_summary.md` | nova_app_id per app |
| Nova MCP | `get_app({app_id: <nova_app_id>})` | authoritative form/field IDs to resolve into real Maestro selectors |
| Static | `mcp/mobile/recipes/static/` | recipe palette / templates |

## Products

- `3-commcare/app-test-cases.yaml` — per-journey test entries (one per journey, exactly one `is_smoke: true` per app)
- `3-commcare/recipes/J<n>.yaml` — one Maestro recipe per journey (real selectors, no `REPLACE_*` placeholders)

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
  before validating (see Step 3.4 below — selector-resolution is a
  fail-loud gate, not just a substitution pass)
- Validate via `mobile_validate_recipe` before writing

#### Maestro inputText: scalar vs mapping form

`inputText` has two valid shapes — pick the right one based on
whether you need any options:

```yaml
# Scalar form — text only, no options
- inputText: "Apcolite Stores"

# Mapping form — REQUIRED when you need any inputText option
# (optional, label, id, point, etc.)
- inputText:
    text: "Apcolite Stores"
    optional: true
```

The combination that **does not parse** is the scalar form with
a sibling option key under the same list item:

```yaml
- inputText: "Apcolite Stores"
    optional: true            # ← Maestro rejects this at parse time
```

This is invalid YAML — the `-` opens a list item that's *both* a
scalar (`inputText: "..."`) and a mapping (`optional: true`).
Maestro's parser surfaces it as:
`expected <block end>, but found '<block mapping start>'`.

The same rule applies to every Maestro command that has both a
scalar and a mapping form (`tapOn`, `assertVisible`,
`extendedWaitUntil`, etc.): use the mapping form whenever you need
*any* option beyond the bare value.

Caught in vivo on leep Phase 6 attempt 8 (2026-05-12) — J1.yaml
emitted the broken sibling form, Phase 6 halted, the cloud
emulator stack returned a full structured error envelope with the
Maestro parse-error frame which named this exact pattern.

#### Entry-point template — Connect-integrated flow

ACE-Phase-5 recipes drive a CommCare install that's **Connect-
integrated**, not standalone. The post-`launchApp` surface on
CommCare 2.62.0 is `screen_first_start_main` (Welcome to CommCare)
with buttons like `GO TO CONNECT MENU`, `Scan Barcode`,
`Enter Code` — there is **no app-name tile** to tap. Apps reach
the device via Connect's claim → Start workflow.

The mistake to avoid (caught on leep Phase 5 attempt 10):

```yaml
# WRONG — assumes the standalone-CommCare model, which doesn't exist
- launchApp
- tapOn:
    text: "ACE - LEEP Paint Surveillance - Deliver"   # ← no such tile
```

Right pattern: chain the static palette to land at the per-journey
form, then add journey-specific steps:

```yaml
# RIGHT — composes the static palette
appId: org.commcare.dalvik
---
# (a) Connect login, navigates to Opportunities home
- runFlow:
    file: connect-login.yaml
# (b) For each opp's first journey, claim+Start the opp once
- runFlow:
    file: connect-claim-opp.yaml
    env:
      OPP_NAME: ${OPP_NAME}
# (c) For Deliver journeys: deliver-launch (TODO: add to static palette)
#     For Learn journeys:   learn-launch.yaml
- runFlow:
    file: learn-launch.yaml
# ... journey-specific module/form steps below, using live labels
#     from Nova get_form (see "Use live labels" section below)
- takeScreenshot: "sc-J<n>-final"
```

The static palette lives at `mcp/mobile/recipes/static/`:
- `connect-login.yaml` — splash → nav drawer → Sign In → Opportunities home
- `connect-claim-opp.yaml` — opp-list → tap opp → Start → handoff
- `learn-launch.yaml` — opp detail → Start Learning → Learn home
- `form-advance.yaml` / `form-submit.yaml` — per-form helpers

Each `is_smoke=true` journey's recipe **must** include the Connect-
login + opp-claim prefix so it can run from a cold boot (the cloud
backend's standard state). Non-smoke journeys can assume warm state
and skip the prefix — but flag that assumption in the YAML header
comment so a reviewer doesn't try to run them cold.

Caught in vivo on leep Phase 5 attempt 10 (2026-05-13). Before this
guidance landed, J1.yaml and J7.yaml emitted the broken `launchApp +
tapOn:<app-name>` model, the live `tapOn` never found a target, and
the recipes failed with selector-miss errors — even though the
emulator + Maestro + cloud-stack were healthy.

#### Maestro feature-compat — cloud-backend lag

The cloud emulator's bundled Maestro (1.36-ish per its CLI banner)
is older than what the local-AVD backend ships. Some Maestro
properties are scalar-form-only or unsupported on cloud:

| Property | Local AVD | Cloud |
|---|---|---|
| `visibilityPercentage` | works | **rejects with `Unknown Property`** |
| `point: "x,y"` | works | works |
| `id:` matcher | works | works |
| `text:` matcher | works | works |
| `index:` for multi-match | works | works |
| `optional: true` (under mapping form) | works | works |

When in doubt, omit Maestro version-specific properties — the
default substring + visibility threshold is usually enough.
Re-baseline this table when the cloud AMI gets a Maestro version
bump (track via `ACE_MOBILE_AMI_VERSION`).

Caught in vivo on leep Phase 5 attempt 10 — `connect-claim-opp.yaml`
shipped with `visibilityPercentage: 30`, the cloud Maestro rejected
the whole recipe with `Unknown Property` before the first step
executed. Property removed in 0.13.194; this table is the prevention
for the future class of bug.

#### Selector placeholder gate — STRICT

Every `tapOn:text:` matcher in a generated recipe MUST be either:
- A **Nova-confirmed live form-field label** (read via `get_form`
  or `get_module` per the "Use live labels" section below), OR
- A `${SELECTOR:logical-name}` placeholder that resolves against
  `mcp/mobile/selectors/connect-<apk-version>.yaml` via
  `mobile_resolve_selectors` (Step 3.4)

The reason the placeholder path is mandatory for non-form-label
matchers: Connect-integrated CommCare has surface elements
(nav-drawer items, opp-card buttons, Start buttons, etc.) whose
labels are NOT in `get_form`. If a recipe hard-codes their text,
the matcher drifts silently when Connect's UI updates. The
selector map at `connect-<apk>.yaml` is the **single point of
calibration** — populate it via `connect-baseline-screenshots`,
then every recipe that references the same logical name updates
in lockstep.

The fallback rule: if you're tempted to write
`tapOn: { text: "Some Surface Label" }` and that label is NOT
from Nova's `get_form`, STOP. Add a logical name to the selector
map (or a placeholder for one) and use `${SELECTOR:<name>}`
instead. The agent at Step 3.4 will halt with `[BLOCKER]` if any
unresolved placeholder ships — that's the forcing function.

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

**Write recipes to `ACE/<opp>/runs/<run-id>/3-commcare/recipes/J<n>.yaml`**
(NOT `app-test-cases/recipes/` — earlier drafts of this SKILL.md had
the wrong path and the recipes silently weren't being created;
[#106 finding 3](https://github.com/jjackson/ace/issues/106) fixed
this. The path must mirror the output spec at the top of the file so
Phase 6's `app-screenshot-capture` can find them.)

Create the `3-commcare/recipes/` subfolder via `drive_create_folder`
(idempotent — `findOrCreate: true` is the default) BEFORE writing the
first recipe.

### Step 3.4: Selector-resolution gate

Before writing any recipe to Drive, run a recipe-wide
`mobile_resolve_selectors` pass against the current APK selector map
(`mcp/mobile/selectors/connect-<ACE_CONNECT_APK_VERSION>.yaml`,
default `2.62.0`). For each composed recipe, call:

```
mcp__plugin_ace_ace-mobile__mobile_resolve_selectors({
  yaml: <composed recipe body>,
  apkVersion: <ACE_CONNECT_APK_VERSION>,
})
```

If `unresolved` is non-empty for any recipe, halt with `[BLOCKER]`
naming:

- the logical selector names that didn't resolve
- the recipe(s) that referenced them
- the active selector-map version (`connect-<apkVersion>.yaml`)
- remediation: `Add missing rows to mcp/mobile/selectors/connect-<apkVersion>.yaml — see PR #249 for the calibration pattern (3 added rows + 5 re-verified for the connect-2.62.0 map). Until that lands, this opp cannot reach Phase 6 cleanly.`

This gate exists because Phase 6's `app-screenshot-capture` will
block on the same condition when it tries to run the recipes against
a live AVD. Shifting it left to Phase 3 — where Nova `get_form` /
`get_app` context is still in-scope — gives the author a chance to
fix the recipe's selector references (or surface the map gap for a
calibration PR) before the unresolved selectors reach the emulator.
Both `leep` and `turmeric` runs in early May 2026 hit this class at
Phase 6; this is the structural preventer.

`unverified` entries are NOT a blocker — they substitute fine, they're
just flagged as not-yet-re-verified against the live APK. Surface the
list as `[WARN]` and continue.

### Step 3.5 (optional): Runtime smoke validator

Static `mobile_validate_recipe` cannot detect brief-vs-live label drift
(see Step 3). The runtime smoke validator catches it by attempting each
`is_smoke: true` recipe against a live AVD and confirming every
`tapOn:text` matcher resolves on a real screen.

**Run only when the operator has mobile bootstrap healthy and opts in.**
Set `--smoke-validate` to enable; default is OFF so non-mobile-bootstrapped
operators can run Phase 3 to completion without an AVD. When the flag is
set:

1. Confirm bootstrap health via `mobile_ensure_avd_running()`. If it
   returns `running: false` and the AVD can't auto-start, log
   `[INFO] smoke validator skipped: AVD unavailable` and continue —
   don't fail Phase 3 over a dev-machine state issue.
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
  written under `3-commcare/recipes/`.** Confirm via
  `drive_list_folder` against the recipes folder — count must equal
  the number of `is_smoke: true` journeys. Phase 6's
  `app-screenshot-capture` reads from this folder; a missing recipe
  silently degrades the deck-build to placeholder screenshots
  ([#106 finding 3](https://github.com/jjackson/ace/issues/106) — the
  leep-paint-collection run hit this exact gap and required two
  manual `/ace:step` retries to recover).
- Every recipe passes `mobile_validate_recipe`
- Every recipe's `mobile_resolve_selectors` pass returned
  `unresolved: []` (Step 3.4 gate; non-empty means the APK selector
  map is missing rows and Phase 6 will block)
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
- Nova blueprint missing for one of the apps → Phase 3 build hasn't
  succeeded; halt with pointer to upstream skill
- mobile_validate_recipe rejects more than 2× per journey → escalate
  with the validator output

## MCP tools used

- ace-gdrive: drive_read_file, drive_create_file, drive_create_folder
- ace-mobile: mobile_resolve_selectors, mobile_validate_recipe
- nova: get_app

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time.

### Common load-bearing decisions for Phase 6

| ID | Question | Map to surface |
|---|---|---|
| `test-scenario-count` | How many app-walkthrough scenarios feed the qa+eval pair? | `pdd-to-app-journeys-eval` coverage_completeness dimension |
| `test-archetype-coverage` | Are all archetypes in the PDD covered by at least one scenario? | `pdd-to-app-journeys-eval` archetype_alignment dimension |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 6-qa-and-training` and
`skill: app-test-cases`.

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-04 | Initial version. Phase 3 producer for app-test-cases.yaml; binds pdd-to-app-journeys.md to Nova-built structure with Maestro recipe stubs. Successor to qa-plan (retired in same release). | ACE team |
| 2026-05-08 | Add `## Decisions Log` section: 2 anchor rows (test-scenario-count, test-archetype-coverage) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 3-10 writes). | ACE team (decisions-log PR #4) |
| 2026-05-12 | Add Step 3.4 — recipe-wide `mobile_resolve_selectors` gate. Halts `[BLOCKER]` on any unresolved logical selector before recipes are written to Drive. Shifts left a class of Phase 6 blockers (leep + turmeric runs both hit this in early May) to Phase 3, where Nova form/field context is still in-scope. Follows PR #249's `connect-2.62.0.yaml` calibration. | ACE team |
