---
name: ocs-tester
description: >
  Test and evaluate an ACE OCS chatbot's response quality. Sends a suite
  of probing questions, evaluates the responses, and reports a quality score.
  Used for pre-launch QA and ongoing monitoring of per-opportunity bots.
skills:
  - ocs-chatbot-qa
---

# OCS Tester Agent

Evaluate how well an ACE OCS chatbot is performing — whether it answers
correctly, uses the right knowledge source, maintains the right tone, and
handles edge cases gracefully.

## When to use

- **After `ocs-agent-setup`** — as a pre-launch QA gate before handing the
  bot's embed credentials to Connect. The `ocs-agent-setup` skill already
  has an LLM-as-Judge self-eval step; this agent provides a deeper,
  standalone evaluation.
- **Ongoing monitoring** — run periodically against live per-opp bots to
  detect quality degradation (e.g., after the shared collection auto-syncs
  new Confluence pages that confuse the retriever).
- **Golden template validation** — after bootstrapping or refreshing the
  golden template, run this against it to verify baseline quality.
- **Ad-hoc debugging** — when an LLO reports a bad answer, reproduce it
  here and evaluate whether it's a retrieval, prompt, or LLM issue.

## What it does

1. **Reads the target bot's config** from state files or env vars
   (experiment_id, embed_key, public_id). Can also take them as arguments.
2. **Runs the `ocs-chatbot-qa` skill** which:
   - Opens an anonymous chat session via the widget embed endpoint
   - Sends a configurable suite of test prompts (Connect-general,
     opp-specific, edge cases, escalation triggers)
   - Polls for each response
   - Evaluates each response using LLM-as-Judge criteria
   - Produces a structured quality report
3. **Reports results** with a per-question breakdown and an overall score.

## Inputs

- `experiment_id` (integer) — the OCS chatbot to test. If omitted, tests
  the golden template from `$OCS_GOLDEN_TEMPLATE_ID`.
- `opp_name` (optional) — if set, loads opp-specific test prompts from
  `ACE/<opp-name>/test-prompts.md` (expected questions + ground-truth answers
  from the IDD). If unset, only runs Connect-general prompts.
- `--deep` flag — runs the full 20+ question suite instead of the quick
  5-question smoke test.

## Outputs

- Console summary with pass/warn/fail per question
- Quality score: 0-10 (10 = every question answered correctly with proper
  source attribution and tone)
- Written report at `ACE/<opp-name>/qa-reports/YYYY-MM-DD-ocs-qa.md`
  (if opp_name is set) or printed to stdout (if testing the template)
