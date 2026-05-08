---
name: pdd-to-app-journeys-qa
description: >
  Structural QA on pdd-to-app-journeys.md — persona block populated,
  archetype declared, journey sections well-formed with all required
  subfields. Binary pass/fail; gates pdd-to-app-journeys-eval.
disable-model-invocation: true
---

# PDD-to-App-Journeys QA

Structural correctness checks on the `pdd-to-app-journeys.md` artifact written by `pdd-to-app-journeys`. Binary verdict: pass / fail / incomplete. Seven static checks, all <100ms via importable `checks.ts`.

The companion `pdd-to-app-journeys-eval` grades quality (persona specificity, narrative voice, edge-case recoverability) — concerns out of scope here. See `skills/_qa-template.md` for the shared QA contract.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/pdd-to-app-journeys.md` | the journeys doc under structural check |

## Outputs

- `1-design/pdd-to-app-journeys-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `persona_block_present` | static | § Persona heading exists with non-empty body (>50 chars after stripping placeholders) | regenerate with explicit instruction to fill the persona from PDD's Target FLW section |
| 2 | `archetype_declared_and_valid` | static | `Archetype: <value>` declared in header; value in {atomic-visit, focus-group, multi-stage} | add the archetype line at the top of the doc |
| 3 | `journey_count_in_range` | static | ≥2 and ≤8 `## Journey N` sections | add or consolidate journeys per archetype-branch coverage rules |
| 4 | `each_journey_has_goal` | static | Every journey section contains a `**Goal:**` line | add the missing fields to the named journeys |
| 5 | `each_journey_has_happy_path` | static | Every journey contains `**Happy path narrative:**` | add the missing narrative blocks |
| 6 | `each_journey_has_edge_cases` | static | Every journey has `**Edge cases:**` with ≥2 bullets | add edge cases describing UX outcomes |
| 7 | `each_journey_has_pass_criteria` | static | Every journey has `**Pass criteria:**` with ≥1 bullet | add measurable pass criteria |

The static check functions live at `skills/pdd-to-app-journeys-qa/checks.ts` as importable TS. Same dispatch pattern as `idea-to-pdd-qa` (PR #149).

## Process

1. **Read the journeys artifact** from Drive:
   `drive_read_file(file_id=<pdd-to-app-journeys.md drive id>)`.

2. **Save to a local temp path**.
   `Bash: TMP=$(mktemp); drive content saved to $TMP`.

3. **Run all checks** via the generic CLI runner:
   `Bash: npx tsx scripts/qa-run.ts --skill pdd-to-app-journeys-qa --artifact "$TMP" --target "<opp-name>" --capture-path "1-design/pdd-to-app-journeys.md"`.

4. **Write the QA result** to Drive at `1-design/pdd-to-app-journeys-qa_result.yaml`.

5. **Return the verdict** to the orchestrator — pass | fail | incomplete. On fail, orchestrator attempts auto-fix (regenerate with hints) and re-runs; halts after bounded retries.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`
- Bash: `npx tsx scripts/qa-run.ts ...`

## Mode Behavior

- **Auto:** Run checks, write QA result, return verdict.
- **Review:** Same as Auto. QA is binary; no human pause here.

## Dry-Run Behavior

When `--dry-run` is active: all reads happen normally (read-only); the QA result IS written (internal artifact).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill. Phase 1 PR #2 of the QA/Eval split migration (greenfield). Seven static checks. Companion `pdd-to-app-journeys-eval` ships in the same PR. | ACE team (0.13.89) |
