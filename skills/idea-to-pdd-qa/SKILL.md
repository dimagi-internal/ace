---
name: idea-to-pdd-qa
description: >
  Structural QA on the PDD artifact produced by idea-to-pdd. Binary pass/fail.
  Catches missing sections, malformed archetype declaration, etc. Static-only;
  no LLM. Gates idea-to-pdd-eval — eval is skipped if QA fails irrecoverably.
disable-model-invocation: false
---

# Idea-to-PDD QA

Structural correctness checks on the PDD artifact written by `idea-to-pdd`. Binary verdict: pass / fail / incomplete. Six static checks, all runnable in <100ms via the importable `checks.ts` module — no LLM.

This is the canonical first migration to the QA/Eval split (PR #146). The companion `idea-to-pdd-eval` was slimmed to quality-only dimensions in this same PR; structural completeness now lives here.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML format, auto-fix protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/idea-to-pdd.md` | the PDD under structural check |

## Products

- `1-design/idea-to-pdd-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `all_required_sections_present` | static | All 12 required PDD sections present (Archetype, Problem Statement, Intervention Design, Learn App Specification, Deliver App Specification, Target Population, FLW Requirements, LLO Preference, Success Metrics, Evidence Model, Timeline, Program Parameters). Heading match tolerates case variation, bold-wrapping, and trailing parentheticals — see `checks.ts § checkAllRequiredSectionsPresent` for the full tolerance contract. | regenerate the missing section(s) with substantive content matching each section's purpose (auto_fix_hint enumerates per-section purpose in the failure detail) |
| 2 | `archetype_declared_and_valid` | static | Archetype declared in frontmatter or body; value is one of {atomic-visit, focus-group, multi-stage} | add `archetype:` to frontmatter + matching body declaration |
| 3 | `stress_test_appendix_present` | static | PDD has a `## Stress Test Results` appendix with the 5-question self-eval grades | add the appendix per skills/idea-to-pdd/SKILL.md § Process step 6 |
| 4 | `success_metrics_table_populated` | static | `## Success Metrics` section contains a markdown table with at least one data row | fill the table with at least one metric row |
| 5 | `evidence_model_layered` | static | `## Evidence Model` section references all three layers (A, B, C) | populate the section with rows for each layer |
| 6 | `reviewer_comment_table_if_referenced` | static | If the PDD references reviewer-comment markers ([a]/[b]/etc.) OR has a `## Reviewer Comments` section, the disposition table is populated | add the disposition section + row per reviewer comment |
| 7 | `pdd_is_native_google_doc` | static | The PDD artifact's Drive mimeType is `application/vnd.google-apps.document`, i.e. a reviewer can actually comment on it. Reads `ctx.artifactMimeType` (`--artifact-mime-type`); a MISSING mimeType fails rather than passes. | re-create the PDD via `drive_create_doc_from_markdown` (never `drive_create_file` with a `text/*` mimeType) and repoint `phases.design.products.pdd.file_id`. If the mimeType simply wasn't passed, fix the QA invocation instead — see the hint. |
| 8 | `program_parameters_coherent` | static | `## Program Parameters` section present with a parseable `\| key \| value \|` table, and its numbers do not contradict each other: passing score within 0–100; a threshold that is only attainable by scoring EVERY item while written as less than 100; an inverted payment-rate band; and a `total_cap_per_flw` that can never bind against `expected_reach_max` without a `cap_rationale` row acknowledging it. Every rule skips silently when either operand is absent — QA is binary, so a half-specified table must not manufacture a failure. | resolve each contradiction in the table AND in the PDD prose stating the same numbers so the two agree; where the number is a deliberate program decision, keep it and add the row the check asks for |

The static check functions live at `skills/idea-to-pdd-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/idea-to-pdd-qa/checks.test.ts`.

## Process

1. **Read the PDD artifact** from Drive **as markdown**:
   `drive_read_file(file_id=<idea-to-pdd.md drive id>, exportMimeType='text/markdown')`.
   **Note its `mimeType`** — you pass it to the runner in step 3, and check 7
   cannot verify the format without it (the bytes look identical either way).
   Note the returned `mimeType` is the FILE's type
   (`application/vnd.google-apps.document`), not the export format, so check 7
   still sees what it needs.

   **`exportMimeType` is not optional here.** The default `text/plain` export
   strips every markdown marker, and checks 1/3/4/5/6/8 match `^## ` headings
   (`extractSection`) and `^|` pipe tables (`countTableDataRows`). Measured on
   a real PDD (bednet-check-2-visit/20260814-0856): the plain export gave **0
   headings and 0 table lines**; markdown gave **18 and 139**. Without it,
   check 7 (native Google Doc, #1061) and the other seven cannot both pass on
   the same artifact, so Phase 1 QA fails on every run and the auto-fix loop
   burns two PDD regenerations chasing sections that are present in the
   document and absent only from the export (#1321).

2. **Save to a local temp path** (so the CLI runner can read it as a file).
   `Bash: TMP=$(mktemp); drive content saved to $TMP`.

3. **Run all checks** via the generic CLI runner:
   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/qa-run.ts" --skill idea-to-pdd-qa --artifact "$TMP" --target "<opp-name>" --capture-path "1-design/idea-to-pdd.md" --artifact-mime-type "<mimeType from step 1>"
   ```

   **`--artifact-mime-type` is REQUIRED** (ace#1061). Check 7 verifies the PDD
   is a native Google Doc, and that is not answerable from the file's bytes —
   an exported Doc and a markdown upload are the same text. Omit the flag and
   check 7 FAILS by design ("nobody verified the format" is how the regression
   shipped); its `auto_fix_hint` says to fix the invocation, not the PDD, so
   don't spend an auto-fix rewriting a healthy document.

   The runner:
   - Imports `CHECKS` from `skills/idea-to-pdd-qa/checks.ts`
   - Runs each check via `lib/qa-runner.ts`
   - Prints a fully-shaped `QAResult` YAML to stdout

4. **Write the QA result** to Drive at `1-design/idea-to-pdd-qa_result.yaml`.
   `drive_create_file(parentFolderId=<run-folder/1-design>, name='idea-to-pdd-qa_result.yaml', content=<runner stdout>)`.

5. **Return the verdict** to the orchestrator:
   - `pass` → eval can proceed
   - `fail` → orchestrator attempts auto-fix using `failures[].auto_fix_hint`; re-runs `idea-to-pdd` then re-runs this skill
   - `incomplete` → artifact missing entirely; halt with operator-actionable error

## Auto-fix protocol

See `skills/_qa-template.md § Auto-fix protocol` for the canonical contract. Briefly:

- Default 2 auto-fix attempts per QA run.
- On fail, orchestrator passes each `auto_fix_hint` to the producer (`idea-to-pdd`) with explicit "fix this and re-emit" instructions.
- Re-run QA after each attempt.
- If still failing after 2 attempts, halt with `verdict: incomplete` and surface the unresolved failures + hints.

QA is **necessary but not sufficient**. A passing QA result means the PDD is gradable, NOT that it's good. The eval (`idea-to-pdd-eval`) grades quality; the orchestrator (or human reviewer) applies meta-judgment on top of both.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`
- Bash: `npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/qa-run.ts" ...` (runs static checks via `lib/qa-runner.ts`)

## Mode Behavior

- **Auto:** Run checks, write QA result, return verdict.
- **Review:** Same as Auto. QA is binary — there's no human pause-and-review step. (Eval has Review mode for quality concerns; QA is pass/fail.)

## Dry-Run Behavior

When `--dry-run` is active:
- All reads happen normally (read-only).
- The QA result IS written (it's an internal artifact, not an external comm).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill. First migration of the QA/Eval split principle (PR #146). Six static checks: required sections, archetype declaration, stress-test appendix, success-metrics table, evidence-model layers, reviewer-comment table-if-referenced. Companion `idea-to-pdd-eval` slimmed to quality-only dimensions in the same PR. | ACE team (0.13.88) |
