---
name: demo-data-setup
description: >
  Stand up the initial dataset + live labs dashboard for a standalone demo,
  parameterized on data source. Returns the realized ${var} map (par_url) that
  a DDD narrative's setup block consumes. Plan A implements the `denovo`
  provider; `clone` and `ace-run` are documented but land in Plan B / Phase 7
  convergence.
disable-model-invocation: true
---

# Demo Data Setup

The **data + dashboard** half of the ACE demo workflow. Given a short demo
brief, it generates synthetic data and authors a live labs dashboard
dynamically (no production traffic, no ACE-built Connect opp required), then
hands the downstream `demo-narrative` skill a single artifact: the **realized
`${var}` map** — a flat JSON containing `par_url` (the polished dashboard
deep-link) plus any drill URLs.

This skill is the standalone/`denovo` sibling of the Phase 7 pair
`synthetic-data-generate` (data) + `synthetic-workflow-seed` (dashboard). It
composes the same connect-labs atom sequence those skills use, but decoupled
from `opp.yaml` / the PDD / a Phase 4 Connect opportunity — that decoupling is
the whole point of the demo entry point. For the detailed atom mechanics and
labs-side gotchas it does not repeat inline, it cites those two skills by
section.

## Providers (the data-source seam)

| provider | source | status |
|---|---|---|
| `denovo` | a short demo brief (this skill) | **implemented (Plan A)** |
| `clone` | a real Connect opportunity id | Plan B — `synthetic_clone_profile` → `_generate` → author dashboard over the cloned opp ids |
| `ace-run` | the Phase 4 opp of a full `/ace:run` | Phase 7 convergence (Plan C) — Phase 7 becomes this provider |

All three converge on the **same handoff**: the realized `${var}` map. Only the
front half (how the labs-only opp + its data come to exist) differs.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator (CLI) | `--brief <text or drive-path>` | the demo story: program, KPI focus, named FLWs, the anomaly to surface, the coaching beat |
| Operator (CLI) | `--name <demo-name>` | the demo folder `ACE/<demo-name>/` |
| Procedure | demo `run_id` | the current demo run folder (scaffolded by `agents/demo.md` via `buildDemoRunState`) |
| Operator (CLI, optional) | `--pin-monday <YYYY-MM-DD>` | fixed timeline anchor; if omitted, compute a recent Monday and **record it** — never a sliding window (see Gotchas) |

## Products

- `<demo-run>/7-synthetic/demo-data-setup_manifest.yaml` — the per-opp generator manifest sent to labs
- `<demo-run>/7-synthetic/realized.json` — **the handoff**: a **FLAT** `${var}` map (DDD substitutes `${var}` verbatim — keep it flat, no nesting). One `<key>_par_url` per dashboard the demo builds, plus `primary_par_url` (the dashboard the walkthrough opens on) and any `<name>_url` drills. E.g. `{ "primary_par_url": ..., "program_admin_par_url": ..., "child_recovery_par_url": ..., "audit_good_url": ... }`
- `<demo-run>/7-synthetic/demo-data-setup.md` — run summary (labs opp id, record counts, one par_url per dashboard, warnings)
- `run_state.yaml.phases.synthetic-data-and-workflows.products.synthetic.source` — the seam contract, populated:
  ```yaml
  source:
    provider: denovo
    labs_synthetic_opp_id: <int ≥ 10000>
    deliver_units: [{slug, name}]
    narrative_context_ref: <drive path to the manifest>
    dashboards:                        # one per dashboard the Step-0 plan selected
      - key: program_admin             # → ${program_admin_par_url} in realized.json
        template: program_admin_report
        role: overview
        par_url: <url>
      - key: child_recovery
        template: sam_followup
        role: recovery
        par_url: <url>
    primary_dashboard: program_admin
    realized_vars_ref: 7-synthetic/realized.json
  ```
- `run_state.yaml.phases.synthetic-data-and-workflows.steps.demo-data-setup.status: done` (+ `artifact` path)

## Process (denovo)

0. **Plan the demo from the ask (interpret + select templates).** Turn the raw
   brief/ask (which may be a forwarded email) into a concrete plan BEFORE
   generating anything:
   - **Enumerate the dashboards the ask needs.** A narrative like "program
     management across LLOs AND individual children getting better" is **two**
     dashboards, not one. Give each a `key` (e.g. `program_admin`,
     `child_recovery`) and a `role`.
   - **Select a checked-in template per dashboard — reuse over scratch.** Survey
     the palette with `mcp__connect-labs__list_templates` plus the labs
     `connect_labs/workflow/templates/` library, and map each dashboard to the
     best fit. Known fits (MUAC-only nutrition):
     - multi-LLO / FLW oversight → `program_admin_report` (+ `chc_nutrition_analysis` for the FLW aggregate).
     - per-child recovery over follow-up visits → `sam_followup` (MUAC + recovery-status timeline). **Not** `kmc_longitudinal` — it keys on weight, unusable when CHWs have no scales.
     Only `workflow_create` from SCRATCH when nothing in the palette fits, and say
     so explicitly in the summary.
   - **Derive the data story per dashboard** — personas, the anomaly/recovery
     arcs (MUAC recovery = children moving red[SAM]→yellow[MAM]→green across
     follow-up weeks), timeline. This becomes the manifest (step 1) and the
     narrative context `demo-narrative` reads.
   Record the plan (`dashboards[]` with key/template/role) — it drives steps 1–5
   and the `source.dashboards` write-back.

1. **Author the per-opp generator manifest from the brief.**

   Write `demo-data-setup_manifest.yaml`. Structure + field rules are identical
   to the Phase 7 manifest — follow `skills/synthetic-data-generate/SKILL.md
   § Process` (manifest schema) and its manifest-schema gotchas rather than
   re-deriving them. Demo-specific requirements:
   - `opportunity_id`: a labs-only id **≥ 10000** (see Gotchas).
   - `flw_personas`: first persona is the **network manager** (`flag_rate: 0`);
     the rest carry `accuracy_distribution` reflecting the brief's quality
     spread.
   - `anomalies`: **0-based** `week` indices; only anomalies with
     `reviewer_visible_in: [audit]` mint audits. Put the brief's headline
     anomaly on a completed week.
   - `coaching_arcs`: **1-based** `week_triggered`; transcripts are authored
     verbatim from the brief's coaching beat.
   - `timeline.start_date`: the pinned Monday (from `--pin-monday` or computed);
     it MUST equal the env timeline anchor.

2. **Generate the synthetic data.**

   Call `mcp__connect-labs__synthetic_create_labs_only` to mint the labs-only
   opportunity, then `mcp__connect-labs__synthetic_generate_from_manifest` with
   the manifest to write visits + user_data + completed_works. Mechanics +
   payment-unit pre-flight: `skills/synthetic-data-generate/SKILL.md § Process`
   steps 1a–3. Capture the returned `labs_opp_id` and `deliver_units`.

3. **Author each planned dashboard dynamically.** Loop over the Step-0
   `dashboards[]`; for **each**, run the ADAPT-or-SCRATCH flow from
   `skills/synthetic-workflow-seed/SKILL.md § Process`:
   `mcp__connect-labs__workflow_create_from_template` (ADAPT — the default; pass
   the dashboard's selected template) *or* `mcp__connect-labs__workflow_create`
   (SCRATCH — only when nothing fit) →
   `mcp__connect-labs__pipeline_update_schema` →
   `mcp__connect-labs__workflow_update_render_code` /
   `mcp__connect-labs__workflow_patch_render_code` →
   `mcp__connect-labs__workflow_create_run` →
   `mcp__connect-labs__workflow_save_snapshot`. Reuse that skill's
   alias-consistency, period-scoping, and snapshot-hook guidance by reference —
   they are the difference between a populated dashboard and a blank one. Capture
   each dashboard's `<def_id>` + saved `<run_id>`.

   **Nutrition note:** `program_admin_report` / `chc_nutrition_analysis` /
   `sam_followup` are checked-in templates — ADAPT via
   `workflow_create_from_template`, never build render_code from scratch.

4. **Build a `par_url` per dashboard.**

   For each planned dashboard, assemble the deep-link from its saved run:
   `https://labs.connect.dimagi.com/labs/workflow/<def_id>/run/?run_id=<run_id>&opportunity_id=<opp_id>`,
   and name it `${key}_par_url`. Set `primary_par_url` to the
   `primary_dashboard`'s. The **bare** workflow URL renders the run *picker*, not
   the dashboard — a saved `run_id` in the query string is required
   (`docs/learnings/2026-06-13-labs-workflow-run-deeplink.md`).

5. **Emit the handoff + write back.**

   Write `realized.json` — the **flat** multi-var map (`{ primary_par_url,
   <key>_par_url per dashboard, <name>_url drills }`) — the summary `.md`, and
   the `source` block above (including `dashboards[]` + `primary_dashboard`) into
   the demo `run_state.yaml` via
   `mcp__plugin_ace_ace-gdrive__update_yaml_file` (`merge: 'deep'` — never
   `two-level`, which would drop sibling sub-keys; see CLAUDE.md gotcha). Set
   the `steps.demo-data-setup` block to `status: done` with the `realized.json`
   artifact path.

Then gate on `demo-data-setup-qa` before `demo-narrative` consumes the map.

## Gotchas (encode every one — they are the difference between a live demo and a dead scene)

- [ ] **Labs-only opp ids ≥ 10,000 have no CommCare HQ app.** Anything needing a
  real HQ app (deliver-unit introspection, enabling "Create Review") can't be
  driven for a synthetic opp — the generator writes records directly. Pin the
  opp id ≥ 10000.
- [ ] **Pin the timeline** to a fixed Monday. An unpinned trailing window slides
  off "today" and strands already-seeded runs/flags/audits/tasks on the wrong
  week, breaking idempotency. `start_date` must be a Monday and must equal the
  env anchor.
- [ ] **Do NOT pre-seed the flagged current-week worker's audit/task.** The
  live-demo scene creates them on camera; pre-seeding leaves nothing to click.
  The flagged worker is the one on the in-progress current week.
- [ ] **First persona = network manager**, `flag_rate: 0`, across flags /
  task-creator / rollup label.
- [ ] **A "resolved" cluster needs every audit completed AND every task closed.**
  The rollup drill selector needs one fully-resolved cluster (the "good" drill)
  and one still-open cluster in a *different* opp — otherwise `good_*`/
  `incomplete_*` vars are omitted.
- [ ] **Anomaly weeks are 0-based (audits); coaching-arc weeks are 1-based
  (tasks).** Out-of-window anomalies are silently skipped.

## Not in scope (Plan A)

- `clone` / `ace-run` providers — see the providers table.
- Fidelity checking (`synthetic_fidelity_report`) — a `clone`-only QA gate in
  Plan B.
- Rendering / judging / video — owned by canopy DDD, invoked after
  `demo-narrative` by `agents/demo.md`.
