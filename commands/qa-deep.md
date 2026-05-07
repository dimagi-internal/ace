---
description: Run deep QA (OCS + apps) against an existing opportunity. Manual gate, not part of /ace:run.
argument-hint: <opp-name> [--ocs-only | --apps-only]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion, mcp__plugin_ace_ace-mobile__mobile_run_recipe]
---

# /ace:qa-deep — Manual Deep QA

Triggers a full LLM-as-Judge quality assessment of an opportunity that
already has a successful /ace:run behind it.

## Inputs read from Drive (`ACE/$1/`)

- `inputs/pdd.md`, `runs/<run-id>/1-design/pdd-to-test-prompts.md` (OCS deep ground truth)
- `runs/<run-id>/1-design/pdd-to-app-journeys.md`, `runs/<run-id>/2-commcare/app-test-cases.yaml` (app deep ground truth)
- The published OCS chatbot's current configuration
- The latest released CommCare builds (Learn + Deliver)

## What this does

Run the following dispatches in this order:

### Stage A — OCS deep (skip if `--apps-only`)

1. Dispatch `ocs-chatbot-qa --deep` for $1
2. Dispatch `ocs-chatbot-eval --deep` for $1

Writes (under `ACE/$1/runs/<run-id>/4-ocs/`):
- ocs-chatbot-qa_transcript-deep.md
- ocs-chatbot-eval_verdict-deep.yaml
- ocs-chatbot-eval_report-deep.md
- ocs-chatbot-eval_gate-brief-deep.md

### Stage B — Apps deep (skip if `--ocs-only`)

1. Read `2-commcare/app-test-cases.yaml` for the run.
2. For each journey: call `mobile_run_recipe` against a fresh AVD,
   capture screenshots into
   `ACE/<opp>/runs/<run-id>/5-qa-and-training/screenshots/`, appending
   entries to `5-qa-and-training/app-screenshot-capture_manifest.yaml`.
   Deep runs may overwrite or augment screenshots from a prior shallow
   Phase 5 run — the deep set is authoritative when both exist.
3. Dispatch `app-ux-eval` to grade the captured set.

Writes:
- 5-qa-and-training/screenshots/*.png (full per-journey set, supersedes any shallow run)
- 5-qa-and-training/app-screenshot-capture_manifest.yaml (updated)
- 5-qa-and-training/app-ux-eval_verdict-deep.yaml
- ACE/$1/eval-calibration/app-ux-eval-runs.md (opp-level audit trail; appended row)

## What this does NOT do

- No /ace:run side effects. No Phase 8 activation, no app rebuild, no
  training-material regeneration.
- No FLW invites, no LLO emails.

## After completion

Both verdicts land at the run-scoped paths above
(`4-ocs/ocs-chatbot-eval_verdict-deep.yaml` and
`5-qa-and-training/app-ux-eval_verdict-deep.yaml`). The Phase 8
`llo-launch` gate reads them and refuses activation if either is
missing or stale.

If you ran this and want to proceed to go-live, re-enter Phase 8 via
/ace:step llo-launch $1. /ace:qa-deep only writes verdicts and
screenshots — it does not touch `run_state.yaml`, so `/ace:run` resume
will pick up at whatever phase the run last halted at.

### Future enhancements

- `--since=<verdict-id>` for incremental app re-grading (re-run only
  journeys whose recipes changed) is deferred to a future release;
  see plan §5 (`/ace:qa-deep` command) note on optional v1 flags.
