---
name: supply-chain-fulfil-qa
description: >
  Pass/fail check, from labs' three-way match, that each contract was received and paid for what
  arrived.
disable-model-invocation: false
---

# Supply-chain fulfil QA

Structural checks on what `supply-chain-fulfil` wrote, judged against what labs holds **now**. The
central figure is labs' own three-way match (`supply_chain_contract_match`): ordered, received and
invoiced, and `payable_now`, the value of what actually arrived. It is computed by labs and never
stored, so it is the authority, not ACE's sums.

See `skills/_qa-template.md` for the shared QA contract.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the labs programme to read | explicit arg; default: run_state `phases.execution-management.products.supply_chain.program_id` |
| `contract_ids` | the orders to judge | explicit arg; default: run_state `products.supply_chain.contract_ids` |
| `plan` | the planned rejection and advance per contract | explicit arg (a file id or path); default: `9-execution-manager/supply-chain-fulfil_plan.yaml` |

## Products

- `9-execution-manager/supply-chain-fulfil-qa_result.yaml`: the result, built with
  `aggregateQAResult` (`lib/qa-types.ts`). Outside a run, the same file next to the plan.

## Checks

The functions live in `skills/supply-chain-fulfil-qa/checks.ts`. Each takes one JSON document,
`{plan, readback}` (`FulfilPlan`, `FulfilReadback`).

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `received_equals_accepted` | static | each contract's `received` equals its receipts' accepted lines | record the receipt for what arrived |
| 2 | `rejections_as_planned` | static | rejected quantity is what the plan meant, each with a reason | correct by a stock movement; receipts cannot be deleted |
| 3 | `shipments_received` | static | every shipment is `delivered` and a receipt names it | `shipment_update`; receipt with `shipment_id` |
| 4 | `disputes_resolved` | static | no invoice is left `queried` | record the corrected bill and approve, or reject |
| 5 | `not_over_invoiced` | static | `over_invoiced` is not positive on any contract | dispute, then correct |
| 6 | `paid_within_arrived` | static | `paid_amount` never exceeds `payable_now` | pay what arrived; recover an overpayment |
| 7 | `advances_matched` | static | a planned advance is recorded on an advance-terms contract | record the advance against `contract_id` |
| 8 | `no_fulfilment_findings` | static | `checks_list` shows no `conflict` and no `payment_unconfirmed` | `payment_confirm`; correct the record named |

## Process

1. **Read labs fresh** per contract, all with `program_id`: `supply_chain_shipment_list`,
   `supply_chain_receipt_list`, `supply_chain_invoice_list`, `supply_chain_payment_list` (each
   with `contract_id`) and `supply_chain_contract_match({contract_id})`. Then
   `supply_chain_checks_list` once.
2. **Normalise** each contract with `normalizeContract(contract_id, raw)` and the checks with
   `normalizeChecks` (`checks.ts`). Read the plan into `FulfilPlan`.
3. **Run `CHECKS`** over `JSON.stringify({plan, readback})` and write the result with
   `aggregateQAResult`.
4. **On fail**, return the failures and their hints. Never "fix" by recording a second receipt or
   payment: these records are permanent and add up.

## MCP Tools Used

- connect-labs: `supply_chain_shipment_list`, `supply_chain_receipt_list`,
  `supply_chain_invoice_list`, `supply_chain_payment_list`, `supply_chain_contract_match`,
  `supply_chain_checks_list`
- ace-gdrive: `drive_read_file` (plan), `drive_create_file` (result)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR8): 8 static checks on labs' three-way match, grounded on a live capture of labs program 10605 contract 187 | ACE |
