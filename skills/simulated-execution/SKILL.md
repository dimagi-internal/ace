---
name: simulated-execution
description: >
  Run N backdated weeks of a program with no real LLO: synthetic visits, weekly stock and reviews.
---

# Simulated execution

Runs a program's delivery for N simulated weeks after the award, with no real LLO involved. The
visits are synthetic, the week's stock moves through labs supply chain, labs saves one report run
per week, and each week gets a review an LLO and a program manager could act on. Everything is
dated in the past (`lib/sim-calendar.ts`), because labs has no clock to move.

In `/ace:run` this is the optional `simulate_weeks` step, run by `agents/execution-manager.md`
§ Simulated mode, Phase 9 `mode: simulated` only (spec
`docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md` § G). It is OFF by default.

**It never contacts anyone.** No email, no Connect invite, no `llo-onboarding`, no Connect
opportunity mutation. The visits live on a labs-only copy filed under the ACE winner org, never on
the run's real Phase 4 opportunity.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `calendar` | week 0 + delivery weeks | explicit arg; default: run_state `phases.execution-management.products.simulation.calendar` (written by the agent's S0 from `scripts/sim-calendar.ts`) |
| `weeks` | N | explicit arg; default: run_state `optional_steps.simulate_weeks` |
| `source_opp_int_id` | the opportunity the synthetic data is shaped on | explicit arg; default: run_state `phases.connect-setup.products.connect.opportunity.connect_int_id` |
| `winner_org_name` | the org the labs-only copy is filed under | explicit arg; default: the display name of `connect_orgs.llo_org` (`selected_llo.org_slug`) |
| `template_workflow` | the semantic-snapshot report cloned for the weekly runs | explicit arg `{workflow_id, program_id}`; default: run_state `phases.synthetic-data-and-workflows.products.synthetic.cascade.worker_review` (else `.programme_report`) |
| `pdd_targets` | what each week is judged against (ID, SIM, phone, wallet funded) | explicit arg; default: the PDD's Performance Measures section (run_state `phases.idea-to-design.products.pdd`) |
| `supply_chain` | whether each week also runs `supply-chain-operate` | explicit arg; default: run_state `optional_steps.supply_chain` |
| `out_folder_id` | where the files go | explicit arg; default: the run's `9-execution-manager/` folder |

Outside a run, pass every parameter; nothing reads or writes `run_state.yaml`.

## Products

- `9-execution-manager/simulated-execution_plan.yaml`: the window, the synthetic-data manifest
  (whose persona ids are the setup plan's FLW usernames, so distributions map to workers 1:1), and
  the per-week enrolment the PDD implies. Written **before any write**.
- `9-execution-manager/simulated-week-<w>_review.md`: one per delivery week, by
  `simulated-weekly-review`.
- `9-execution-manager/simulated-execution_summary.md`: links every weekly review, the labs report
  run for each week, and the supply-chain programme pages.
- run_state `phases.execution-management.products.simulation`: `synthetic_opportunity_id`,
  `workflow_id`, `weekly_reviews[]` (the calendar was written by the agent's S0). Each id is
  written **the moment its create call returns**, because a re-run would otherwise create a second
  copy (ace#2412).

## Process

1. **Preconditions.** Calendar present and valid (`assertSimCalendar`); `selected_llo.synthetic_winner: true`;
   with `supply_chain`, `supply-chain-procure-qa` and `supply-chain-fulfil-qa` both `pass` (week 0
   is done). Any miss halts with `[BLOCKER]` naming it. Never start week 1 on a broken week 0.
2. **Plan** (first Products file). The manifest's `timeline` is `deliveryWindow(calendar)`, and
   visit cadence follows the PDD's enrolment target spread over N weeks. Plant one under-performing
   worker so the reviews have something to act on.
3. **Generate the visits once**, for the whole window: `synthetic-data-generate --opp-int-id
   <source_opp_int_id> --manifest <plan's manifest> --out-folder-id <out_folder_id> --no-pause`.
   Then `synthetic_clone_to_labs_only({source_opportunity_id: <its labs_opp_id>, org_name:
   <winner_org_name>, label: "<opp> simulated delivery (ACE)"})` and write
   `products.simulation.synthetic_opportunity_id` at once.
4. **The weekly report.** `workflow_clone({source_workflow_id, source_program_id, target_opportunity_id:
   <synthetic opp>, linked: true, new_name: "<opp> simulated weekly review"})`: a linked twin keeps
   the registry binding and pipelines. Then `workflow_history_eligibility` must say eligible; if not,
   halt with `[BLOCKER]` (a non-semantic-snapshot report would draw a flat line). Write
   `products.simulation.workflow_id`.
5. **Save one run per week.** `workflow_preview_as_of({definition_id, opportunity_id, as_of: week1.end})`
   first: if `cache.partial_cache` or every count is 0, call `workflow_ensure_visit_cache` and retry,
   never build history over a cold cache. Then
   `workflow_rebuild_history({definition_id, opportunity_id, cadence: "weekly", start: week1.start,
   end: weekN.end, limit: N})`; while `done` is false call again with `start = next_start` and the
   same `end`; follow a `job_id` with `job_status`.
6. **Each delivery week w = 1..N**, in order:
   1. With `supply_chain`: `supply-chain-operate` with `{program_id, week: w, week_start, week_end,
      opportunity_id: <synthetic opp>}`, then its QA. A failed week halts the loop.
   2. `simulated-weekly-review` for week w, then `simulated-weekly-review-eval` unless `--no-evals`.
7. **Summary** (last Products file), then `products.simulation.weekly_reviews`, then dispatch
   `simulated-execution-qa`.

## MCP Tools Used

- connect-labs: `synthetic_clone_to_labs_only`, `workflow_clone`, `workflow_history_eligibility`,
  `workflow_preview_as_of`, `workflow_ensure_visit_cache`, `workflow_rebuild_history`,
  `job_status`, `workflow_history_runs`
- ace-gdrive: `drive_create_file`, `update_yaml_file` (`merge: deep`)
- Skills: `synthetic-data-generate`, `supply-chain-operate`, `simulated-weekly-review`

## Existing objects

- **The weekly runs are replaceable; the supply-chain records are not.** Re-running Step 5
  replaces only the runs `workflow_rebuild_history` itself made, with new run ids: relink the
  weekly reviews afterwards. Stock movements cannot be deleted (spec § F6); a re-run of a week
  replays by `source.ref`.
- **Never simulate on a program ACE does not own,** and never on the real Phase 4 opportunity.

## Mode Behavior

- **Auto:** Steps 1-7.
- **Review:** shows the Step 2 plan and waits before Step 3.

## Dry-Run Behavior

Steps 1-2 and Step 4's eligibility read only. Write the plan; create nothing in labs.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR10): backdated N-week simulation on a labs-only copy under the ACE winner, weekly stock and saved report runs, one review per week | ACE |
