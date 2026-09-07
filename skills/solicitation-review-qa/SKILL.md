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

This is the first QA migration for a Phase 8 producer. The companion
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
| Phase 8 producer | `8-solicitation-management/solicitation-review_recommendation.md` | the recommendation under structural check |
| Phase 8 producer | `8-solicitation-management/solicitation-review_scoring-rubric.md` | per-response scoring; cross-checked against recommendation |
| Phase 8 upstream | `8-solicitation-management/solicitation-monitor_responses/` | response files; checks coverage if present |
| Phase 1 (optional) | `1-design/idea-to-pdd.md` | PDD-declared evaluation criteria; checks coverage if available |

## Products

- `8-solicitation-management/solicitation-review-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

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
   `drive_read_file(file_id=<solicitation-review_recommendation.md drive id>, exportAs: 'text/plain')`.

   **`exportAs: 'text/plain'` is REQUIRED here, not optional** — it is also the
   atom's default, so the requirement is "do not reach for the other one."
   Every anchor in `checks.ts` is markdown SYNTAX: `extractSection` matches
   `^##\s+(?:\*\*)?<heading>` (checks 1, 3, 5, 7), check 3 harvests the doc's
   other headings with the same `^##` pattern, and checks 5/6/7 read markdown
   PIPE TABLES via `extractAllTables` / `countTableDataRows` / `parseTableRow`,
   which key on a literal `|`.

   The producer (`solicitation-review` § Process steps 4–5) writes BOTH
   artifacts with `drive_create_file` — the only Drive writer that skill names.
   That atom lands a Google Doc but uploads the body as
   `text/plain; charset=utf-8` media (`bodyMedia`, `mcp/google-drive-server.ts`),
   so Drive never runs the markdown→styles conversion and the `#` / `**` / `|`
   markers stay LITERAL characters in the doc. A `text/markdown` export
   therefore has to ESCAPE them to preserve them: `## Recommendation` comes
   back as `\#\# Recommendation`, and every anchor above is gone at once.
   (`\#` is directly observed in a real Drive markdown export — see the
   escaped-character census in `lib/drive-export.ts`. The exporter escapes the
   CommonMark punctuation set, so a table row's `|` and a `resp-42` id's `-`
   go the same way; `normalizeDriveExport` unescapes all of it uniformly, so
   the fix does not depend on which subset Drive picks on any given day.)

   Measured on a SYNTHETIC but structurally-correct recommendation + scoring
   pair (3 responses, 4 criteria, both tables populated), running the real
   `CHECKS` array over both exports. It is synthetic because no real one
   exists: a Drive sweep of all 74 runs across 11 opps (2026-05-13 →
   2026-09-07) found 18 `8-solicitation-management` folders and **zero**
   `solicitation-review_*` artifacts in any of them — Phase 8 publishes and
   stops, and this skill's producer is a separately-invoked, HITL-gated step
   that has never run to completion. That is also why this instance was
   latent rather than live. Both exports: `text/plain` scores **8/8**, `text/markdown` scores
   **2/8** — 0 of 5 `##` headings and 0 of 19 table rows survive, six hard
   failures, and the two remaining "passes" are **vacuous**:
   `tie_break_resolved` passes only because it parsed *zero* scores, and
   `no_award_action_yet` passes only because the award markers it hunts for are
   escaped too. That second one is the load-bearing SAFETY check on this skill —
   measured separately, a recommendation doc carrying `awarded_at: <ts>` scores
   `pass` on `no_award_action_yet` under the markdown export. The check that
   exists to keep QA in front of the irreversible `award_response` call goes
   silently blind, which is a strictly worse outcome than the sibling instances,
   where the wrong export only produced noisy false failures
   (dimagi-internal/ace#2178).

   **This is the same as what `pdd-to-work-order-qa` (ace#1609) and
   `pdd-to-test-prompts-qa` (ace#2169) require, and the OPPOSITE of
   `idea-to-pdd-qa`** (`text/markdown`, ace#1617). The requirement is per-skill
   and follows from two facts, both readable: **how the producer WROTE the doc**
   (`drive_create_doc_from_markdown` → real heading/bold styles, so a plain
   export drops the markers entirely; `drive_create_file` → literal markdown
   characters, so a markdown export escapes them) and **what that skill's checks
   match**. Always read the target skill's step 1 rather than reusing the last
   one you ran. *Enforced:* `test/skills/qa-export-format.test.ts`.

   `checks.ts` also normalises markdown-export escaping defensively (via
   `normalizeDriveExport` in `lib/drive-export.ts`, shared with all three
   siblings), so passing the wrong format no longer produces spurious failures
   — nor a spurious pass on check 8. That is a safety net, not a licence — pass
   `text/plain` and keep the checks matching what they were written against.

2. **Read the scoring artifact** from Drive:
   `drive_read_file(file_id=<solicitation-review_scoring-rubric.md drive id>, exportAs: 'text/plain')`.

   Same mandate, same reason — it is written by the same `drive_create_file`
   call and read by the same pipe-table matchers (checks 4, 6, 7).

3. **Read the response file list** from Drive (optional — checks 4 is
   skipped with INFO if unreachable):
   `drive_list_folder(folder_id=<solicitation-monitor_responses dir>)`.

4. **Save artifacts to local temp paths** so the CLI runner can read them:
   `Bash: REC=$(mktemp); SCO=$(mktemp); recommendation -> $REC; scoring -> $SCO`.

5. **Run all checks** via the generic CLI runner:
   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/qa-run.ts" \
     --skill solicitation-review-qa \
     --artifact "$REC" \
     --context-recommendation "$REC" \
     --context-scoring "$SCO" \
     --context-response-files "<comma-separated response filenames or ''>" \
     --target "<opp-name>" \
     --capture-path "8-solicitation-management/solicitation-review_recommendation.md"
   ```

   The runner:
   - Imports `CHECKS` from `skills/solicitation-review-qa/checks.ts`
   - Runs each check via `lib/qa-runner.ts`, passing the recommendation
     text as `artifact` and the scoring text + response-file list via
     the QACheckContext.
   - Prints a fully-shaped `QAResult` YAML to stdout.

6. **Write the QA result** to Drive at
   `8-solicitation-management/solicitation-review-qa_result.yaml`.
   `drive_create_file(parentFolderId=<run-folder/8-solicitation-management>, name='solicitation-review-qa_result.yaml', content=<runner stdout>)`.

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

- Google Drive: `drive_read_file` — **always with `exportAs: 'text/plain'`** for BOTH the recommendation and scoring artifacts (see § Process step 1; the same as `pdd-to-work-order-qa` and `pdd-to-test-prompts-qa`, the inverse of `idea-to-pdd-qa`, which requires `text/markdown`), `drive_list_folder`, `drive_create_file`
- Bash: `npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/qa-run.ts" ...` (runs static checks via `lib/qa-runner.ts`)

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
| 2026-09-07 | **Steps 1–2 now mandate `exportAs: 'text/plain'`, and `checks.ts` normalises markdown-export escaping (ace#2178).** Fourth instance of the class already fixed by name in ace#1609 / ace#1617 / ace#2169; this one was latent, not live — the atom's default happened to be the format the checks want. Derived from the producer's writer atom: `solicitation-review` writes both artifacts with `drive_create_file`, which leaves the `#` / `**` / `|` markers literal, so the markdown export escapes exactly what the checks anchor on. Measured on a correct 3-response recommendation + scoring pair: 8/8 plain vs 2/8 markdown, with `no_award_action_yet` — the safety check gating the irreversible `award_response` — passing **vacuously** on a doc that carries `awarded_at:`. *Enforced:* `test/skills/qa-export-format.test.ts` (this skill moved from `KNOWN_UNFIXED` to `MANDATED`, emptying the ratchet's allowlist). | ACE team |
