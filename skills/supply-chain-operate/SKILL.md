---
name: supply-chain-operate
description: >
  Run one week of a labs programme's stock: transfers, distributions, counts and the week's reads.
---

# Supply-chain operate

One week of stock moving through the network `supply-chain-setup` built: central store to regional
store, regional store out to each field worker, the workers' counts back, and the week's reads of
position, forecast, resupply, worker stock and open findings. `simulated-execution` calls it once per
delivery week; outside a simulation it records one real week from what partners and workers report.

Platform reference: [`playbook/integrations/connect-labs-supply-chain.md`](../../playbook/integrations/connect-labs-supply-chain.md)
§ Logistics and § Stock and distribution. In `/ace:run` this is part of the optional `supply_chain`
step (spec `docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md` § F5), in Phase 9 simulated
mode only.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the labs programme | explicit arg; default: run_state `phases.execution-management.products.supply_chain.program_id` |
| `week` | which week (1..N) | explicit arg (from `simulated-execution`) |
| `week_start`, `week_end` | the week's dates | explicit arg; default: run_state `products.simulation.calendar.weeks[week]` (`lib/sim-calendar.ts`, PR10) |
| `item_ids` | the trade items moving | explicit arg; default: run_state `products.supply_chain.items` |
| `supply_points` | `{central, regional, flw: {username: id}}` | explicit arg; default: run_state `products.supply_chain.supply_points` |
| `opportunity_id` | the opportunity the workers deliver | explicit arg; default: run_state `products.simulation.synthetic_opportunity_id` |
| `week_activity` | per worker and commodity, the week's **issue events**: `{<connect_username>: {<commodity_slug>: {issue_events, quantity}}}` plus each commodity's `issue_events_source` (what drives distribution) | explicit arg (from `simulated-execution`, `simulated-execution_issue-events.yaml`); outside a simulation, derived with `deriveIssueEvents` (`lib/supply-chain-issue-events.ts`) from the week's visits and the setup plan's `commodities[].issue_event` |
| `scope` | the `source.ref` scope | the run id inside `/ace:run`; outside one, `programScope(program_id)` (`lib/supply-chain-ref.ts`) |
| `simulated` | label every write, backdate, plant the week's events | `true` when Phase 9 `mode: simulated`; explicit arg otherwise |

No `run_state.yaml` is needed when every parameter is passed.

**Pipeline-only in one respect:** on the simulated track the plan plants one short consignment
receipt and one zero count (a stockout) across the weeks, so the reads and the weekly review have
something real to show. Outside a simulation every movement and count is what was reported, with
`source` set to who reported it.

## Products

- `9-execution-manager/supply-chain-operate_week-<w>_plan.yaml`: the week's consignments (each with
  a plan key used as its `reference`), per worker the week's `issue_events` and `issue_events_source`,
  the distribution per worker those issue events give, the counts (with the stock-count form they
  stand for), and whether this is the stockout week. Written **before any write**.
- `9-execution-manager/supply-chain-operate_week-<w>_stock.yaml`: the week's reads, as labs
  returned them, `as_of` the week's last day: `stock_position` per store, `stock_forecast`,
  `resupply_plan` per store, `worker_stock`, `stock_flow` and `checks_list`. This is what
  `simulated-weekly-review` reads.

## Process

1. **Precondition.** `supply_chain_programme_runner_get` must say `programme` (or `operator`).
2. **Plan the week** (Products, first file):
   - **Distribution follows the commodity's issue event** (ace#3216). A worker is resupplied with
     what they handed over: each worker's quantity is that week's issue events for the commodity
     times the quantity one issue hands over (`issueQuantity`, `lib/supply-chain-issue-events.ts`).
     A worker with no issue events gets nothing. The issue event is the one the setup plan declares
     per commodity (`commodities[].issue_event`): a form, a field and the answers that mean "handed
     over", e.g. Connect FI's phone on the UNPAID Follow-up Contact form, `phone_obtained` = "handed
     over today" / "voucher redeemed", to about 55-75% of enrolled adults, usually on a later visit.
     **Enrolments are not a proxy for it.** Only an issue event of `kind: per_enrolment` (the PDD
     says every enrolee gets one) distributes by enrolment. A commodity with no `issue_event` halts
     the week with `[BLOCKER] commodity <slug> declares no issue_event in the setup plan`; never fall
     back to enrolments silently. Copy `issue_events_source` into the plan, so a generated week
     (`simulated_from_eligibility`) is never read as one read off a form.
   - **Transfers follow need.** Central → regional carries what the regional store's distributions
     need beyond what it holds, read from `supply_chain_stock_position` (never assumed).
   - **Planted events (simulated track only):** in one week one consignment is received short (a
     carton damaged in transit); in one week one worker self-reports zero, which is a stockout.
3. **Transfer.** `supply_chain_consignment_dispatch({program_id, data: {from_supply_point_id: central, to_supply_point_id: regional, commodity_slug, item_id, quantity, quantity_unit, dispatched_on, expected_on, reference: <plan key>, source: "we_recorded"}, source})`.
   The sender's stock drops at once; the destination counts it only at receipt. Then
   `supply_chain_consignment_receive({consignment_id, data: {received_on, quantity_received}, source})`.
   Received short, labs writes the difference off as a loss naming the consignment.
4. **Distribute.** `supply_chain_distribution_record({program_id, data: {supply_point_id: regional, opportunity_id, commodity_slug, distributed_on, lines: [{connect_username, item_id, quantity, quantity_unit}], source: "partner_reported"}, source})`:
   one run, one line per worker. The LLO is the partner telling us what it distributed.
5. **Count.** For each worker, `supply_chain_stock_count_record({program_id, data: {supply_point_id: <worker's user_held point>, commodity_slug, item_id, kind: "self_reported", counted_on, quantity, quantity_unit, connect_username, opportunity_id, source: "commcare_form"}, source})`.
   A zero is a real observation, not a missing one: record it. Never use `kind: override` to make a
   count agree with the ledger; the variance is the finding. The count stands for the worker's
   stock-count form: when the setup plan names a `count_form` (Connect FI's Deliver app carries a
   weekly "Phone stock count" form), read the quantity from that form's answer in the week's
   visits and put the form and field in the plan. On a synthetic stream with no form identity
   (labs' de-novo visits carry none; see `lib/supply-chain-issue-events.ts`), the plan's count is
   what the worker holds after the week's distribution and issue events, plus the planted zero.
6. **Read the week** (Products, second file), every read `as_of` the week's last day where the atom
   takes one: `supply_chain_stock_position` per store, `supply_chain_stock_forecast` per item,
   `supply_chain_resupply_plan` per store, `supply_chain_worker_stock` per item,
   `supply_chain_stock_flow` per item, `supply_chain_checks_list`. Record any figure that comes back
   `{unconfirmed: [...]}` as unconfirmed with its reason; never fill it in.
7. **Hand to QA.** Dispatch `supply-chain-operate-qa` for the week.

**Every write** carries `source = buildSource({scope, skill: "supply-chain-operate", step, key, sender, sentOn, simulated, today})`
from `lib/supply-chain-ref.ts`, with `key` = `week-<w>:<natural key>` (`week-2:syn-flw-007`), so a
re-run of a week replays instead of writing twice. Dates are `simulatedDate(week_start, n)`: transfer
early in the week, distribution after it arrives, counts on the last working day.

## MCP Tools Used

- connect-labs: `supply_chain_programme_runner_get`, `supply_chain_consignment_dispatch`,
  `supply_chain_consignment_receive`, `supply_chain_distribution_record`,
  `supply_chain_stock_count_record`, `supply_chain_stock_position`, `supply_chain_stock_forecast`,
  `supply_chain_resupply_plan`, `supply_chain_worker_stock`, `supply_chain_stock_flow`,
  `supply_chain_checks_list`
- ace-gdrive: `drive_create_file` (plan + reads)

## Existing objects

- **Movements cannot be deleted.** A wrong transfer or distribution is corrected with a
  `stock_count_record` of `kind: override` and a reason, which posts the difference as an
  adjustment. Never record a reversing movement that did not happen.
- **Stock reads are about the real programme.** On a real programme every count and distribution
  changes what the forecast and resupply plan tell the people running it; record only what was
  reported.
- **Never run against a programme ACE does not own** (spec § F6).

## Mode Behavior

- **Auto:** Steps 1-7 for the given week.
- **Review:** shows the Step 2 plan and waits before Step 3.

## Dry-Run Behavior

When `--dry-run` is active, run Step 1, Step 2 and Step 6's reads. Write both files. Make no
`supply_chain_*` write.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-19 | Distribution follows each commodity's declared issue event, not enrolments x allocation; `week_activity` carries issue events and their source; counts reference the stock-count form (ace#3216, connect-fi/20261018-1440) | ACE |
| 2026-10-18 | Initial version (optional-track PR9): one week of transfers, distributions driven by enrolments, counts (with a planted short receipt and stockout), and the week's as-of reads | ACE |
