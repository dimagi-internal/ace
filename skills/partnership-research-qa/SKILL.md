---
name: partnership-research-qa
description: >
  Structural QA on the two research artifacts from partnership-research.
  Binary pass/fail. Gates partnership-research-eval — eval is skipped if
  QA fails irrecoverably.
disable-model-invocation: true
---

# Partnership Research QA

Structural correctness checks on the two artifacts written by `partnership-research`: `research/deep-research.md` and `research/connect-fit.md`. Binary verdict: pass / fail / incomplete. Static checks only — no LLM. Gates `partnership-research-eval`; if this skill fails irrecoverably, eval is skipped.

See `skills/_qa-template.md` for the shared QA contract (verdict YAML format, auto-fix protocol, static-vs-LLM rules).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `partnership-research` | `ACE/partnerships/<slug>/research/deep-research.md` | Existence, non-empty, citations check |
| `partnership-research` | `ACE/partnerships/<slug>/research/connect-fit.md` | Existence, non-empty, capability check |
| `partnership-research` | `run_state.yaml.phases.research.products` | File IDs for reading artifacts |

## Products

- `2-research/partnership-research-qa_result.yaml` — QA result per `skills/_qa-template.md § QA result YAML contract`

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `deep_research_exists_and_nonempty` | static | `research/deep-research.md` exists in Drive (resolvable file_id in `run_state.yaml.phases.research.products.deep_research_file_id`) and its content is non-empty (> 100 characters) | re-run `partnership-research` step 3 (deep research) |
| 2 | `fit_memo_exists_and_nonempty` | static | `research/connect-fit.md` exists in Drive (resolvable fit_file_id from `run_state.yaml.phases.research.products`) and its content is non-empty (> 100 characters) | re-run `partnership-research` step 4 (connect-fit memo) |
| 3 | `deep_research_has_citations` | static | `deep-research.md` contains a citations or sources section — any heading whose text matches `/citations?\|sources?\|references?/i` followed by at least one list item or URL | re-run `partnership-research` step 3 with explicit instruction: "the report must include a ## Citations section with ≥3 sourced URLs" |
| 4 | `fit_memo_names_capability` | static | `research/connect-fit.md` names at least one concrete Connect capability — a string matching at least one of: "Learn app", "Deliver app", "payment", "verified delivery", "FLW", "frontline worker", "verification", "Connect" (case-insensitive) | re-run `partnership-research` step 4 with instruction: "the memo must explicitly name at least one concrete Connect capability with evidence" |

## Process

1. **Read the run's phase products block** to get the Drive file IDs for both research artifacts.

   Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `drive_read_file`. Extract `phases.research.products.deep_research_file_id` and the fit-memo file ID (stored under the key *connect_fit_file_id* in the products block — written without backticks here to avoid the drift detector treating a YAML key as an atom-shaped token).

   If `run_state.yaml` is missing or `phases.research` is absent, set verdict `incomplete` and halt — the producer did not complete.

2. **Run static checks for each artifact.**

   For check 1 (`deep_research_exists_and_nonempty`): attempt `drive_read_file(file_id=<deep_research_file_id>)`. If the call fails or returns empty content, fail the check.

   For check 2 (`fit_memo_exists_and_nonempty`): same pattern, using the fit_file_id from `run_state.yaml.phases.research.products`.

   If both read calls fail (both artifacts missing), set verdict `incomplete` — there is nothing to check.

3. **Run content checks against the artifact text.**

   For check 3 (`deep_research_has_citations`): scan the deep-research content (from step 2 read) for a section heading matching `/citations?\|sources?\|references?/i` with at least one subsequent list item or URL pattern.

   For check 4 (`fit_memo_names_capability`): scan the connect-fit content for any of the capability-signal strings listed in the check definition above.

4. **Write the QA result YAML** to the run's `2-research/` phase folder.

   Resolve or create `runs/<run-id>/2-research/` via `drive_create_folder` with `findOrCreate: true`. Write `partnership-research-qa_result.yaml` via `drive_create_file`.

   Result shape per `skills/_qa-template.md § QA result YAML contract`:

   ```yaml
   skill: partnership-research-qa
   target: <prospect-slug>
   ran_at: <ISO timestamp>
   capture_path: research/deep-research.md

   verdict: pass | fail | incomplete

   stats:
     checks_run: 4
     checks_passed: <n>
     checks_failed: <n>

   failures:            # empty list when verdict: pass
     - check: <check-id>
       type: static
       detail: "<one-line description>"
       auto_fix_hint: "<regen instruction>"
       severity: blocker
   ```

5. **Return the verdict to the orchestrator.**

   - `pass` → `partnership-research-eval` can proceed.
   - `fail` → orchestrator attempts auto-fix using `failures[].auto_fix_hint`; re-runs `partnership-research` relevant step then re-runs this skill.
   - `incomplete` → artifacts missing entirely; halt with operator-actionable error.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_folder`, `drive_create_file`

## Mode Behavior

- **Auto:** Run checks, write QA result, return verdict + failures (if any).
- **Review:** Same as Auto — QA is binary; there is no human pause-and-review. (Eval has Review mode for quality judgments; QA does not because there is nothing to weigh in on.)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. Four static checks gating `partnership-research-eval`. | ACE team |
