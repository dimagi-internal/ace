---
name: demo
description: >
  Standalone demo-workflow procedure. Stands up a live labs-dashboard demo from
  a brief or a real op id (parameterized on data source), authors a canopy DDD
  narrative over it, and hands to the DDD loop. Runs the same synthetic pipeline
  as Phase 7, decoupled from the full /ace:run lifecycle.
model: inherit
---

# ACE Demo (Procedure Document)

This file is **read and executed inline by the top-level Claude Code session —
it is NOT dispatched as a subagent.** It dispatches the `canopy:ddd` agent and
invokes the DDD render loop, both of which need the `Agent` tool, available only
at level 0 (see `CLAUDE.md § Agent topology`). The frontmatter is retained for
tooling introspection.

## You are running a demo

A "demo" is a standalone run with ONE live phase — `synthetic-data-and-workflows`
— that produces a live labs dashboard for a funder/stakeholder meeting, without
the PDD → app → Connect lifecycle. Three data-source providers feed one pipeline:

| `--source` | front half | status |
|---|---|---|
| `denovo` | author data + dashboard from a brief | **Plan A (implemented)** |
| `clone` | clone a real Connect opp → dashboard | Plan B |
| `ace-run` | the Phase 4 opp of a `/ace:run` | Phase 7 convergence (Plan C) |

All three converge on the realized `${var}` map (`par_url`); everything from
`demo-narrative` onward is provider-agnostic.

## Process

1. **Parse arguments.** `--source {denovo|clone}` (Plan A: `denovo`; `clone` →
   report "not yet implemented — see Plan B"), `--brief <text|drive-path>`,
   `--name <demo-name>`, optional `--pin-monday <YYYY-MM-DD>`, optional
   `--render` (run the full `canopy:ddd` converge+video loop; default is a single
   render+judge via the `canopy:ddd-run` skill).

2. **Scaffold the demo run + state.** Generate `runId = YYYYMMDD-HHMM`. Ensure
   the Drive demo folder (`ACE/<name>/` + `runs/<runId>/7-synthetic/`) via the
   `ace-gdrive` atoms. Build the minimal structural `run_state.yaml` with the
   tested builder (DRY — do not hand-write the phase map):
   ```bash
   npx tsx -e "import {buildDemoRunState} from './lib/demo-run-state.js'; \
     import {stringify} from 'yaml'; \
     process.stdout.write(stringify(buildDemoRunState({ \
       demoName:'<name>', runId:'<runId>', source:'denovo', createdAt:new Date().toISOString()})))"
   ```
   Write the result to `ACE/<name>/runs/<runId>/run_state.yaml` (via
   `mcp__plugin_ace_ace-gdrive__drive_create_file`). Only
   `synthetic-data-and-workflows` is `in_progress`; all other pipeline phases are
   `skipped` — so `/ace:status <name>` and the eval rollups work unchanged.

3. **Set up data + dashboard.** Invoke the `demo-data-setup` skill with
   `{provider: denovo, brief, name, runId, pinMonday?}`. It returns the realized
   `${var}` map (`par_url` + drills) and writes `7-synthetic/realized.json`.

4. **Gate.** Invoke `demo-data-setup-qa`. On `fail`, apply the auto-fix hints and
   re-run step 3 (bounded retries) before proceeding — a dead dashboard must not
   reach a funder.

5. **Author the narrative.** Invoke the `demo-narrative` skill with
   `{brief, realizedRef: 7-synthetic/realized.json, runId}`. It writes
   `why_brief.yaml` + `<demo-slug>.yaml` and **validates them via canopy's
   `scripts.ddd.validate`** — do not proceed until both validate.

6. **Hand off to DDD.**
   - Default: invoke the `canopy:ddd-run` skill with `{run_id, unified_spec:
     <demo-slug>.yaml path, why_brief: why_brief.yaml path}` — one render+judge
     pass; produces per-scene screenshots + verdicts and the live dashboard.
   - `--render`: dispatch `Agent(canopy:ddd)` for the full converge → video →
     upload loop (honors its two pause gates: `concept_change`,
     `external_release`).

7. **Write back + summarize.** Set `phases.synthetic-data-and-workflows.status:
   done` (with `verdict`, `completed_at`, `summary_artifact`) and
   `steps.{demo-data-setup,demo-narrative,ddd-run}.status: done` via
   `update_yaml_file` (`merge: 'deep'`). Emit a short summary naming the live
   `par_url` and — if `--render` — the canopy-web `/ddd/<slug>/<run_id>` package
   URL.

## Preconditions (restore, don't adapt)

- Labs session live for rendering (`hal:synthetic-walkthrough § auth`, or the
  ACE labs login). If not restorable, fail loud — do not ship a placeholder.
- Canopy checkout reachable for `uv run python -m scripts.ddd.validate` and the
  DDD loop (default `/Users/jjackson/emdash-projects/canopy`; see the Task 1
  findings note).

## Not in scope (Plan A)

`clone` / `ace-run` providers; fidelity gating; retiring the Phase 7 bespoke
walkthrough/summary skills (that convergence is Plan C, which rewires
`agents/synthetic-data-and-workflows.md` onto this same pipeline).
