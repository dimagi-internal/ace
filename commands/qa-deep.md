---
description: Run deep QA (OCS + apps) against an existing opportunity. Manual gate, not part of /ace:run.
argument-hint: <opp-name> [--ocs-only | --apps-only]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion, mcp__plugin_ace_ace-mobile__mobile_run_recipe]
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
- qa-captures/YYYY-MM-DD-ocs-chat-deep.md
- verdicts/ocs-chatbot-eval-deep.yaml
- gate-briefs/ocs-chatbot-eval-deep.md

### Stage B — Apps deep (skip if `--ocs-only`)

1. Read `app-test-cases.yaml` for the run.
2. For each journey: call `mobile_run_recipe` against a fresh AVD,
   capture screenshots into `ACE/<opp>/runs/<run-id>/screenshots/`,
   appending entries to `screenshots/manifest.yaml`. Deep runs may
   overwrite or augment screenshots from a prior shallow Phase 5 run —
   the deep set is authoritative when both exist.
3. Dispatch `app-ux-eval` to grade the captured set.

Writes:
- screenshots/*.png (full per-journey set, supersedes any shallow run)
- screenshots/manifest.yaml (updated)
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
/ace:step llo-launch $1. /ace:qa-deep only writes verdicts and
screenshots — it does not touch `run_state.yaml`, so `/ace:run` resume
will pick up at whatever phase the run last halted at.

### Future enhancements

- `--since=<verdict-id>` for incremental app re-grading (re-run only
  journeys whose recipes changed) is deferred to a future release;
  see plan §5 (`/ace:qa-deep` command) note on optional v1 flags.
