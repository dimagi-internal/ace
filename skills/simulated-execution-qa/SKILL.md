---
name: simulated-execution-qa
description: >
  Pass/fail check of a simulated N-week execution: calendar, weekly runs, isolation, no LLO contact.
  Static.
disable-model-invocation: false
---

# Simulated execution QA

Structural checks on a whole simulated Phase 9, judged against what labs holds **now** and what the
run recorded. Each week's stock ledger is `supply-chain-operate-qa`'s job and each review's numbers
are `simulated-weekly-review-eval`'s; this checks that the weeks add up to a simulation, and that it
stayed a simulation.

See `skills/_qa-template.md` for the shared QA contract.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `calendar` | the weeks judged | explicit arg; default: run_state `phases.execution-management.products.simulation.calendar` |
| `definition_id`, `synthetic_opportunity_id` | the weekly report and its scope | explicit arg; default: run_state `products.simulation.{workflow_id, synthetic_opportunity_id}` |
| `enabled` | `supply_chain`, `simulate_weeks` | explicit arg; default: run_state `optional_steps` |
| `selected_llo` | the handover fields that must stay empty | explicit arg; default: run_state `phases.solicitation-management.products.selected_llo` |
| `winner_org_name` | the org the copy must be filed under | explicit arg; default: `connect_orgs.llo_org`'s display name |
| `out_folder_id` | where the per-week QA results and reviews are | explicit arg; default: the run's `9-execution-manager/` |

## Products

- `9-execution-manager/simulated-execution-qa_result.yaml`, built with `aggregateQAResult`
  (`lib/qa-types.ts`).

## Checks

The functions live in `skills/simulated-execution-qa/checks.ts`. Each takes one JSON document,
`SimulationDoc`.

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `calendar_backdated` | static | Monday-aligned, contiguous, all before the run start, N = `simulate_weeks` | recompute with `scripts/sim-calendar.ts` |
| 2 | `week0_supply_chain` | static | procure and fulfil QA passed (supply_chain only) | finish week 0 first |
| 3 | `every_week_operated` | static | every delivery week's `supply-chain-operate-qa` passed (supply_chain only) | re-run the week; it replays by `source.ref` |
| 4 | `history_one_run_per_week` | static | exactly one completed saved run per delivery week, on its Monday-Sunday period | `workflow_rebuild_history` over the window |
| 5 | `synthetic_opportunity_isolated` | static | visits on a labs-only copy (id ≥ 10000, a `labs-synthetic-` org) whose org name is the ACE winner's | clone to labs-only; repoint the report |
| 6 | `review_per_week` | static | a weekly review per delivery week | run `simulated-weekly-review` |
| 7 | `no_real_llo_contact` | static | `synthetic_winner: true`, no real handover field set, no Phase 9 send | stop and report: a real step ran |
| 8 | `summary_links_every_week` | static | the summary links every review | rewrite the summary |

## Process

1. **Read fresh:** `workflow_history_runs({definition_id, opportunity_id: <synthetic opp>, generated_only: true})`
   (page with `start_at` until `done`); `labs_context({search: <winner org name>})` for the synthetic opportunity's org (slug and
   name; labs carries no labs_only flag, so the `labs-synthetic-` slug and the id range say it); each week's `supply-chain-operate-qa_week-<w>_result.yaml`, the week-0 QA
   results and the review files from the folder; run_state's `selected_llo` and `optional_steps`;
   Phase 9's outbound sends from the run's comms-log.
2. **Build `SimulationDoc`** and run `CHECKS` over `JSON.stringify(doc)`; write the result with
   `aggregateQAResult`.
3. **On fail**, return the failures and hints. `no_real_llo_contact` failing is never auto-fixed: it
   means the simulated carve-out was breached, and the run stops for the operator.

## MCP Tools Used

- connect-labs: `workflow_history_runs`, `labs_context`
- ace-gdrive: `drive_list_folder`, `drive_read_file`, `drive_create_file`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR10): 8 static checks; the weekly-history control is grounded on a live capture of labs workflow 7410's rebuilt history | ACE |
