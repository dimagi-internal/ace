# Shallow / Deep QA Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/ace:run` shallow-by-default (~5 LLM judge calls vs ~90 today), introduce a manual `/ace:qa-deep` command for quality assessment, and move QA-plan generation upstream to phases that know design intent (Phase 1) and built structure (Phase 2). Add a Phase 6 gate that prevents activation without fresh deep verdicts.

**Architecture:** Add two new artifact-producing skills upstream (`pdd-to-app-journeys` in Phase 1, `app-test-cases` in Phase 2) so Phase 5 can become a thin executor. Add one new eval skill (`app-ux-eval`) plus a top-level `/ace:qa-deep` command that wraps deep OCS + deep app eval. Thin OCS `--quick` to a 3-prompt × 1-dimension smoke check. Drop Phase 4's `--deep` gate. Wire the deep-verdict requirement into `llo-launch` so go-live can't ship without it. Retire `qa-plan` and `app-test` once their successors are live.

**Tech Stack:** TypeScript (MCP atoms, lib/), prompt-based skills (.md files), Vitest tests, Google Drive artifact layout under `ACE/<opp>/runs/<run-id>/`.

**Spec:** `docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`

---

## File Structure

**New files:**
- `skills/pdd-to-app-journeys/SKILL.md` — Phase 1 producer for `expected-journeys.md`
- `skills/app-test-cases/SKILL.md` — Phase 2 producer for `app-test-cases.yaml`
- `skills/app-ux-eval/SKILL.md` — deep-only LLM-as-Judge over screenshots + journeys
- `commands/qa-deep.md` — `/ace:qa-deep <opp>` slash command
- `templates/expected-journeys-template.md` — markdown skeleton consumed by `pdd-to-app-journeys`
- `templates/app-test-cases-template.yaml` — yaml skeleton consumed by `app-test-cases`
- `migrations/0.x.0-shallow-deep-qa.md` — migration notes for in-flight opps

**Modified files:**
- `skills/ocs-chatbot-qa/SKILL.md` — thin `--quick` to 3 prompts; gate calls only from `/ace:qa-deep`
- `skills/ocs-chatbot-eval/SKILL.md` — `--quick` collapses to 1 dimension (`overall_quality`)
- `skills/app-screenshot-capture/SKILL.md` — read `app-test-cases.yaml` instead of `qa-plan/`; add 1-question UX smoke judge
- `skills/llo-launch/SKILL.md` — gate activation on fresh deep verdicts
- `agents/design-review.md` — add `pdd-to-app-journeys` step
- `agents/commcare-setup.md` — add `app-test-cases` step after Nova builds, before `app-release`
- `agents/qa-and-training.md` — drop `qa-plan` step, point at new artifacts
- `agents/ocs-setup.md` — drop `--deep` gate; only `--quick` runs in Phase 4
- `agents/llo-manager.md` — note the new gate in `llo-launch`
- `lib/artifact-manifest.ts` — add new artifacts; drop `qa-plan/` and `app-test` artifacts; update `consumedBy` lists
- `bin/ace-doctor` — add freshness check for deep verdicts
- `commands/run.md` — note that deep QA is no longer part of `/ace:run`
- `VERSION` — bump

**Retired files (deleted at end):**
- `skills/qa-plan/SKILL.md` and directory
- `skills/app-test/SKILL.md` and directory
- `test-results/` artifact entries in manifest

---

## Task 1: New Phase 1 skill — `pdd-to-app-journeys`

**Goal:** Phase 1 emits `expected-journeys.md` describing UX intent. Nothing reads it yet (Task 3 does), so this lands cleanly without breaking anything.

**Files:**
- Create: `skills/pdd-to-app-journeys/SKILL.md`
- Create: `templates/expected-journeys-template.md`
- Modify: `agents/design-review.md` (add a step that dispatches the new skill)
- Modify: `lib/artifact-manifest.ts` (add `expected-journeys.md` entry under `phase: 'design'`, `required: true`, `producedBy: 'pdd-to-app-journeys'`, `consumedBy: ['app-test-cases', 'app-ux-eval']`)
- Test: `test/fixtures/artifact-manifest.test.ts` (existing — re-run after manifest edit)

- [ ] **Step 1: Read the existing Phase 1 skill `pdd-to-test-prompts` for structure**

Read: `skills/pdd-to-test-prompts/SKILL.md`. The new skill mirrors its frontmatter/process layout, including the `## Archetypes` branching.

- [ ] **Step 2: Write the template**

Create `templates/expected-journeys-template.md`:

```markdown
# Expected User Journeys — {{opp_name}}

Derived from: pdd.md (rev {{pdd_rev_date}})
Archetype: {{archetype}}

## Persona

{{persona_summary — pulled verbatim from PDD's "Target FLW" section}}

## Journey 1 — {{journey_name}}

**Goal:** {{one-line goal of the journey}}

**Happy path narrative:**
{{2-4 sentences describing what the FLW does, in user-outcome language —
not field/form mechanics. Example: "FLW arrives at a household, opens
the Deliver app, confirms the household by name and phone, completes
the screening, photographs the MTN card, and submits. They see a
confirmation that their visit has been recorded."}}

**Edge cases (UX outcomes, not error codes):**
- {{e.g., "FLW understands why a duplicate-household submission was
  rejected and how to proceed"}}
- {{e.g., "FLW understands they cannot submit without GPS"}}

**Pass criteria:**
- {{e.g., "Journey completes in <3 minutes including form fill"}}
- {{e.g., "Required-field errors are recoverable in-form"}}

## Journey 2 — {{journey_name}}
...
```

- [ ] **Step 3: Write the skill file**

Create `skills/pdd-to-app-journeys/SKILL.md`. Frontmatter:

```markdown
---
name: pdd-to-app-journeys
description: >
  Derive opp-specific expected user journeys from an approved PDD.
  Output is `expected-journeys.md`, the UX-intent ground truth for
  `app-test-cases` (Phase 2) and `app-ux-eval` (deep QA). Mirrors
  pdd-to-test-prompts but for the apps, not the chatbot.
---
```

Body must include:
- A `## Process` section with steps: read PDD, branch on archetype, generate journeys per persona, self-evaluate coverage, write file
- An `## Archetypes` section that mirrors `pdd-to-test-prompts`:
  - `atomic-visit`: 2-4 journeys covering visit-flow, eligibility-edge, data-quality-error, duplicate-handling
  - `focus-group`: 2-4 journeys covering session-setup, recruitment-failure, consent-handling, output-coherence
  - `multi-stage`: per-stage journeys + cross-stage transition
- A `## Coverage rules` section requiring at least one `error_recovery`-flavored edge case per journey (so `app-ux-eval`'s rubric has signal)
- A `## Failure modes` and `## Mode behavior` block matching `pdd-to-test-prompts`
- A `## Change log` entry

The skill writes to `ACE/<opp>/runs/<run-id>/expected-journeys.md`. (Use the run-scoped path — see `lib/run-paths.ts`.)

- [ ] **Step 4: Wire the skill into `design-review` agent**

Modify `agents/design-review.md`. Find the existing `pdd-to-test-prompts` dispatch step. Add a parallel step right after it (same level — Phase 1 Step 3 or 4):

```markdown
### Step <N>: Generate expected user journeys

Dispatch `pdd-to-app-journeys`:
- Reads: `pdd.md`
- Writes: `expected-journeys.md`
- Halts on missing/empty PDD or missing target-FLW persona section

This skill is the UX-intent ground truth for downstream app QA. Phase 5
shallow execution and `/ace:qa-deep` both read it.
```

- [ ] **Step 5: Add to artifact manifest**

Modify `lib/artifact-manifest.ts`. Add this entry inside the `// ── Design phase (Phase 1) ─────────` block, alongside `test-prompts.md`:

```typescript
{
  path: 'expected-journeys.md',
  producedBy: 'pdd-to-app-journeys',
  consumedBy: ['app-test-cases', 'app-ux-eval', 'app-screenshot-capture'],
  phase: 'design',
  required: true,
  description: 'PDD-derived user journeys + UX edge cases. Ground truth for app-test-cases (Phase 2) and app-ux-eval (deep). Each journey carries a goal, happy-path narrative, edge cases phrased as UX outcomes, and pass criteria.',
},
```

- [ ] **Step 6: Run manifest tests**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: PASS. If it fails saying a fixture is missing the file, that's expected — the fixture-update lands in Task 8.

(If the test enforces strict fixture coverage and fails, mark this as a known-blocker for Task 8 and proceed; do not block this task on it.)

- [ ] **Step 7: Commit**

```bash
git add skills/pdd-to-app-journeys/ templates/expected-journeys-template.md \
        agents/design-review.md lib/artifact-manifest.ts
git commit -m "feat(phase-1): add pdd-to-app-journeys skill + expected-journeys.md artifact

Mirror of pdd-to-test-prompts for the app side. Emits the UX-intent
ground truth that app-test-cases (Phase 2) and app-ux-eval (deep) will
consume in subsequent commits. Artifact-manifest gets the new entry
under phase=design, required=true.

Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md"
```

---

## Task 2: New Phase 2 skill — `app-test-cases`

**Goal:** Phase 2 emits `app-test-cases.yaml` after Nova builds. Binds Phase 1 journeys to real built structure + Maestro recipe stubs. Doesn't replace `qa-plan` yet — `qa-plan` keeps running in Phase 5 until Task 5 retires it.

**Files:**
- Create: `skills/app-test-cases/SKILL.md`
- Create: `templates/app-test-cases-template.yaml`
- Modify: `agents/commcare-setup.md` (add dispatch step after Nova builds, before `app-release`)
- Modify: `lib/artifact-manifest.ts` (add `app-test-cases.yaml` entry)

- [ ] **Step 1: Read existing Phase 2 producers for context**

Read in parallel:
- `skills/pdd-to-learn-app/SKILL.md` — how Phase 2 skills read `nova_app_id` and Nova's blueprint
- `skills/qa-plan/SKILL.md` — the recipe-composition pattern we'll inherit (Steps 2 + 3)
- `mcp/mobile/recipes/static/connect-login.yaml` (and siblings in that directory) — the static-recipe palette

- [ ] **Step 2: Write the template**

Create `templates/app-test-cases-template.yaml`:

```yaml
# app-test-cases.yaml — bindings of Phase 1 journeys to Phase 2 built structure.
# Producer: app-test-cases (Phase 2)
# Consumers: app-screenshot-capture (Phase 5 shallow), /ace:qa-deep (manual deep)

opp: {{opp_name}}
run_id: {{run_id}}
generated_at: {{ISO}}
pdd_rev: {{pdd_rev_date}}
nova_apps:
  learn: {{learn_nova_app_id}}
  deliver: {{deliver_nova_app_id}}

# Each entry binds one Journey from expected-journeys.md to:
#   - the actual forms/fields it exercises (real IDs, not placeholders)
#   - a Maestro recipe filled with concrete selectors (no REPLACE_*)
#   - the structural pass criteria (boot, no crash, submit confirmation)
#
# `is_smoke: true` marks the recipe Phase 5 runs in shallow mode (one
# per app — the cheapest representative happy path).

journeys:
  - id: J1
    name: {{journey_name from expected-journeys.md}}
    app: deliver  # or learn
    is_smoke: false
    forms_exercised:
      - {{form_id_or_name}}
    fields_exercised:
      - {{field_id}}
    recipe_path: app-test-cases/recipes/J1.yaml
    structural_pass_criteria:
      - app_boots
      - no_crash
      - submission_confirmed   # or "assessment_complete" for Learn
    pdd_time_budget_seconds: {{from PDD if specified, else null}}
```

- [ ] **Step 3: Write the skill file**

Create `skills/app-test-cases/SKILL.md`:

```markdown
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

Use the same composition pattern as the retired `qa-plan` skill (read
`skills/qa-plan/SKILL.md` § Step 3 for the static-recipe palette).
Differences:

- Recipes here are journey-keyed, not module-keyed (`J1.yaml`, `J2.yaml`)
- Each journey's recipe MUST include a final
  `takeScreenshot: "sc-J<n>-final"` for the deep UX judge to grade
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

If any check fails, halt with a `[BLOCKER]` verdict.

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
| {{today}} | Initial version. Phase 2 producer for app-test-cases.yaml; binds expected-journeys.md to Nova-built structure with Maestro recipe stubs. Successor to qa-plan (retired in same release). | ACE team |
```

- [ ] **Step 4: Wire the skill into `commcare-setup` agent**

Modify `agents/commcare-setup.md`. Find the dispatch chain that goes:
`pdd-to-learn-app` → `pdd-to-deliver-app` → `app-deploy` → `app-release` → `app-test`.

Insert `app-test-cases` between `app-deploy` and `app-release` (Nova builds are uploaded via app-deploy, so the blueprint IDs are stable by then; app-release is when we can no longer rebuild the apps cheaply, so it's also the natural cutoff for "the apps are now what they are"). Step text:

```markdown
### Step <N>: Generate app-test-cases.yaml

Dispatch `app-test-cases`:
- Reads: expected-journeys.md, both app summaries, Nova blueprints
- Writes: app-test-cases.yaml + recipes/J*.yaml under app-test-cases/
- Halts on missing inputs or recipe-validation failure

Phase 5 shallow runs the smoke recipes; /ace:qa-deep runs them all.
```

- [ ] **Step 5: Add to artifact manifest**

Modify `lib/artifact-manifest.ts`. Add inside the CommCare phase block, after `deployment-summary.md`:

```typescript
{
  path: 'app-test-cases.yaml',
  producedBy: 'app-test-cases',
  consumedBy: ['app-screenshot-capture', 'app-ux-eval'],
  phase: 'commcare',
  required: true,
  description: 'Bindings of expected-journeys.md to Phase-2-built app structure: per-journey form/field IDs, Maestro recipe paths, smoke flags, structural pass criteria. Phase 5 shallow uses is_smoke: true entries; /ace:qa-deep uses all entries.',
},
```

Update consumed-by lists already in the file:
- `expected-journeys.md` → confirm `consumedBy` includes `'app-test-cases'`
- `app-summaries/learn-app-summary.md` → add `'app-test-cases'`
- `app-summaries/deliver-app-summary.md` → add `'app-test-cases'`

- [ ] **Step 6: Run manifest tests**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: PASS (modulo the fixture-coverage warning carried from Task 1).

- [ ] **Step 7: Commit**

```bash
git add skills/app-test-cases/ templates/app-test-cases-template.yaml \
        agents/commcare-setup.md lib/artifact-manifest.ts
git commit -m "feat(phase-2): add app-test-cases skill + app-test-cases.yaml artifact

Phase 2 producer for the journey→build binding layer. Composes Maestro
recipes per journey with real selectors (not REPLACE_*), marks one
smoke recipe per app for Phase 5 shallow execution. Successor to
qa-plan; qa-plan keeps running in Phase 5 until Task 5 swaps over.

Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md"
```

---

## Task 3: New deep eval skill — `app-ux-eval`

**Goal:** New LLM-as-Judge skill that grades captured screenshots against `expected-journeys.md`. Deep-only — no `--quick` mode. Used by `/ace:qa-deep` (Task 4) and the Phase 6 gate (Task 7).

**Files:**
- Create: `skills/app-ux-eval/SKILL.md`
- Modify: `lib/artifact-manifest.ts` (add `verdicts/app-ux-eval-deep.yaml`)
- Modify: `lib/verdict-schema.ts` (only if the existing schema doesn't already cover the dimensions; prefer reusing)

- [ ] **Step 1: Read existing eval skills + verdict schema**

Read in parallel:
- `skills/ocs-chatbot-eval/SKILL.md` — uniform verdict shape, hard-deduction pattern
- `lib/verdict-schema.ts` — confirm the schema is dimension-agnostic (it should be; it just stores `dimensions: { name: string; score: number; reason: string }[]`)
- `lib/parse-verdict.ts` — confirm parser is generic

If the schema is already generic, no schema edits are needed.

- [ ] **Step 2: Write the skill file**

Create `skills/app-ux-eval/SKILL.md`:

```markdown
---
name: app-ux-eval
description: >
  LLM-as-Judge over captured screenshots + expected-journeys.md.
  Per-journey verdict on UX dimensions: clarity, flow_predictability,
  error_recovery, time_budget, journey_completion. Deep-only — runs from
  /ace:qa-deep, never from /ace:run. Writes verdicts/app-ux-eval-deep.yaml
  in the uniform verdict shape so opp-eval can aggregate.
---

# App UX Eval

Grades the FLW experience of the built apps. Asks: "would this be a
good experience for the user?" and pins each judgment to concrete
PDD-derived ground truth (the journey's stated goal, time budget, edge
cases) so the rubric isn't unmoored.

## Process

### Step 1: Read inputs

- `expected-journeys.md` — ground truth
- `app-test-cases.yaml` — journey↔recipe bindings
- The captured screenshots from the recent execution run (look up by
  the run id passed in)
- `pdd.md` — for persona context (the FLW the rubric is judging "good
  experience" against)

### Step 2: For each journey, score 5 dimensions (1-3)

| Dimension | What to look for | Hard deduction → fail |
|---|---|---|
| `clarity` | Field labels and prompts unambiguous to the persona from PDD's "Target FLW" section | Any field name only a developer would understand (e.g., `q3_v2_optional`) |
| `flow_predictability` | Conditional branches go where FLW expects; skip patterns don't surprise | A screen appears or disappears with no apparent cause from the user's perspective |
| `error_recovery` | Validation errors tell the FLW what's wrong and how to fix | Dead-end errors with no recovery path |
| `time_budget` | Step count + estimated input time vs. journey's `pdd_time_budget_seconds` | Recipe step count × 5s exceeds 2× the budget |
| `journey_completion` | Recipe accomplishes the journey's stated goal end-to-end | Recipe ends without confirmation / stuck screen |

### Step 3: Aggregate

- Per-journey verdict: weighted average of dimensions, hard-deduction
  on any single dimension clamps the journey to fail
- Phase verdict: pass = all journeys pass; fail = any journey fails,
  with summary of which journeys failed which dimensions

### Step 4: Write verdict

Write `ACE/<opp>/runs/<run-id>/verdicts/app-ux-eval-deep.yaml` per the
uniform verdict shape (see `skills/README.md § Eval verdict shape` or
`lib/verdict-schema.ts`). Required fields:

- skill: app-ux-eval
- mode: deep
- timestamp: ISO with timezone
- artifact_refs: { learn_build_id, deliver_build_id } — read from
  deployment-summary.md so the Phase 6 gate can timestamp-compare
- dimensions: per-dimension scores + reasons
- per_unit_verdicts: per-journey verdicts
- overall_score, status (pass | fail), failing_units

Also append a row to `eval-calibration/app-ux-eval-runs.md` so
calibration metrics keep accumulating.

## Mode behavior

- Deep only. There is no `--quick`.

## Failure modes

- Screenshots missing for a journey marked in app-test-cases.yaml →
  halt with a `[BLOCKER]` saying which recipe didn't run
- expected-journeys.md missing → upstream Phase 1 or migration gap;
  halt with pointer
- Nova builds older than the screenshots → screenshots are stale; halt

## MCP tools used

- ace-gdrive: drive_read_file, drive_list_folder, drive_create_file
- (No mobile/MCP — this is pure judging over already-captured artifacts)

## Change log

| Date | Change | Author |
|------|--------|--------|
| {{today}} | Initial version. Deep-only LLM-as-Judge for app UX. Used by /ace:qa-deep and the Phase 6 gate. | ACE team |
```

- [ ] **Step 3: Add to artifact manifest**

Modify `lib/artifact-manifest.ts`. Add to the operate phase block (mirroring `verdicts/ocs-chatbot-eval-deep.yaml`):

```typescript
{
  path: 'verdicts/app-ux-eval-deep.yaml',
  producedBy: 'app-ux-eval',
  consumedBy: ['llo-launch', 'opp-eval'],
  phase: 'operate',
  required: false,
  description: 'Machine-readable verdict from app-ux-eval (deep). Read by llo-launch (Phase 6 activation gate) for freshness check vs. latest released CommCare build, and by opp-eval for cross-skill aggregation. Required to be fresh and passing for go-live; absent if /ace:qa-deep has not been run.',
},
```

- [ ] **Step 4: Run manifest tests + verdict-schema tests**

Run in parallel:
- `npm test -- test/fixtures/artifact-manifest.test.ts`
- `npm test -- test/lib/verdict-schema.test.ts` (if the path exists)

Expected: PASS. The new skill produces the same shape so no test changes needed.

- [ ] **Step 5: Commit**

```bash
git add skills/app-ux-eval/ lib/artifact-manifest.ts
git commit -m "feat: add app-ux-eval skill for deep app UX grading

LLM-as-Judge over captured screenshots + expected-journeys.md. Five
dimensions (clarity, flow_predictability, error_recovery, time_budget,
journey_completion), each with a hard-deduction rule. Deep-only —
called from /ace:qa-deep (next task) and gated by Phase 6 in Task 7.

Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md"
```

---

## Task 4: New `/ace:qa-deep <opp>` slash command

**Goal:** Manual deep-QA surface. Thin wrapper that dispatches deep-mode versions of the existing OCS qa+eval pair plus the new `app-ux-eval`.

**Files:**
- Create: `commands/qa-deep.md`
- Modify: `commands/run.md` (add a one-line "deep QA is no longer part of /ace:run; see /ace:qa-deep")

- [ ] **Step 1: Read existing slash commands for the format**

Read in parallel:
- `commands/run.md`
- `commands/step.md`
- `commands/eval.md`

Note the frontmatter schema (`description`, `argument-hint`, etc.) and how multi-arg commands handle flags.

- [ ] **Step 2: Write `commands/qa-deep.md`**

```markdown
---
description: Run deep QA (OCS + apps) against an existing opportunity. Manual gate, not part of /ace:run.
argument-hint: <opp-name> [--ocs-only | --apps-only] [--since=<verdict-id>]
---

# /ace:qa-deep — Manual Deep QA

Triggers a full LLM-as-Judge quality assessment of an opportunity that
already has a successful /ace:run behind it.

## Inputs read from Drive (`ACE/$1/`)

- `pdd.md`, `test-prompts.md` (OCS deep ground truth)
- `expected-journeys.md`, `app-test-cases.yaml` (app deep ground truth)
- The published OCS chatbot's current configuration
- The latest released CommCare builds (Learn + Deliver)

## What this does

Run the following dispatches in this order:

### Stage A — OCS deep (skip if `--apps-only`)

1. Dispatch `ocs-chatbot-qa --deep` for $1
2. Dispatch `ocs-chatbot-eval --deep` for $1

Writes:
- qa-captures/<date>-ocs-chat-deep.md
- verdicts/ocs-chatbot-eval-deep.yaml
- gate-briefs/ocs-chatbot-eval-deep.md

### Stage B — Apps deep (skip if `--ocs-only`)

1. Read `app-test-cases.yaml` for the run.
2. If `--since=<verdict-id>` is provided: filter to journeys whose
   `recipe_path` mtime is newer than the prior verdict at
   `verdicts/app-ux-eval-deep.yaml@<verdict-id>`. Otherwise run all.
3. For each journey: call `mobile_run_recipe` against a fresh AVD,
   capture screenshots, upload to Drive under
   `screenshots/qa-deep/<journey-id>/`.
4. Dispatch `app-ux-eval` to grade the captured set.

Writes:
- screenshots/qa-deep/J*/*.png
- verdicts/app-ux-eval-deep.yaml
- eval-calibration/app-ux-eval-runs.md (appended row)

## What this does NOT do

- No /ace:run side effects. No Phase 6 activation, no app rebuild, no
  training-material regeneration.
- No FLW invites, no LLO emails.

## After completion

Both verdicts go to `verdicts/*-deep.yaml`. The Phase 6 `llo-launch`
gate reads them and refuses activation if either is missing or stale.

If you ran this and want to proceed to go-live, re-enter Phase 6 via
/ace:step llo-launch $1 (or let /ace:run resume from where it left off).
```

- [ ] **Step 3: Update `commands/run.md`**

Find the "What this does" section. Add a single bullet noting the change:

```markdown
- Phase 4 (OCS) and Phase 5 (apps) run **shallow** QA only. Deep
  quality assessment is a separate command — see /ace:qa-deep <opp>.
  Phase 6 activation will refuse to proceed without fresh deep
  verdicts (run /ace:qa-deep before go-live).
```

- [ ] **Step 4: Sanity-test the command file lints**

Run: `npx tsx scripts/sync-version.sh --dry-run` (or whatever the repo's command-validator is — check `bin/ace-doctor` for hints).

If the repo doesn't have a command linter, skip — the command is just markdown frontmatter that Claude Code parses.

- [ ] **Step 5: Commit**

```bash
git add commands/qa-deep.md commands/run.md
git commit -m "feat: add /ace:qa-deep command for manual deep quality assessment

Thin wrapper that dispatches OCS deep qa+eval + new app-ux-eval. Read-
and-grade only — no run side effects. Supports --ocs-only / --apps-only
for surgical re-runs, --since=<verdict-id> for incremental app grading.

Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md"
```

---

## Task 5: Switch Phase 5 to executor-only; retire `qa-plan`

**Goal:** Phase 5 stops synthesizing test plans. `app-screenshot-capture` reads `app-test-cases.yaml`, runs only smoke recipes, and adds a thin UX judge per app. The `qa-plan` skill becomes dead code (deleted in Task 8).

**Files:**
- Modify: `skills/app-screenshot-capture/SKILL.md`
- Modify: `agents/qa-and-training.md`
- Modify: `lib/artifact-manifest.ts` (drop qa-plan/* artifacts; add app-ux-shallow verdict)

- [ ] **Step 1: Read current Phase 5 wiring**

Read in parallel:
- `agents/qa-and-training.md`
- `skills/app-screenshot-capture/SKILL.md`

Confirm the existing dispatch order. Phase 5 should look like:
1. `qa-plan` (will be removed)
2. `app-screenshot-capture` (modified to read new artifact)
3. Per-artifact training skills in parallel
4. `training-deck-build`

- [ ] **Step 2: Modify `skills/app-screenshot-capture/SKILL.md`**

Edits:
- Replace the current input list ("reads `qa-plan/test-matrix.md`,
  `qa-plan/walkthrough-recipes/manifest.yaml`...") with:
  - `expected-journeys.md`
  - `app-test-cases.yaml`
- Add a new Step labeled "Filter to smoke recipes":
  ```markdown
  ### Step <N>: Select smoke recipes only
  Read `app-test-cases.yaml`. Filter `journeys[]` to entries with
  `is_smoke: true`. There MUST be exactly two (one per app — Learn
  and Deliver). Halt with a clear pointer to `app-test-cases` if
  fewer or more are found.
  ```
- After the existing screenshot-capture loop, add a new Step labeled
  "Thin UX smoke judge":
  ```markdown
  ### Step <N>: Thin UX smoke judge

  For each smoke recipe (Learn + Deliver), assemble the captured
  screenshot set into a single LLM-as-Judge call:

  Prompt: "These screenshots are from a smoke run of the {{app}}
  app. The target FLW persona (from PDD) is: {{persona_summary}}.
  Looking at these screenshots in order, would this person be able
  to complete the journey without confusion? Rate 0-3 + one-line
  reason. 0 = a typical persona-matching FLW would get stuck; 3 =
  obviously usable."

  Threshold: ≥ 2/3 per app. Below → halt with verdict.
  ```
- Update the verdict-writing section to also write
  `ACE/<opp>/runs/<run-id>/verdicts/app-screenshot-capture-shallow.yaml`
  with the smoke-judge dimension.

- [ ] **Step 3: Modify `agents/qa-and-training.md`**

Find the `qa-plan` dispatch step. Delete it. Adjust the now-first
step (`app-screenshot-capture`) to note that its inputs come from
upstream phases:

```markdown
### Step 1: Capture smoke screenshots + thin UX judge

Dispatch `app-screenshot-capture`:
- Reads: expected-journeys.md (Phase 1), app-test-cases.yaml (Phase 2)
- Writes: screenshots/J*/*.png + verdicts/app-screenshot-capture-shallow.yaml
- Halts on smoke-recipe failure or UX judge < 2/3
```

Confirm downstream training-skill dispatches still consume
`screenshots/manifest.yaml` (they do — `app-screenshot-capture` still
emits it).

- [ ] **Step 4: Update artifact manifest**

Modify `lib/artifact-manifest.ts`:

(a) Drop the `qa-plan/*` entries (test-matrix, walkthrough-recipes/*, screenshot-manifest, uat-checklist, verdicts/qa-plan.yaml).
(b) Drop the `test-results/*` entries produced by `app-test`.
(c) Add the new shallow verdict:

```typescript
{
  path: 'verdicts/app-screenshot-capture-shallow.yaml',
  producedBy: 'app-screenshot-capture',
  consumedBy: ['opp-eval'],
  phase: 'operate',
  required: true,
  description: 'Shallow smoke verdict from /ace:run Phase 5 — smoke recipe pass/fail + thin UX judge ≥ 2/3 per app. Always present after a successful /ace:run.',
},
```

(d) Update consumed-by lists: anything that listed `qa-plan` or `app-test` as consumer/producer needs the references removed.

- [ ] **Step 5: Run manifest tests**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: PASS. Fixtures may need updating if they reference the dropped paths — handle in Task 8 if so.

- [ ] **Step 6: Commit**

```bash
git add skills/app-screenshot-capture/ agents/qa-and-training.md \
        lib/artifact-manifest.ts
git commit -m "refactor(phase-5): executor-only — drop qa-plan synthesis

app-screenshot-capture now reads expected-journeys.md (Phase 1) and
app-test-cases.yaml (Phase 2) as inputs. Runs the two smoke recipes
flagged is_smoke: true (one per app), captures screenshots, runs a
single-question UX judge per app (~2 LLM calls total). Drops qa-plan
artifacts from the manifest; the qa-plan skill itself is deleted in
Task 8 once retirement settles.

Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md"
```

---

## Task 6: Thin OCS `--quick`; drop Phase 4 deep gate

**Goal:** OCS shallow (Phase 4 default) collapses to 3 prompts × 1 dimension. Deep no longer runs in Phase 4 — it lives only in `/ace:qa-deep`.

**Files:**
- Modify: `skills/ocs-chatbot-qa/SKILL.md`
- Modify: `skills/ocs-chatbot-eval/SKILL.md`
- Modify: `agents/ocs-setup.md`

- [ ] **Step 1: Read current OCS skill files**

Read:
- `skills/ocs-chatbot-qa/SKILL.md`
- `skills/ocs-chatbot-eval/SKILL.md`
- `agents/ocs-setup.md`

Find the section in each that defines `--quick` behavior.

- [ ] **Step 2: Thin `ocs-chatbot-qa` `--quick`**

Modify `skills/ocs-chatbot-qa/SKILL.md`:
- In the `--quick` mode section, change "5 smoke prompts" to "3 smoke prompts" (universal Connect-domain questions: 1 about claiming an opp, 1 about syncing data, 1 about getting paid)
- Tighten the timeout: total cap = 90s × 3 = 270s
- Note in the change log: "Thinned from 5 to 3 prompts (0.x.0). Phase 4 cost reduction; multi-dimensional judging moves to deep-only."

- [ ] **Step 3: Thin `ocs-chatbot-eval` `--quick`**

Modify `skills/ocs-chatbot-eval/SKILL.md`:
- In the `--quick` mode section, replace the 5-dimension grading rubric with a single-dimension `overall_quality_0_to_3`
- Pass criterion: every prompt's `overall_quality` ≥ 2/3
- Verdict path stays `verdicts/ocs-chatbot-eval-quick.yaml` but the
  dimensions array now has 1 entry
- Note in the change log

- [ ] **Step 4: Drop the `--deep` gate from `agents/ocs-setup.md`**

In `agents/ocs-setup.md`, find the "Step 3: Deep eval" section (or
equivalent). Delete the entire deep-eval step. Adjust step numbering
in the rest of the agent.

In the Phase 4 gate-brief section, change "deep verdict" references
to "quick verdict" — Phase 4 → 5 only requires the quick gate now.

Add a paragraph at the end of the agent's overview:

```markdown
**Note:** Deep OCS evaluation moved out of Phase 4 in 0.x.0. Run
/ace:qa-deep <opp> after /ace:run completes to grade chatbot quality
before go-live. The Phase 6 llo-launch gate refuses to proceed
without a fresh, passing deep verdict.
```

- [ ] **Step 5: Run OCS-related tests**

Run in parallel:
- `npm test -- test/mcp/ocs/` (unit tests, no live OCS)
- `npm test -- test/fixtures/artifact-manifest.test.ts`

Expected: PASS. (Integration tests OCS_INTEGRATION=1 are out of scope here — those exercise live OCS and are a separate CI concern.)

- [ ] **Step 6: Commit**

```bash
git add skills/ocs-chatbot-qa/ skills/ocs-chatbot-eval/ agents/ocs-setup.md
git commit -m "refactor(phase-4): thin --quick to 3 prompts × 1 dim; drop Phase 4 deep gate

OCS shallow collapses from 5 prompts × 5 dims (~25 calls) to 3 prompts
× 1 dim (overall_quality_0_to_3, 3 calls). Phase 4 → 5 gate is now
quick-pass-only. Deep OCS eval moves entirely to /ace:qa-deep.

Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md"
```

---

## Task 7: Wire Phase 6 deep-verdict gate

**Goal:** `llo-launch` reads both deep verdicts before activation. Refuses if missing, stale, or failing. Adds an override flag with audit trail.

**Files:**
- Modify: `skills/llo-launch/SKILL.md`
- Modify: `bin/ace-doctor` (add a freshness check that mirrors the gate)
- Modify: `agents/llo-manager.md` (note the new gate behavior)

- [ ] **Step 1: Read current `llo-launch`**

Read: `skills/llo-launch/SKILL.md`. Identify the step that calls
`connect_activate_opportunity`.

- [ ] **Step 2: Add the gate to `llo-launch`**

Insert a new step **immediately before** the activation call:

```markdown
### Step <N>: Verify deep-QA verdicts before activation

Read these two files from `ACE/<opp>/runs/<run-id>/`:
- `verdicts/ocs-chatbot-eval-deep.yaml`
- `verdicts/app-ux-eval-deep.yaml`

For each verdict, require:

1. File exists.
2. `status: pass`.
3. Verdict timestamp is newer than the relevant artifact:
   - OCS verdict: newer than the chatbot's last `published_at`
     (read via `ocs_get_chatbot`)
   - App verdict: newer than the latest released CommCare build
     timestamp (read from `deployment-summary.md`)

If ANY check fails, halt with [BLOCKER]:

> Deep QA verdicts missing or stale.
> Run /ace:qa-deep <opp> before activation.
> Missing: <list of failing checks>

### Step <N+1>: Override (operator-only, audited)

If the activation includes the flag `--override-deep-qa-gate=<reason>`,
skip the gate. Required:
- The flag must include a non-empty reason
- /ace:run cannot pass this flag (only /ace:step llo-launch can)
- Append to `comms-log/observations.md`:
  > YYYY-MM-DD HH:MM TZ — Deep-QA gate overridden during activation.
  > Reason: <reason>. Operator: <ace user>. Verdicts at time of override:
  > <ocs-status> / <app-status>.

### Step <N+2>: Activate the opportunity (existing step)

(Preserve the existing connect_activate_opportunity call.)
```

Also update the skill's frontmatter description to mention the new gate.

- [ ] **Step 3: Add a freshness check to `bin/ace-doctor`**

Read `bin/ace-doctor`. Find the section reporting on per-opp verdicts
(if any; if not, this becomes a new section).

Add a new check `[deep-qa-freshness]` that, given an opp name:
1. Reads `verdicts/ocs-chatbot-eval-deep.yaml` if present
2. Reads `verdicts/app-ux-eval-deep.yaml` if present
3. For each: compare timestamp to the artifact it grades
4. Reports: PASS / WARN (one is missing) / FAIL (one is stale)

This is advisory in doctor (WARN-level), not a blocker. The actual
enforcement is the gate in `llo-launch`.

- [ ] **Step 4: Update `agents/llo-manager.md`**

Find the description of the `llo-launch` dispatch. Add a note:

```markdown
**Note:** llo-launch enforces a deep-QA-verdict freshness gate before
activation in 0.x.0+. If /ace:qa-deep hasn't been run since the most
recent app release / chatbot publish, llo-launch halts with a
[BLOCKER] and the operator must run /ace:qa-deep <opp> before resuming.
```

- [ ] **Step 5: Run tests**

Run: `npm test -- test/`
Expected: PASS. Existing tests don't cover the new gate (it's prompt-side); integration coverage comes from a manual test on a fixture opp in Task 9.

- [ ] **Step 6: Commit**

```bash
git add skills/llo-launch/ bin/ace-doctor agents/llo-manager.md
git commit -m "feat(phase-6): gate llo-launch on fresh deep-QA verdicts

Before connect_activate_opportunity, llo-launch reads both deep
verdicts (OCS + apps), checks they exist + pass + are newer than the
artifacts they grade. Halts with [BLOCKER] otherwise. Override flag
--override-deep-qa-gate=<reason> bypasses with audit trail in
comms-log/observations.md (only available via /ace:step, not /ace:run).
Doctor adds a WARN-level freshness check.

Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md"
```

---

## Task 8: Retire `qa-plan` and `app-test`; migration script

**Goal:** Delete the dead skills, update fixtures, write the migration doc, bump version.

**Files:**
- Delete: `skills/qa-plan/` (entire directory)
- Delete: `skills/app-test/` (entire directory)
- Create: `migrations/0.x.0-shallow-deep-qa.md`
- Modify: `test/fixtures/...` (remove references to retired artifacts)
- Modify: `VERSION` (bump per `scripts/version-bump.sh`)
- Modify: `CHANGELOG.md` (entry for 0.x.0)

- [ ] **Step 1: Find every reference to retired skills**

Run in parallel:
- `git grep -l 'qa-plan' -- skills/ agents/ commands/ lib/ test/`
- `git grep -l 'app-test' -- skills/ agents/ commands/ lib/ test/ -- ':!skills/app-test-cases'`

Note: `app-test-cases` (the new skill) shouldn't be matched by the
second grep — that's why we exclude its directory.

- [ ] **Step 2: Remove references**

For each file that references `qa-plan` or `app-test` (the retired ones):
- Skill markdown files: delete the line / paragraph referencing them
- Agent markdown files: confirm they were already updated in Tasks 1, 2, 5; if not, update now
- `lib/artifact-manifest.ts`: confirm Task 5's edits removed all entries for these skills (no `producedBy: 'qa-plan'` or `producedBy: 'app-test'` remaining)
- Tests: update fixtures so they no longer expect `qa-plan/*` or `test-results/*` files

- [ ] **Step 3: Delete the skill directories**

```bash
git rm -r skills/qa-plan/ skills/app-test/
```

- [ ] **Step 4: Write the migration doc**

Create `migrations/0.x.0-shallow-deep-qa.md`:

```markdown
# Migration: 0.x.0 — Shallow / Deep QA Split

**Date:** YYYY-MM-DD

## What changed

- New skills: `pdd-to-app-journeys` (Phase 1), `app-test-cases` (Phase 2),
  `app-ux-eval` (deep, manual)
- New artifacts: `expected-journeys.md`, `app-test-cases.yaml`,
  `verdicts/app-ux-eval-deep.yaml`, `verdicts/app-screenshot-capture-shallow.yaml`
- New command: `/ace:qa-deep <opp>`
- Modified: OCS `--quick` thinned to 3×1 dim; `app-screenshot-capture`
  reads new artifacts; `llo-launch` gates on deep verdicts
- Retired: `qa-plan`, `app-test` skills + their artifacts

## In-flight opportunities (mid-/ace:run when 0.x.0 lands)

If an opp's run had completed Phase 1 but not Phase 2 before this update:
- Re-run Phase 1 just for the new artifact:
  `/ace:step pdd-to-app-journeys <opp>`
- Resume from where Phase 2 left off

If an opp had completed Phase 5 (qa-plan + app-screenshot-capture) on
the old shape:
- The old artifacts (qa-plan/*) remain in Drive; nothing reads them.
  Safe to leave.
- For deep QA, run `/ace:qa-deep <opp>` to populate the new verdicts.

## Activation gate (Phase 6)

Existing opps that completed Phase 5 on the old shape but have NOT yet
been activated will hit the new deep-QA gate. Run `/ace:qa-deep <opp>`
before `/ace:step llo-launch`. If you must bypass for emergency
activation: `/ace:step llo-launch <opp> --override-deep-qa-gate="<reason>"`
(reason is required; gets logged to `comms-log/observations.md`).

## Cost impact

- /ace:run shallow QA: ~5 LLM judge calls (was ~90)
- /ace:qa-deep (manual, optional): ~65 OCS + per-journey app
- Net: /ace:run cycles cheaper; deep grading is now opt-in

## Rollback

Revert to <commit before this PR>. The old qa-plan + app-test skills
return; the new artifacts in Drive are ignored. No Drive data loss.
```

- [ ] **Step 5: Bump version**

Run: `bash scripts/version-bump.sh`

This fetches origin/main, picks `max(local, origin) + patch+1`, and
syncs the four version files. Capture the new version (e.g., `0.x.0`).

Edit `migrations/0.x.0-shallow-deep-qa.md` to replace `0.x.0` with the
real version. Same for the change-log entries inside skill files
(Task 1 step 7 commit body, Task 2 step 7 commit body, etc. — for the
log table dates). If those changelog tables already have the literal
`0.x.0`, replace via `git grep '0\.x\.0' | grep -v 0.x.0-shallow` and
inspect.

- [ ] **Step 6: Update `CHANGELOG.md`**

Add a section at the top:

```markdown
## 0.x.0 — Shallow / Deep QA Split

- New: /ace:qa-deep <opp> for manual deep quality assessment
- New: pdd-to-app-journeys (Phase 1), app-test-cases (Phase 2),
  app-ux-eval (deep) skills
- Changed: /ace:run does shallow QA only — ~5 LLM judge calls vs ~90
  before. Phase 6 llo-launch refuses activation without fresh deep
  verdicts (override available with audit reason).
- Retired: qa-plan, app-test skills (replaced by upstream producers)
- Migration: see migrations/0.x.0-shallow-deep-qa.md
- Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`

Expected: PASS. Any fixture-coverage failures from earlier tasks should
now be fixed (since fixtures were updated in Step 2 above).

- [ ] **Step 8: Commit**

```bash
git add migrations/ CHANGELOG.md VERSION package.json \
        .claude-plugin/plugin.json .claude-plugin/marketplace.json \
        skills/qa-plan/ skills/app-test/ \
        test/fixtures/
git commit -m "chore(0.x.0): retire qa-plan + app-test, migration doc, version bump

Wraps the shallow/deep QA split. qa-plan and app-test skills + their
artifacts are removed (their jobs moved to pdd-to-app-journeys,
app-test-cases, and app-ux-eval). Migration notes for in-flight opps
in migrations/. Version bumped via scripts/version-bump.sh.

Spec: docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md"
```

---

## Task 9: End-to-end smoke against a test fixture

**Goal:** Verify the new path runs end-to-end on a fixture opp before
shipping. Doesn't replace integration tests (those are CI-time); this
is a one-time confidence check that the wiring works.

**Files:**
- Read: `test/fixtures/CRISPR-Test-001/...` (atomic-visit golden fixture)
- Possibly modify: fixture files to include the new artifacts

- [ ] **Step 1: Pick the smallest existing fixture**

Read: `test/fixtures/` — find the CRISPR-Test-001 atomic-visit fixture.

- [ ] **Step 2: Verify or backfill the fixture's new artifacts**

Confirm or create:
- `expected-journeys.md`
- `app-test-cases.yaml` (with at least one `is_smoke: true` per app)
- Sample `verdicts/app-ux-eval-deep.yaml` (passing)

If any are missing, hand-write minimal versions matching the templates
from Tasks 1+2.

- [ ] **Step 3: Run manifest validation against the fixture**

Run: `npm test -- test/fixtures/artifact-manifest.test.ts`
Expected: PASS for the updated fixture.

- [ ] **Step 4: Dry-run the new skills against the fixture**

The dry-run paths from each skill write under `comms-log/dry-run-*`.
Confirm:
- `pdd-to-app-journeys` dry-run produces a non-empty journeys file
- `app-test-cases` dry-run produces yaml with at least the bindings
  (recipes can be stubbed)
- `/ace:qa-deep` dry-run prints the planned dispatches without running them

(If dry-run plumbing isn't wired in your skill body for a given step,
that's fine — we're checking inputs/outputs, not exhaustive dry-run
coverage.)

- [ ] **Step 5: Commit fixture updates if any**

```bash
git add test/fixtures/
git commit -m "test(fixture): add new shallow-deep-qa artifacts to CRISPR-Test-001

expected-journeys.md, app-test-cases.yaml, app-ux-eval-deep verdict
sample. Lets manifest validation pass and provides a known-good fixture
for future regressions."
```

---

## Self-Review

After writing this plan I checked it against the spec:

**Spec coverage:**
- §1 Artifact ownership → Tasks 1, 2, 5 (artifact moves + manifest edits)
- §2 Skill changes (new/retired/changed) → Tasks 1–8 cover every entry
- §3 Shallow path (OCS + apps) → Tasks 5, 6
- §4 Deep app UX rubric → Task 3
- §5 /ace:qa-deep → Task 4
- §6 Phase 6 deep-verdict gate → Task 7
- Migration / rollout → Task 8
- Open questions (1)–(4) noted in the spec are intentionally not
  blockers; they get iterated post-ship.

**Placeholder scan:** No `TBD` / `TODO` / "implement later" / "add validation". The dimension table is fully filled in (Task 3 step 2). Each skill body has its `## Process` section spelled out. Version numbers are intentionally `0.x.0` until Task 8 step 5 resolves the actual bump.

**Type consistency:**
- Verdict file names align across tasks: `app-ux-eval-deep.yaml` (Tasks 3, 4, 7), `ocs-chatbot-eval-deep.yaml` (Tasks 4, 7), `app-screenshot-capture-shallow.yaml` (Task 5)
- Smoke flag spelled `is_smoke: true` consistently (Tasks 2, 5)
- Skill names: `pdd-to-app-journeys`, `app-test-cases`, `app-ux-eval` consistent across all tasks
- Artifact paths use `runs/<run-id>/` shape consistently (matches `lib/run-paths.ts` convention)

**Order dependency check:**
- Tasks 1–4 are additive and don't break the running pipeline
- Task 5 swaps Phase 5 over to the new artifacts — depends on Tasks 1, 2, 3 having shipped first
- Task 6 thins OCS — independent of Tasks 1–5; can run in any order after Task 4
- Task 7 wires Phase 6 — depends on Task 3 (verdict producer must exist) and Task 4 (gate references /ace:qa-deep in error messages)
- Task 8 retires dead code — must come last
- Task 9 verifies — must come last

The plan is implementable end-to-end as written. Migration ordering preserves a working pipeline at every commit.
