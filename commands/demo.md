---
description: Stand up a standalone live labs-dashboard demo (clone or de-novo synthetic) and hand it to the canopy DDD loop
argument-hint: --source denovo --brief <text|path> --name <demo-name> [--pin-monday YYYY-MM-DD] [--render]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:demo

Build a killer live labs-dashboard demo for a funder/stakeholder meeting from
either a real Connect opportunity (`--source clone`, Plan B) or de-novo synthetic
data (`--source denovo`), then hand it to the canopy DDD loop for a narrated
walkthrough. A demo is a standalone run with one live phase — it does **not** run
the PDD → app → Connect lifecycle.

## Arguments
- `--source {denovo|clone}` — the data-source provider. **`denovo`**: author data +
  dashboard from `--brief`. **`clone`**: profile a real Connect opp
  (`synthetic_profile_from_prod`, mirror) into synthetic data, then author the same
  dashboards + a fidelity gate.
- `--opp <connect-opp-id>` — required for `--source clone`: the real Connect
  opportunity whose live delivery data seeds the demo.
- `--brief <text|drive-path>` — the demo story: program, KPI focus, named FLWs,
  the anomaly to surface, the coaching beat. Required for `denovo`; for `clone` it
  supplies the narrative framing over the profiled data.
- `--name <demo-name>` — the demo folder `ACE/<demo-name>/`. Required.
- `--pin-monday <YYYY-MM-DD>` — optional fixed timeline anchor (a Monday). If
  omitted, a recent Monday is computed and recorded. Never a sliding window.
- `--render` — run the full `canopy:ddd` converge + video + upload loop. Default
  is a single render+judge pass (`canopy:ddd-run`).

## Process

1. **Parse arguments.** Default `--source denovo`. `--source clone` requires
   `--opp <connect-opp-id>`; if the opp has no live delivery data to profile, stop
   and tell the operator to use `--source denovo` for that program until it does.

2. **Execute the demo procedure inline at top-level.** Read `agents/demo.md` and
   follow it as a procedure document from this (top-level) session. Do **NOT**
   dispatch `Agent(demo)` — it is a procedure doc, not a subagent (`CLAUDE.md §
   Agent topology`): it dispatches the `canopy:ddd` agent and the DDD render
   loop, which need the `Agent` tool, available only at level 0.

   Thread through: `source`, `brief`, `name`, `pinMonday`, `render`.

3. The procedure produces the live dashboard `par_url` and (with `--render`) the
   canopy-web `/ddd/<slug>/<run_id>` package. Log both to the console.
