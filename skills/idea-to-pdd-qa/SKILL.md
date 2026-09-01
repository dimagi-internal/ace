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
| 2 | `archetype_declared_and_valid` | static | Archetype declared in the body's top metadata block (preferred — PDDs are rendered gdocs, so raw `---` frontmatter renders as noise) or, still accepted, in YAML frontmatter; value is one of {atomic-visit, longitudinal-visits, focus-group, multi-stage} (canonical list: `checks.ts § VALID_ARCHETYPES`) | add a `**Archetype:** <value>` line to the PDD's top metadata block |
| 3 | `stress_test_appendix_present` | static | PDD has a `## Stress Test Results` appendix with the 5-question self-eval grades | add the appendix per skills/idea-to-pdd/SKILL.md § Process step 6 |
| 4 | `success_metrics_table_populated` | static | `## Success Metrics` section contains a markdown table with at least one data row | fill the table with at least one metric row |
| 5 | `evidence_model_layered` | static | `## Evidence Model` section references all three layers (A, B, C) | populate the section with rows for each layer |
| 6 | `reviewer_comment_table_if_referenced` | static | If the PDD references reviewer-comment markers ([a]/[b]/etc.) OR has a `## Reviewer Comments` section, the disposition table is populated | add the disposition section + row per reviewer comment |
| 7 | `pdd_is_native_google_doc` | static | The PDD artifact's Drive mimeType is `application/vnd.google-apps.document`, i.e. a reviewer can actually comment on it. Reads `ctx.artifactMimeType` (`--artifact-mime-type`); a MISSING mimeType fails rather than passes. | re-create the PDD via `drive_create_doc_from_markdown` (never `drive_create_file` with a `text/*` mimeType) and repoint `phases.design.products.pdd.file_id`. If the mimeType simply wasn't passed, fix the QA invocation instead — see the hint. |
| 8 | `program_parameters_coherent` | static | `## Program Parameters` section present with a parseable `\| key \| value \|` table, and its numbers do not contradict each other: passing score within 0–100; a threshold that is only attainable by scoring EVERY item while written as less than 100; an inverted payment-rate band; and a `total_cap_per_flw` that can never bind against `expected_reach_max` without a `cap_rationale` row acknowledging it. Every rule skips silently when either operand is absent — QA is binary, so a half-specified table must not manufacture a failure. | resolve each contradiction in the table AND in the PDD prose stating the same numbers so the two agree; where the number is a deliberate program decision, keep it and add the row the check asks for |
| 9 | `payment_unit_matches_entity_grain` | static | The declared `payment_rate_unit` is not FINER than the `entity_id_grain` that actually resolves payable units — a per-visit rate against a per-worker-per-day grain collapses N visits into ONE payment entity and multiplies every money number in the PDD, the Work Order and the Phase 4 payment unit (ace#1420). Skips silently unless both rows are present. | quote the rate per the GRAIN, or narrow `entity_id_grain` so each event is its own entity — then re-derive `payment_rate_min`/`max`, `daily_cap_per_flw`, `total_cap_per_flw` and the worker-economics prose |
| 10 | `entity_state_taxonomy_declared_for_longitudinal` | static | **When `archetype: longitudinal-visits`** (and only then — an `atomic-visit` PDD has no followed entity to have states), § Program Parameters carries an `entity_state_taxonomy` row that `parseStateTaxonomy` (`lib/entity-state-taxonomy.ts`) reads as `declared: true` with no `problems`. Uses the SAME parser Phase 3 halts on, so any value that would HALT `pdd-to-learn-app` / `pdd-to-deliver-app` fails here instead — where it is a one-line author fix rather than a `[BLOCKER]` after two clean phases (ace#1564 added the halt, ace#1783 added this gate). Defers to `program_parameters_coherent` when the section is absent. | transcribe the states the PDD already describes in § Entity Lifecycle into the one-line grammar `<value>=<label> (steps <a>-<b>); ... [source: <doc>]` |

The static check functions live at `skills/idea-to-pdd-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/idea-to-pdd-qa/checks.test.ts`.

## Process

1. **Read the PDD artifact** from Drive:
   `drive_read_file(file_id=<idea-to-pdd.md drive id>, exportAs: 'text/markdown')`.

   **`exportAs: 'text/markdown'` is REQUIRED here, not optional.** Since
   ace#1061 the PDD is a NATIVE Google Doc, so its headings are real Docs
   heading styles — and a `text/plain` export (the atom's default) renders a
   heading as bare text with **no `#` markers at all**. Every static check in
   this skill anchors on markdown syntax (`^##\s+<Section>`, pipe tables,
   `**bold**`), so reading a correctly-rendered PDD as plain text fails checks
   1, 3, 4, 5 and 8 while the PDD is perfectly fine. The markdown export
   restores the syntax the checks are written against.

   **The markdown export also ESCAPES punctuation** — `## 1. Archetype` comes
   back as `## 1\. Archetype`, `learn_passing_score` as `learn\_passing\_score`.
   `checks.ts` strips that at every check's entry (`normalizeDriveExport`, in
   `lib/drive-export.ts`), so the escaping is handled and you should NOT
   pre-clean the body or fall back to `text/plain` when you see backslashes
   (ace#1617 — before the strip, all 12 required sections read as missing on a
   healthy PDD and Phase 1 halted). The sibling `pdd-to-work-order-qa` requires
   the OPPOSITE format (`text/plain`, ace#1609) and shares the same normaliser.

   **Note its `mimeType`** — you pass it to the runner in step 3, and check 7
   cannot verify the format without it (the bytes look identical either way).

   **The sibling skill `pdd-to-work-order-qa` requires the OPPOSITE
   (`exportAs: 'text/plain'`).** Both run in Phase 1, so do not carry this
   skill's markdown convention across to it: its `checks.ts` matches the
   unescaped gdoc form, and the markdown export's `1\.` / `\[` escaping
   defeats it (dimagi-internal/ace#1609). The requirement is per-skill,
   decided by what that skill's checks are written against — always read the
   target skill's step 1 rather than reusing the last one you ran.

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

- Google Drive: `drive_read_file` (always with `exportAs: 'text/markdown'` — the PDD is a rendered gdoc), `drive_create_file`
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
