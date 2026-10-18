---
name: supply-chain-setup-qa
description: >
  Pass/fail labs read-back of a programme's supply-chain setup. Static.
disable-model-invocation: false
---

# Supply-chain setup QA

Structural checks on what `supply-chain-setup` wrote, judged against what labs holds **now**, never
against the write responses. A write can answer ok and still not leave the record the next skill
needs; procurement on a half-built registry fails later and harder.

See `skills/_qa-template.md` for the shared QA contract.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the labs programme to read | explicit arg; default: run_state `phases.execution-management.products.supply_chain.program_id` |
| `plan` | what setup meant to create | explicit arg (a file id or path); default: `9-execution-manager/supply-chain-setup_manifest.yaml` in the run folder |
| `ace_email` | ace@'s sign-in, for the team check | `config/agent.json` `email` |

## Products

- `9-execution-manager/supply-chain-setup-qa_result.yaml`: the result, built with
  `aggregateQAResult` (`lib/qa-types.ts`). Outside a run, the same file next to the plan.

## Checks

The functions live in `skills/supply-chain-setup-qa/checks.ts`. Each takes one JSON document,
`{plan, readback}`, and the shapes are declared there (`SetupPlan`, `SetupReadback`).

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `runner_standing_programme` | static | ACE's standing is `programme` (or `operator`) | re-run setup Step 1; resolve any [BLOCKER] |
| 2 | `runner_matches_plan` | static | the runner labs reports is the one the plan recorded | record the real runner; never move it |
| 3 | `orgs_bound` | static | the pm and llo labs orgs are bound to their Connect org ids | re-upsert with `connect_organization_id` |
| 4 | `planned_records_read_back` | static | every planned commodity, item, supply point and supplier is in labs | re-run the step (refs replay) |
| 5 | `user_held_points_named` | static | one `user_held` point per field worker, each naming that username | upsert the missing points |
| 6 | `suppliers_synthetic` | static | every invented supplier carries `[Synthetic]` | rename via `syntheticName()` |
| 7 | `team_has_ace_admin` | static | ace@ is an admin of the running org's team | `programme_team_add` as admin |
| 8 | `no_registry_conflicts` | static | `checks_list` shows no `conflict` | correct the record it names |

`missing` findings in `checks_list` are expected at setup (nothing has been quoted or counted yet)
and do not fail check 8.

## Process

1. **Read labs fresh**, all with `program_id`:
   `supply_chain_programme_runner_get`, `supply_chain_org_list`, `supply_chain_commodity_list`,
   `supply_chain_item_list`, `supply_chain_supply_point_list({include_inactive: true})`,
   `supply_chain_supplier_list`, `supply_chain_programme_team_list`, `supply_chain_checks_list`.
2. **Normalise** the replies with `normalizeReadback` (`checks.ts`), passing each reply as labs
   returned it. If `programme_team_list` refused, pass `{error: <the refusal text>}`: on a
   Dimagi-run programme it always refuses (Dimagi's team is everyone with a Dimagi address), and
   the normaliser turns that into `team_by_domain`. Read the plan into `SetupPlan`.
3. **Run `CHECKS`** over `JSON.stringify({plan, readback})` and write the result with
   `aggregateQAResult`.
4. **On fail**, return the failures with their hints to the caller. Re-running setup is safe: its
   source refs are deterministic, so records that landed are replayed, not duplicated.

## MCP Tools Used

- connect-labs: `supply_chain_programme_runner_get`, `supply_chain_org_list`,
  `supply_chain_commodity_list`, `supply_chain_item_list`, `supply_chain_supply_point_list`,
  `supply_chain_supplier_list`, `supply_chain_programme_team_list`, `supply_chain_checks_list`
- ace-gdrive: `drive_read_file` (plan), `drive_create_file` (result)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR6): 8 static checks over a fresh labs read | ACE |
