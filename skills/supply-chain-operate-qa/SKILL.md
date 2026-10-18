---
name: supply-chain-operate-qa
description: >
  Pass/fail check of one labs stock week: flows balance, movements read back. Static.
disable-model-invocation: false
---

# Supply-chain operate QA

Structural checks on one week `supply-chain-operate` recorded, judged against what labs holds
**now**. The central check is labs' own `stock_flow`: what flowed into each store, less what flowed
out, must equal what the store has on hand. Labs reports the flow in the item's **base** unit and the
store's on-hand in the unit it received (usually the **pack**), so the check converts with the item's
`base_per_pack`. The live capture this was calibrated on (labs program 10605, store 149) is 1000 tests
in against 20 kits on hand, at 50 a kit.

See `skills/_qa-template.md` for the shared QA contract.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the labs programme to read | explicit arg; default: run_state `phases.execution-management.products.supply_chain.program_id` |
| `week` | which week | explicit arg |
| `plan` | the week's plan | explicit arg; default: `9-execution-manager/supply-chain-operate_week-<w>_plan.yaml` |
| `week_review` | the review whose findings list is checked | explicit arg; default: `9-execution-manager/simulated-week-<w>_review.md` (PR10) |

## Products

- `9-execution-manager/supply-chain-operate-qa_week-<w>_result.yaml`: the result, built with
  `aggregateQAResult` (`lib/qa-types.ts`).

## Checks

The functions live in `skills/supply-chain-operate-qa/checks.ts` (`OperatePlan`, `OperateReadback`).

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `flows_balance` | static | each store's flow in minus out equals its on-hand, converted to the flow's unit | find the unrecorded movement; correct with a count override and a reason |
| 2 | `consignments_received` | static | every planned consignment is received at the planned quantity | `consignment_receive` with what arrived |
| 3 | `distributions_read_back` | static | each planned per-worker distribution reads back | record the week's distribution run |
| 4 | `counts_read_back` | static | each planned count reads back | record the count; a zero is real |
| 5 | `stockout_recorded` | static | in the stockout week, the zero count is in labs | record the zero self-report |
| 6 | `findings_listed_by_audience` | static | the week's review lists every open `checks_list` finding by kind and audience | add the dropped findings to the review |
| 7 | `no_stock_conflicts` | static | no `stock_negative` | correct the movement that ran ahead of its stock |

Where labs reports `adjusted` stock it does not draw per store, a flow mismatch is reported in the
detail rather than failed.

## Process

1. **Read labs fresh**, with `program_id`: `supply_chain_consignment_list`,
   `supply_chain_distribution_list`, `supply_chain_stock_count_list`, `supply_chain_stock_position`
   per store, `supply_chain_stock_flow({item_id, as_of: week_end})`, `supply_chain_checks_list`.
   Parse the week review's findings list into `[{kind, audience}]`.
2. **Normalise** with `normalizeReadback` (`checks.ts`), passing `stock_position` keyed by supply
   point id. Read the plan into `OperatePlan`.
3. **Run `CHECKS`** and write the result with `aggregateQAResult`.
4. **On fail**, return the failures and their hints. Never "fix" a movement with a reversing one.

## MCP Tools Used

- connect-labs: `supply_chain_consignment_list`, `supply_chain_distribution_list`,
  `supply_chain_stock_count_list`, `supply_chain_stock_position`, `supply_chain_stock_flow`,
  `supply_chain_checks_list`
- ace-gdrive: `drive_read_file` (plan, review), `drive_create_file` (result)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR9): 7 static checks, the flow balance unit-converted per the live capture of labs program 10605 store 149 | ACE |
