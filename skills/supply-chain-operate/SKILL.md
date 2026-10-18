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
| `week_activity` | per worker, the week's enrolments (what drives distribution) | explicit arg; default: read from labs for the week's window (the synthetic opportunity's visits) |
| `scope` | the `source.ref` scope | the run id inside `/ace:run`; outside one, `programScope(program_id)` (`lib/supply-chain-ref.ts`) |
| `simulated` | label every write, backdate, plant the week's events | `true` when Phase 9 `mode: simulated`; explicit arg otherwise |

No `run_state.yaml` is needed when every parameter is passed.

**Pipeline-only in one respect:** on the simulated track the plan plants one short consignment
receipt and one zero count (a stockout) across the weeks, so the reads and the weekly review have
something real to show. Outside a simulation every movement and count is what was reported, with
`source` set to who reported it.

## Products

- `9-execution-manager/supply-chain-operate_week-<w>_plan.yaml`: the week's consignments (each with
  a plan key used as its `reference`), the distribution per worker with the enrolment figure it came
  from, the counts, and whether this is the stockout week. Written **before any write**.
- `9-execution-manager/supply-chain-operate_week-<w>_stock.yaml`: the week's reads, as labs
  returned them, `as_of` the week's last day: `stock_position` per store, `stock_forecast`,
  `resupply_plan` per store, `worker_stock`, `stock_flow` and `checks_list`. This is what
  `simulated-weekly-review` reads.

## Process

1. **Precondition.** `supply_chain_programme_runner_get` must say `programme` (or `operator`).
2. **Plan the week** (Products, first file):
   - **Distribution follows activity.** Each worker's quantity is that week's enrolments times the
     per-person allocation in the setup plan. A worker with no enrolments gets nothing.
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
   count agree with the ledger; the variance is the finding.
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
| 2026-10-18 | Initial version (optional-track PR9): one week of transfers, distributions driven by enrolments, counts (with a planted short receipt and stockout), and the week's as-of reads | ACE |
