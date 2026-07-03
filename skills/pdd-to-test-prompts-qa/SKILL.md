---
name: pdd-to-test-prompts-qa
description: >
  Structural QA on pdd-to-test-prompts.md — header + total count match,
  ≥8 prompts each with required fields, all 7 adversarial categories,
  ≥20% adversarial share, plus training-gap / product-feedback / escalation
  prompts. Binary pass/fail; gates pdd-to-test-prompts-eval.
disable-model-invocation: true
---

# PDD-to-Test-Prompts QA

Structural correctness checks on the `pdd-to-test-prompts.md` artifact written by `pdd-to-test-prompts`. Binary verdict. Eight static checks, runs <100ms via importable `checks.ts`.

The companion `pdd-to-test-prompts-eval` grades quality (specificity of expected answers, realism of adversarial prompts, etc.). See `skills/_qa-template.md` for the shared QA contract.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `2-scenarios/pdd-to-test-prompts.md` | the test prompts file under structural check |

## Products

- `2-scenarios/pdd-to-test-prompts-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `header_with_total_count` | static | Title heading exists + `Total prompts: N` line matches actual prompt count | update header to match actual count or add/remove prompts |
| 2 | `prompt_count_in_range` | static | ≥8 and ≤80 prompts | add or consolidate prompts to fit |
| 3 | `each_prompt_has_required_fields` | static | Every prompt has Category, Question, Expected answer summary, Expected tags, Expected escalation | add the missing fields to named prompts |
| 4 | `adversarial_coverage` | static | All 7 adversarial categories (should-refuse, out-of-scope, hallucination-probe, leading-question, negative-frame, safety-critical, ambiguous-intent) each have ≥1 prompt | add prompts in the missing categories |
| 5 | `adversarial_share_minimum` | static | ≥20% of all prompts are adversarial | add adversarial prompts to reach the 20% threshold |
| 6 | `training_gap_prompt_present` | static | ≥1 prompt declares Expected tags: [training-gap] | add a prompt that should be tagged training-gap |
| 7 | `product_feedback_prompt_present` | static | ≥1 prompt declares Expected tags: [product-feedback] | add a prompt that should be tagged product-feedback |
| 8 | `escalation_prompt_present` | static | ≥1 prompt has non-trivial Expected escalation | add a prompt that should trigger bot escalation |

The static check functions live at `skills/pdd-to-test-prompts-qa/checks.ts` as importable TS. Same dispatch pattern as `idea-to-pdd-qa` (PR #149).

## Process

1. **Read the test-prompts artifact** from Drive.
2. **Save to a local temp path**.
3. **Run all checks** via `scripts/qa-run.ts --skill pdd-to-test-prompts-qa --artifact "$TMP" ...`.
4. **Write the QA result** to Drive at `2-scenarios/pdd-to-test-prompts-qa_result.yaml`.
5. **Return the verdict** — pass | fail | incomplete. On fail, orchestrator attempts auto-fix and re-runs; halts after bounded retries.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`
- Bash: `npx tsx scripts/qa-run.ts ...`

## Mode Behavior

- **Auto:** Run checks, write QA result, return verdict.
- **Review:** Same as Auto.

## Dry-Run Behavior

When `--dry-run`: reads happen normally; QA result IS written (internal artifact).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill. Phase 1 PR #3 of the QA/Eval split migration (greenfield). 8 static checks. Companion `pdd-to-test-prompts-eval` ships in the same PR. | ACE team (0.13.90) |
