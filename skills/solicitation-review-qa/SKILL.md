---
name: solicitation-review-qa
description: >
  Structural QA on the solicitation-review recommendation + scoring
  artifacts before the HITL award_response gate. Binary pass/fail.
  Catches missing recommendation, unnamed awardee, incomplete scoring,
  unresolved tie-breaks. Static-only; no LLM. Gates the HITL human
  reviewer — runs BEFORE the irreversible award_response call.
disable-model-invocation: true
---

# Solicitation Review QA

Structural correctness checks on the solicitation-review artifacts —
the scoring rubric, the recommendation document, and any award record
— before the human applies the HITL gate that triggers the irreversible
`award_response` call. Binary verdict: pass / fail / incomplete. Eight
static checks, all runnable in <100ms via the importable `checks.ts`
module — no LLM.

This is the first QA migration for a Phase 7 producer. The companion
`solicitation-review-eval` (already shipped) grades the *quality* of
the recommendation reasoning; this skill catches the structural defects
QA owns: missing sections, unnamed awardee, incomplete scoring,
unresolved tie-breaks, premature award claims.

The QA gates the human review, not just `solicitation-review-eval`.
The HITL gate currently catches a wide class of issues post-hoc; QA
shifts the structural ones earlier so the human reviewer sees a
correctly-shaped recommendation, not one missing a required section.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML
format, auto-fix protocol, static-vs-LLM rules) and
`skills/idea-to-pdd-qa/SKILL.md` for the canonical QA-with-checks.ts
exemplar this skill mirrors.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 7 producer | `7-solicitation-management/solicitation-review_recommendation.md` | the recommendation under structural check |
| Phase 7 producer | `7-solicitation-management/solicitation-review_scoring-rubric.md` | per-response scoring; cross-checked against recommendation |
| Phase 7 upstream | `7-solicitation-management/solicitation-monitor_responses/` | response files; checks coverage if present |
| Phase 1 (optional) | `1-design/idea-to-pdd.md` | PDD-declared evaluation criteria; checks coverage if available |

## Products

- `7-solicitation-management/solicitation-review-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `recommendation_section_present` | static | Recommendation doc has a `## Recommendation` heading. | regenerate doc with the required section |
| 2 | `awardee_named` | static | Recommendation block names a specific `response_id` or `org_slug` (not "TBD" / "the top response" / generic placeholders). | regenerate naming the awardee explicitly |
| 3 | `awardee_reasoning_substantive` | static | Reasoning paragraph in the Recommendation block has ≥ 3 sentences AND references at least one named criterion (heading text seen elsewhere in the doc). | expand reasoning; tie each claim to a named criterion |
| 4 | `all_responses_scored` | static | Every response file in `solicitation-monitor_responses/` has a corresponding row in the scoring-rubric doc. (Skipped with INFO if responses dir not provided.) | re-score the missing response(s) |
| 5 | `criteria_coverage_table_populated` | static | A `## Criteria Coverage` table exists with at least one populated data row per criterion. | populate the criteria-coverage table |
| 6 | `scoring_table_well_formed` | static | Scoring-rubric doc contains a markdown table with columns `response_id`, `score`, `rationale` (case-insensitive), and every data row populates each column. | re-emit the scoring table with all required columns populated |
| 7 | `tie_break_resolved` | static | If the top two responses by score are within 0.5 points, a `## Tie-Break` section exists with a non-empty named rationale. | add a Tie-Break section with explicit rationale + decision |
| 8 | `no_award_action_yet` | static | Recommendation doc does NOT claim `award_response` was already called (no "awarded", "award_response called", "awarded_at:" affirmations). QA must run BEFORE the HITL human acts. | remove premature award-action language; await HITL gate |

The static check functions live at `skills/solicitation-review-qa/checks.ts` as importable TS. Every check returns a `QACheckResult` (`{pass, detail?, auto_fix_hint?}`) per `lib/qa-types.ts`.

**Adding a check:** append to the `CHECKS` array in `checks.ts`, add a row to the table above (matching `id`), add a unit test in `test/skills/solicitation-review-qa/checks.test.ts`.

## Process

1. **Read the recommendation artifact** from Drive:
   `drive_read_file(file_id=<solicitation-review_recommendation.md drive id>)`.

2. **Read the scoring artifact** from Drive:
   `drive_read_file(file_id=<solicitation-review_scoring-rubric.md drive id>)`.

3. **Read the response file list** from Drive (optional — checks 4 is
   skipped with INFO if unreachable):
   `drive_list_folder(folder_id=<solicitation-monitor_responses dir>)`.

4. **Save artifacts to local temp paths** so the CLI runner can read them:
   `Bash: REC=$(mktemp); SCO=$(mktemp); recommendation -> $REC; scoring -> $SCO`.

5. **Run all checks** via the generic CLI runner:
   ```
   npx tsx scripts/qa-run.ts \
     --skill solicitation-review-qa \
     --artifact "$REC" \
     --context-recommendation "$REC" \
     --context-scoring "$SCO" \
     --context-response-files "<comma-separated response filenames or ''>" \
     --target "<opp-name>" \
     --capture-path "7-solicitation-management/solicitation-review_recommendation.md"
   ```

   The runner:
   - Imports `CHECKS` from `skills/solicitation-review-qa/checks.ts`
   - Runs each check via `lib/qa-runner.ts`, passing the recommendation
     text as `artifact` and the scoring text + response-file list via
     the QACheckContext.
   - Prints a fully-shaped `QAResult` YAML to stdout.

6. **Write the QA result** to Drive at
   `7-solicitation-management/solicitation-review-qa_result.yaml`.
   `drive_create_file(parentFolderId=<run-folder/7-solicitation-management>, name='solicitation-review-qa_result.yaml', content=<runner stdout>)`.

7. **Return the verdict** to the orchestrator (or, more often, to the
   human reviewer who is about to apply the HITL gate):
   - `pass` → human can review the recommendation safely.
   - `fail` → orchestrator attempts auto-fix using `failures[].auto_fix_hint`;
     re-runs `solicitation-review` then re-runs this skill. **Do NOT
     proceed to the HITL gate while QA is failing.**
   - `incomplete` → recommendation doc missing entirely; halt with
     operator-actionable error.

## Auto-fix protocol

See `skills/_qa-template.md § Auto-fix protocol` for the canonical
contract. Briefly:

- Default 2 auto-fix attempts per QA run.
- On fail, orchestrator passes each `auto_fix_hint` to the producer
  (`solicitation-review`) with explicit "fix this and re-emit"
  instructions. **The producer does NOT call `award_response` during
  auto-fix** — only the recommendation/scoring artifacts are
  regenerated. The HITL gate stays gated.
- Re-run QA after each attempt.
- If still failing after 2 attempts, halt with `verdict: incomplete`
  and surface the unresolved failures + hints to the human reviewer.

QA is **necessary but not sufficient**. A passing QA result means the
recommendation is structurally complete and gradable, NOT that it's
correct. The human reviewer (and `solicitation-review-eval`) judge
quality; QA's job is to ensure they have a fair input.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_list_folder`, `drive_create_file`
- Bash: `npx tsx scripts/qa-run.ts ...` (runs static checks via `lib/qa-runner.ts`)

## Mode Behavior

- **Auto:** Run checks, write QA result, return verdict.
- **Review:** Same as Auto. QA is binary — there's no human pause-and-review
  step. (The HITL gate happens after QA, not inside it.)

## Dry-Run Behavior

When `--dry-run` is active:
- All reads happen normally (read-only).
- The QA result IS written (it's an internal artifact, not an external comm).
- State tracks as `dry-run-success`.
- The producer's `award_response` call is the actual external action;
  this skill is read-only and runs the same in dry-run.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-09 | Initial skill. Closes the deferred has-QA candidate row in `_qa-decisions.md` for `solicitation-review`. Eight static checks: recommendation_section_present, awardee_named, awardee_reasoning_substantive, all_responses_scored, criteria_coverage_table_populated, scoring_table_well_formed, tie_break_resolved, no_award_action_yet. The last check (no_award_action_yet) is the load-bearing one for safety: QA must run BEFORE the HITL human triggers the irreversible `award_response`, so the doc must not yet claim award. | ACE team |
