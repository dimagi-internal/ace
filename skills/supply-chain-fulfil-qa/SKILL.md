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
invoiced, and `payable_now`. It is computed by labs and never stored, so it is the authority, not
ACE's sums. `payable_now` is what is still safe to pay, **net of payments already recorded**, not
the value that arrived (ace#3260); the value that arrived is `received` × the contract's
`unit_price`.

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
| 6 | `paid_within_arrived` | static | `paid_amount` never exceeds `received` × contract `unit_price`; without a unit price, only `payable_now >= 0` is judged and the detail says the value arrived is unavailable | pay what arrived; recover an overpayment |
| 7 | `advances_matched` | static | a planned advance is recorded on an advance-terms contract | record the advance against `contract_id` |
| 8 | `no_fulfilment_findings` | static | `checks_list` shows no `conflict` and no `payment_unconfirmed` | `payment_confirm`; correct the record named |

## Process

1. **Read labs fresh** per contract, all with `program_id`: `supply_chain_shipment_list`,
   `supply_chain_receipt_list`, `supply_chain_invoice_list`, `supply_chain_payment_list` (each
   with `contract_id`), `supply_chain_contract_match({contract_id})` and
   `supply_chain_contract_get({contract_id})` (for `unit_price`; the contract's row from
   `supply_chain_contract_list` does as well). Then `supply_chain_checks_list` once.
2. **Normalise** each contract with `normalizeContract(contract_id, raw)`, passing the contract read
   as `raw.contract`, and the checks with
   `normalizeChecks` (`checks.ts`). Read the plan into `FulfilPlan`.
3. **Run `CHECKS`** over `JSON.stringify({plan, readback})` and write the result with
   `aggregateQAResult`.
4. **On fail**, return the failures and their hints. Never "fix" by recording a second receipt or
   payment: these records are permanent and add up.

## MCP Tools Used

- connect-labs: `supply_chain_shipment_list`, `supply_chain_receipt_list`,
  `supply_chain_invoice_list`, `supply_chain_payment_list`, `supply_chain_contract_match`,
  `supply_chain_contract_get`,
  `supply_chain_checks_list`
- ace-gdrive: `drive_read_file` (plan), `drive_create_file` (result)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-20 | `paid_within_arrived` judges paid against `received` × contract `unit_price` (read with `supply_chain_contract_get`), not `payable_now`, which labs nets of payments already made and which reads 0 on a fully paid contract; control from labs programme 361 contract 323 (ace#3260) | ACE |
| 2026-10-18 | Initial version (optional-track PR8): 8 static checks on labs' three-way match, grounded on a live capture of labs program 10605 contract 187 | ACE |
