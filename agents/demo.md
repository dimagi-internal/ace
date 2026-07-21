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
| `denovo` | author data + dashboard from a brief | **implemented (Plan A)** |
| `clone` | profile a real Connect opp → synthetic data → dashboard | **implemented (Plan B)** |
| `ace-run` | the Phase 4 opp of a `/ace:run` | Phase 7 convergence (Plan C) |

All three converge on the realized `${var}` map (`par_url`); everything from
`demo-narrative` onward is provider-agnostic.

## Process

1. **Parse arguments.** `--source {denovo|clone}` (`clone` requires `--opp
   <connect-opp-id>`), `--brief <text|drive-path>`,
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
   `{provider: <source>, brief, name, runId, pinMonday?, opp?}` — `opp` is the real
   Connect opportunity id when `source == clone`. It returns the realized `${var}`
   map (`par_url` + drills) and writes `7-synthetic/realized.json`.

4. **Gate.** Invoke `demo-data-setup-qa`; **for `clone` also invoke
   `demo-fidelity-check`** (confirms the clone reproduces the real source's shape).
   On `fail`, apply the auto-fix hints and re-run step 3 (bounded retries) before
   proceeding — a dead or low-fidelity dashboard must not reach a funder.

5. **Author the narrative.** Invoke the `demo-narrative` skill with
   `{brief, realizedRef: 7-synthetic/realized.json, runId}`. It writes
   `why_brief.yaml` + `<demo-slug>.yaml` and **validates them via canopy's
   `scripts.ddd.validate`** — do not proceed until both validate.

6. **Render the walkthrough.** The `realized.json` the setup block points at must
   already carry a real `run_id` in every dashboard URL (step 3 + the URL model
   below), and the labs session must be fresh (preconditions). Then:
   - Default: invoke the `canopy:ddd-run` skill with `{run_id, unified_spec:
     <demo-slug>.yaml path, why_brief: why_brief.yaml path}` — one render+judge
     pass. It drives `record_video` against the LIVE app; the verified invocation:
     ```bash
     cd <canopy> && uv run python -m scripts.walkthrough.record_video \
       --spec <demo-slug>.yaml --output <run>/walkthrough.mp4 \
       --snapshots <run>/snapshots --report <run>/render-report.json \
       --storage-state ~/.ace/labs-session.json --skip-same-url --no-prewarm
     ```
   - `--render`: dispatch `Agent(canopy:ddd)` for the full converge → video →
     upload loop (pause gates `concept_change`, `external_release`).

   **Verified dashboard-URL model (2026-07-21) — EVERY dashboard renders at**
   `…/labs/workflow/<def>/run/?run_id=<id>&opportunity_id=<opp>`. Traps that BOUNCE:
   no `run_id` → the workflow LIST; no `/run/` → the DEFINITION page. **Action-shaped**
   dashboards (`supports_saved_runs:false`, e.g. `sam_followup`) have no saved run,
   so `demo-data-setup` MUST mint one via `mcp__connect-labs__workflow_create_run`
   and use that `run_id`. Scene targets are real on-screen text (`text:Latest MUAC`),
   never guessed CSS.

   **Known caveat:** per-scene screenshots capture reliably, but canopy's internal
   `webm→mp4` ffmpeg conversion can exit 1 (render-infra bug, canopy-side) — the
   screenshots are the fallback deliverable.

7. **Write back + summarize.** Set `phases.synthetic-data-and-workflows.status:
   done` (with `verdict`, `completed_at`, `summary_artifact`) and
   `steps.{demo-data-setup,demo-narrative,ddd-run}.status: done` via
   `update_yaml_file` (`merge: 'deep'`). Emit a short summary naming the live
   `par_url` and — if `--render` — the canopy-web `/ddd/<slug>/<run_id>` package
   URL.

## Preconditions (restore, don't adapt — verified live 2026-07-21)

- **Live labs browser session for rendering.** A stored session expires (~6 days),
  so refresh it unconditionally at the start (restore, don't probe). ACE has full
  labs-login capability — no human needed:
  ```bash
  npx --prefix . tsx bin/labs-walkthrough-login.ts \
    --connect-base-url https://connect.dimagi.com \
    --labs-base-url https://labs.connect.dimagi.com
  # → writes ~/.ace/labs-session.json (a Playwright storage_state)
  ```
  Reads `ACE_HQ_USERNAME`/`ACE_HQ_PASSWORD` from the env. The wrapper
  `bin/ace-labs-walkthrough-login` does `set -euo pipefail; set -a; source
  <plugin-data>/.env`, so it needs every `.env` value SHELL-SAFE — a value with an
  unquoted `!` exits 127 before login (the EU-cred class; fixed by quoting in
  `.env.tpl` + `/ace:setup --force-env`). If the wrapper still fails on `.env`, run
  the `tsx` above with the two creds exported by SAFE parse
  (`sed -n 's/^ACE_HQ_USERNAME=//p' <plugin-data>/.env`), never `source`.
- Canopy checkout reachable for `uv run python -m scripts.ddd.validate` and
  `record_video` (default `/Users/jjackson/emdash-projects/canopy`; `uv` on PATH).

## Not in scope

`ace-run` provider; retiring the Phase 7 bespoke
walkthrough/summary skills (that convergence is Plan C, which rewires
`agents/synthetic-data-and-workflows.md` onto this same pipeline).
