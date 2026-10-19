---
name: supply-chain-procure-qa
description: >
  Pass/fail check, from a fresh labs read, that a tender ended in one award and one matching
  contract per line.
disable-model-invocation: false
---

# Supply-chain procure QA

Structural checks on what `supply-chain-procure` wrote, judged against what labs holds **now**,
never against the write responses. None of these records can be deleted, so a contract that does
not carry its award is caught before goods and money move against it.

See `skills/_qa-template.md` for the shared QA contract.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the labs programme to read | explicit arg; default: run_state `phases.execution-management.products.supply_chain.program_id` |
| `tender_id` | the tender to judge | explicit arg; default: run_state `products.supply_chain.tender_id` |
| `plan` | what procure meant to do (lines, buyer of record, quote minimum, simulated) | explicit arg (a file id or path); default: `9-execution-manager/supply-chain-procure_plan.yaml` |

## Products

- `9-execution-manager/supply-chain-procure-qa_result.yaml`: the result, built with
  `aggregateQAResult` (`lib/qa-types.ts`). Outside a run, the same file next to the plan.

## Checks

The functions live in `skills/supply-chain-procure-qa/checks.ts`. Each takes one JSON document,
`{plan, readback}`, with the shapes declared there (`ProcurePlan`, `ProcureReadback`).

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `tender_awarded` | static | the tender ends `awarded` or `closed` | award every line, then close |
| 2 | `one_award_per_line` | static | each tender line has exactly one award | award the missing line; a second award cannot be removed |
| 3 | `award_comparison_rankable` | static | every award froze a rankable, non-provisional comparison | resolve blockers with `quote_correct` before awarding |
| 4 | `contract_matches_award` | static | one contract per award, carrying the awarded quote's supplier, item, price as stated and the tendered quantity | `contract_update`; never re-create |
| 5 | `buyer_matches_runner` | static | every contract's buyer of record follows from the runner | `contract_update` |
| 6 | `quotes_per_line` | static | each line has the planned number of live quotes | record the planned quotes |
| 7 | `non_cheapest_award_explained` | static | an award to a dearer quote carries a reason | record the reason; awards cannot be edited |
| 8 | `suppliers_synthetic` | static | on the simulated track every quoting supplier carries `[Synthetic]` | only invented suppliers may quote in a simulation |
| 9 | `no_procurement_conflicts` | static | `checks_list` shows no `conflict` (e.g. `award_not_contracted`) | create or correct the record it names |

Check 7 asks only that a reason exists. Whether it is a good reason, and whether the spread and the
quantities are realistic, is `supply-chain-procure-eval`'s judgement.

## Process

1. **Read labs fresh**, all with `program_id`: `supply_chain_tender_get({tender_id})`,
   `supply_chain_quote_list({tender_id})`, `supply_chain_award_list({tender_id})`,
   `supply_chain_contract_list({tender_id})`, `supply_chain_tender_compare` per tender line, and
   `supply_chain_checks_list`.
2. **Normalise** with `normalizeReadback(raw, tender_id)` (`checks.ts`), passing each reply as labs
   returned it and the compare replies keyed by commodity slug. Read the plan into `ProcurePlan`.
3. **Run `CHECKS`** over `JSON.stringify({plan, readback})` and write the result with
   `aggregateQAResult`.
4. **On fail**, return the failures and their hints to the caller. Do not retry writes blindly:
   procure's refs replay the same payload, but a corrected payload is a new, permanent record.

## MCP Tools Used

- connect-labs: `supply_chain_tender_get`, `supply_chain_quote_list`, `supply_chain_award_list`,
  `supply_chain_contract_list`, `supply_chain_tender_compare`, `supply_chain_checks_list`
- ace-gdrive: `drive_read_file` (plan), `drive_create_file` (result)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR7): 9 static checks over a fresh labs read, grounded on a live capture of labs program 10605 tender 60 | ACE |
