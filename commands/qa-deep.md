---
description: Run deep QA (OCS + apps) against an existing opportunity. Manual gate, not part of /ace:run.
argument-hint: <opp-name> [--ocs-only | --apps-only]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion, mcp__plugin_ace_ace-mobile__mobile_run_recipe, mcp__plugin_ace_ace-mobile__mobile_resolve_selectors, mcp__plugin_ace_ace-mobile__mobile_validate_recipe, mcp__plugin_nova_nova__get_form, mcp__plugin_nova_nova__get_app]
---

# /ace:qa-deep — Manual Deep QA

Triggers a full LLM-as-Judge quality assessment of an opportunity that
already has a successful /ace:run behind it.

## Inputs read from Drive (`ACE/$1/`)

- `inputs/pdd.md`, `runs/<run-id>/2-scenarios/pdd-to-test-prompts.md` (OCS deep ground truth)
- `runs/<run-id>/2-scenarios/pdd-to-app-journeys.md`, `runs/<run-id>/3-commcare/app-test-cases.yaml` (app deep ground truth)
- The published OCS chatbot's current configuration
- The latest released CommCare builds (Learn + Deliver)

## What this does

Run the following dispatches in this order:

### Stage A — OCS deep (skip if `--apps-only`)

1. Dispatch `ocs-chatbot-qa --deep` for $1
2. Dispatch `ocs-chatbot-eval --deep` for $1

Writes (under `ACE/$1/runs/<run-id>/5-ocs/`):
- ocs-chatbot-qa_transcript-deep.md
- ocs-chatbot-eval_verdict-deep.yaml
- ocs-chatbot-eval_report-deep.md
- ocs-chatbot-eval_gate-brief-deep.md

### Stage B — Apps deep (skip if `--ocs-only`)

1. Read `3-commcare/app-test-cases.yaml` for the run.
2. **Lazy deep-recipe generation — generate the deferred deep recipes
   ON DEMAND before executing them.** Phase 3 (`app-test-cases`) authors
   Maestro recipe files only for the two `is_smoke: true` journeys; every
   non-smoke (deep) journey is carried in the catalog with
   `recipe: deferred` (the literal string, not a path) and has NO recipe
   file yet. This is the only place deep recipes are generated (the
   lazy-generation design tracked as jjackson/ace#605 — `/ace:run`'s
   Phase 6 never needs them). For each catalog journey whose `recipe` is
   `deferred`:
   1. Compose the Maestro recipe using the **same composition rules
      `app-test-cases` uses** — see `skills/app-test-cases/SKILL.md`
      § Step 3 (static palette in `mcp/mobile/recipes/static/`, live form
      labels from Nova `get_form` against the run's released app, the
      MANDATORY quiz answer-tap rule, and the strict selector placeholder
      gate). The Nova `app_id` is recorded in the catalog
      (`nova_apps.{learn,deliver}`) / the Phase 3 app summaries, and
      `get_form` still returns the as-built structure within a run, so
      authoring at qa-deep time is safe — the "author before app-release
      freezes it" concern does NOT apply within a single run.
   2. Run the § Step 3.4 selector-resolution gate
      (`mobile_resolve_selectors`) over the composed recipe; halt with a
      `[BLOCKER]` if `unresolved` is non-empty (same contract as Phase 3).
      Validate via `mobile_validate_recipe`.
   3. Write the recipe to
      `ACE/<opp>/runs/<run-id>/3-commcare/recipes/journey-<app>-<slug>.yaml`
      and update that catalog entry's `recipe:` from `deferred` to the
      written path (so a re-run of `/ace:qa-deep` is idempotent — already
      -generated deep recipes are reused, not regenerated).
   (Smoke journeys already have authored recipe files from Phase 3 — leave
   them as-is.)
3. For each journey: call `mobile_run_recipe` against a fresh AVD,
   capture screenshots into
   `ACE/<opp>/runs/<run-id>/6-qa-and-training/screenshots/`, appending
   entries to `6-qa-and-training/app-screenshot-capture_manifest.yaml`.
   Deep runs may overwrite or augment screenshots from a prior shallow
   Phase 6 run — the deep set is authoritative when both exist.
4. Dispatch `app-ux-eval` to grade the captured set.

Writes:
- 3-commcare/recipes/journey-<app>-<slug>.yaml (lazily generated for each `recipe: deferred` deep journey on first qa-deep run)
- 3-commcare/app-test-cases.yaml (updated — each generated deep journey's `recipe:` flipped from `deferred` to its written path)
- 6-qa-and-training/screenshots/*.png (full per-journey set, supersedes any shallow run)
- 6-qa-and-training/app-screenshot-capture_manifest.yaml (updated)
- 6-qa-and-training/app-ux-eval_verdict-deep.yaml
- ACE/$1/eval-calibration/app-ux-eval-runs.md (opp-level audit trail; appended row)

## What this does NOT do

- No /ace:run side effects. No Phase 9 activation, no app rebuild, no
  training-material regeneration.
- No FLW invites, no LLO emails.

## After completion

Both verdicts land at the run-scoped paths above
(`5-ocs/ocs-chatbot-eval_verdict-deep.yaml` and
`6-qa-and-training/app-ux-eval_verdict-deep.yaml`). The Phase 9
`llo-launch` gate reads them and refuses activation if either is
missing or stale.

If you ran this and want to proceed to go-live, re-enter Phase 9 via
/ace:step llo-launch $1. /ace:qa-deep only writes verdicts and
screenshots — it does not touch `run_state.yaml`, so `/ace:run` resume
will pick up at whatever phase the run last halted at.

### Future enhancements

- `--since=<verdict-id>` for incremental app re-grading (re-run only
  journeys whose recipes changed) is deferred to a future release;
  see plan §5 (`/ace:qa-deep` command) note on optional v1 flags.
