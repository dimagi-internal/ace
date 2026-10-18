---
name: simulated-weekly-review
description: >
  Write one simulated week's program review from labs' saved run and stock.
---

# Simulated weekly review

One week of a simulated program, written the way an LLO lead and a program manager would want it on
Monday: how far enrolment got against the design's targets, where stock stands and where it ran out,
what labs flagged, and what each of them should do next. Every number is read from labs for that
week; none is computed or remembered.

`simulated-execution` calls it once per delivery week. It also works on a real program's week when
given a saved run and stock reads, in which case there is no simulation note.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `week` | which week, with its `start`/`end` | explicit arg; default: run_state `products.simulation.calendar.weeks[week]` |
| `definition_id`, `opportunity_id` | the weekly report and its scope | explicit arg; default: run_state `products.simulation.{workflow_id, synthetic_opportunity_id}` |
| `run_id` | the week's saved run | explicit arg; default: the `workflow_history_runs` row whose period is the week |
| `stock_file` | the week's labs stock reads | explicit arg; default: `9-execution-manager/supply-chain-operate_week-<w>_stock.yaml` (absent without `supply_chain`) |
| `pdd_targets` | the targets the week is judged against | explicit arg; default: the PDD's Performance Measures |
| `simulated` | prepend the simulation note | `true` when Phase 9 `mode: simulated` |
| `out_folder_id` | where the review goes | explicit arg; default: the run's `9-execution-manager/` |

## Products

- `9-execution-manager/simulated-week-<w>_review.md`.

## Process

1. **Read the week, as labs graded it:** `workflow_run_indicators({run_id, opportunity_id, scope: "opportunity"})`
   and `({run_id, opportunity_id, scope: "worker", band: "red"})`. If `cache.cold` is true, say the
   figures are not loaded rather than reporting zeros. Read the stock file.
2. **Write the review**, in this order:
   1. **First line, on the simulated track:** "Simulated week <w> (<start>–<end>). Dates are
      backdated; the solicitation and award carry real dates, later than this week."
   2. **Progress against the design:** for each PDD target (adults with an accepted ID, SIM in own
      name, working phone, funded wallet, or whatever the PDD names), labs' value, its `n`, its band,
      and the target. A target the report has no indicator for is listed as "not measured", never
      estimated.
   3. **Supply:** each store's position and forecast, the resupply plan, any worker at zero (the
      stockout), each figure with the read it came from. `{unconfirmed: [...]}` stays unconfirmed.
   4. **What labs flagged:** red-band workers by name with the indicators that put them there, and
      open `checks_list` items grouped by audience.
   5. **Next actions:** two short lists, for the LLO lead and for the program manager, each item
      tied to a figure above.
3. **Hand to eval** (`simulated-weekly-review-eval`).

## MCP Tools Used

- connect-labs: `workflow_run_indicators`, `workflow_history_runs`
- ace-gdrive: `drive_read_file`, `drive_create_file`

## Mode Behavior

- **Auto / Review:** same; the review is a file, not a send.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR10): one week's review from labs' saved run and stock reads | ACE |
