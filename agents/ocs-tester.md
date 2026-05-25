---
name: ocs-tester
description: >
  Test and evaluate an ACE OCS chatbot's response quality. Dispatches the
  qa/eval pair (ocs-chatbot-qa captures a transcript; ocs-chatbot-eval
  grades it), then reports a quality score. Used for pre-launch gating
  and ongoing monitoring of per-opportunity bots.
skills:
  - ocs-chatbot-qa
  - ocs-chatbot-eval
---

# OCS Tester Agent

Evaluate how well an ACE OCS chatbot is performing — whether it answers
correctly, uses the right knowledge source, maintains the right tone, and
handles edge cases gracefully.

Works by dispatching a **qa → eval pair** (see `skills/README.md § QA vs
Eval — the two-phase pattern`): `ocs-chatbot-qa` chats with the bot and
captures a structured transcript; `ocs-chatbot-eval` reads the transcript
and runs the LLM-as-Judge rubric.

## When to use

- **After `ocs-agent-setup`** — as a pre-launch gate before handing the
  bot's embed credentials to Connect. Phase 5's `ocs-setup` agent already
  does this on the critical path; use `ocs-tester` directly for ad-hoc
  re-checks.
- **Ongoing monitoring** — run periodically against live per-opp bots to
  detect quality degradation (e.g., after the shared collection auto-syncs
  new Confluence pages that confuse the retriever).
- **Golden template validation** — after bootstrapping or refreshing the
  golden template, run this against it to verify baseline quality.
- **Ad-hoc debugging** — when an LLO reports a bad answer, reproduce it
  here and evaluate whether it's a retrieval, prompt, or LLM issue.

## What it does

1. **Resolves the target bot's config** from state files or env vars
   (experiment_id, embed_key, public_id). Can also take them as arguments.
2. **Dispatches `ocs-chatbot-qa`** (capture phase):
   - Opens an anonymous chat session via the widget embed endpoint
   - Sends a configurable suite of test prompts (Connect-general,
     opp-specific, edge cases, escalation triggers)
   - Polls for each response
   - Runs structural checks (response received, no error, citations
     present where expected)
   - Writes the transcript to the run-scoped path
     `<phase>/ocs-chatbot-qa_transcript-<mode>.md` (`5-ocs/` for
     `--quick`/`--deep`; `9-execution-manager/` for `--monitor`)
3. **Dispatches `ocs-chatbot-eval`** (judge phase):
   - Reads the transcript written by step 2
   - Scores each response on Correctness / Source usage / Refusal correctness / Tone / Tagging
   - Writes the verdict YAML to
     `<phase>/ocs-chatbot-eval_verdict-<mode>.yaml` and (for
     `--deep`/`--monitor`) a human-readable report to
     `<phase>/ocs-chatbot-eval_report-<mode>.md`
4. **Reports results** with a per-question breakdown and the overall score
   from the verdict.

## Inputs

- `experiment_id` (integer) — the OCS chatbot to test. If omitted, tests
  the golden template from `$OCS_GOLDEN_TEMPLATE_ID`.
- `opp_name` (optional) — if set, loads opp-specific test prompts from
  `ACE/<opp-name>/runs/<run-id>/2-scenarios/pdd-to-test-prompts.md` (expected questions + ground-truth
  answers from the PDD). If unset, only runs Connect-general prompts.
- `--quick` / `--deep` / `--monitor` flag — passed through to both
  skills. Defaults to `--quick`.

## Products

- Console summary with pass/warn/fail per question
- Quality score from the eval's verdict: 0–10 weighted average across 5
  dimensions (Correctness, Source usage, Refusal correctness, Tone, Tagging)
- `ACE/<opp-name>/runs/<run-id>/<phase>/ocs-chatbot-qa_transcript-<mode>.md` —
  transcript (`5-ocs/` for quick/deep; `9-execution-manager/` for monitor)
- `ACE/<opp-name>/runs/<run-id>/<phase>/ocs-chatbot-eval_verdict-<mode>.yaml` —
  verdict (same phase rule)
- `ACE/<opp-name>/runs/<run-id>/<phase>/ocs-chatbot-eval_report-<mode>.md` —
  eval report (skipped for `--quick` stdout-only mode; same phase rule)
