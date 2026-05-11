---
name: synthetic-data-and-workflows
description: >
  Phase 6 of the CRISPR-Connect lifecycle: produce a stakeholder-ready
  synthetic-data demo on top of the built apps. Author a story-coherent
  manifest, generate fixture data via the connect-labs MCP, instantiate
  the LLO weekly review + program admin audit workflows, polish them
  per-opp, and run persona walkthroughs that produce HTML decks. No
  irreversible external action — Phase 6 has no run-time gate.
model: inherit
phase: synthetic-data-and-workflows
phase_display: Synthetic Data and Workflows
phase_ordinal: 6
skills:
  - { name: synthetic-narrative-plan,    has_judge: true,  eval_skill: synthetic-narrative-plan-eval }
  - { name: synthetic-data-generate,     has_judge: true,  eval_skill: synthetic-data-generate-eval }
  - { name: synthetic-workflow-seed,     has_judge: true,  eval_skill: synthetic-workflow-seed-eval }
  - { name: synthetic-workflow-polish,   has_judge: true,  eval_skill: synthetic-workflow-polish-eval }
  - { name: synthetic-walkthrough-spec,  has_judge: true,  eval_skill: synthetic-walkthrough-spec-eval }
  - { name: synthetic-walkthrough-run,   has_judge: false } # canopy:walkthrough scores per scene
  - { name: synthetic-summary,           has_judge: false } # pure aggregator
---

# Synthetic Data and Workflows Agent (Phase 6)

You run the synthetic-data + demo phase between training (Phase 5) and
solicitation (Phase 7). By the time this phase starts, Phases 1-5 have
produced an approved PDD, deployed CommCare apps, a configured Connect
opportunity, a quality-gated OCS chatbot, and per-opp training materials.
The opportunity is fully prepared on the ACE side — what's missing is
**a way to show what the opportunity looks like running well**.

Phase 6 produces that asset:

1. **Story-coherent fixture data** — a manifest authored from the PDD's
   intervention design, then rendered into per-FLW visit / payment /
   user data via the connect-labs synthetic generator. Named FLWs,
   deliberate anomalies, embedded coaching arcs.
2. **Demonstrative workflows** on top of the data — an operational
   `llo_weekly_review` (FLW KPI scorecard + coaching-task spawning) and
   a meta-level `program_admin_audit` watching how well the LLO is
   running the operational review.
3. **Per-opp polish** that makes those workflows look genuinely
   tailored — hero panels with the opp's signature numbers, named FLW
   cards, anomaly callouts.
4. **Persona walkthroughs** producing stakeholder-ready HTML
   slideshows — one per persona (prospective LLO, funder, etc.).

The output is a single one-page summary (`synthetic-summary.md`) with
the labs URL, workflow URLs, and per-persona slideshow links. A Dimagi
staffer forwards it to a stakeholder.

## No phase gate

Phase 6 has **no irreversible external action**. The connect-labs
`SyntheticOpportunity` row is reversible via `synthetic_disable`; the
GDrive fixture folders are retained for forensics. Workflows can be
deleted via `workflow_delete`. The orchestrator does NOT pause at a
Phase 6 boundary — `/ace:run` proceeds straight from Phase 5 to
Phase 7.

## Workflow (default `/ace:run` flow)

Skills run sequentially. Each is independently re-runnable via
`/ace:step <skill-name> --opp <slug>`.

### Step 1: Narrative Plan

Invoke `synthetic-narrative-plan`.
- Reads PDD, pdd-to-app-journeys, app-deploy summary, connect setup,
  opp.yaml.
- Produces `6-synthetic/synthetic-narrative-plan.md` (human narrative)
  and `6-synthetic/synthetic-narrative-plan.yaml` (the manifest).
- The manifest schema is identical to `synthetic-data-generate`'s; this
  skill just authors a richer instance with named FLWs, deliberate
  anomalies, coaching-arc transcripts.
- **LLM-as-Judge:** `synthetic-narrative-plan-eval` (Stage 4 of Plan B
  — not yet shipped) evaluates whether the manifest is a coherent
  story tied to the PDD.

### Step 2: Data Generate

Invoke `synthetic-data-generate`. Auto-consumes
`synthetic-narrative-plan.yaml` from the run folder when present;
otherwise authors a default 5-FLW manifest.
- Calls labs MCP `synthetic_generate_from_manifest` to mint visits +
  user_data + completed_works + opportunity records.
- Writes `6-synthetic/synthetic-data-generate.md`, populates
  `phases.synthetic-data-and-workflows.outputs.synthetic` block in the
  current run's `run_state.yaml` with `enabled: true`,
  `current_folder_id`, `fixture_record_counts`, `labs_opp_id`. Backward-
  compat: also writes `opp.yaml.synthetic` until cleanup PR e.
- Pre-flight on `connect_list_payment_units`: warns when `count == 0`
  (consequence: completed_works/completed_module zero).
- **LLM-as-Judge:** `synthetic-data-generate-eval` (Stage 4 — not yet
  shipped).

### Step 3: Workflow Seed

Invoke `synthetic-workflow-seed`.
- `workflow_create_from_template` for both SEED templates
  (`llo_weekly_review` + `program_admin_audit`).
- Wires `kpi_config` + `coaching_task_template` via
  `workflow_update_definition`.
- Populates the LLO review's pipeline schema fields from the manifest.
- Spawns synthetic OCS coaching tasks (one per `coaching_arcs[]`
  entry).
- Creates Week 1 + Week 2 workflow runs via `workflow_create_run` and
  saves snapshots via `workflow_save_snapshot` (both atoms shipped
  in connect-labs PR #168, 2026-05-07). The audit workflow reads the
  LLO weekly review's snapshots automatically — no separate
  saved-runs loop needed for the audit.
- **LLM-as-Judge:** `synthetic-workflow-seed-eval` (Stage 4).

### Step 4: Workflow Polish

Invoke `synthetic-workflow-polish`.
- Surgical `workflow_patch_render_code` edits add hero panels, named
  FLW story cards, anomaly callouts, opp-domain branding.
- Falls through to `workflow_update_render_code` (full rewrite) if
  the seed flagged `scaffold_unsuitable: true`.
- Smoke-tests via `pipeline_preview` after patches land.
- **LLM-as-Judge:** `synthetic-workflow-polish-eval` (Stage 4) —
  vision-model judging on rendered screenshots once that infra lands.

### Step 5: Walkthrough Spec

Invoke `synthetic-walkthrough-spec`.
- Reads narrative plan, persona catalog (canned + opp-overlay),
  workflow IDs.
- Emits one `synthetic-walkthrough-spec_<persona>.yaml` per persona,
  consumable by `canopy:walkthrough`.
- Wow-moment scenes reference manifest-seeded anomalies + named FLWs;
  ai_quality assertions are LLM-judge-falsifiable, not vibes.
- **LLM-as-Judge:** `synthetic-walkthrough-spec-eval` (Stage 4).

### Step 6: Walkthrough Run

Invoke `synthetic-walkthrough-run`.
- Pre-flight checks: gstack browse binary present, `ACE_HQ_USERNAME`/
  `PASSWORD` configured, ace-web checkout reachable.
- For each persona spec, dispatches `/canopy:walkthrough <name>`;
  copies the resulting HTML deck + scored screenshots into
  `6-synthetic/walkthroughs/<persona>-<timestamp>/`.
- Appends to `outputs.synthetic.walkthroughs[]` in the current run's `run_state.yaml` (backward-compat also appends to legacy `opp.yaml.synthetic.walkthroughs[]`); re-runs append, not
  overwrite — project history accumulates).
- **No separate eval skill** — `canopy:walkthrough` already scores per
  scene with its Tough Judge rubric.

### Step 7: Summary

Invoke `synthetic-summary`.
- Pure aggregator — reads all Phase 6 artifacts (data-generate
  summary, narrative plan, walkthroughs from `opp.yaml`).
- Emits `6-synthetic/synthetic-summary.md` — one-page reviewer-facing
  output a Dimagi staffer forwards to a stakeholder.
- **No eval skill** — pure aggregation, deterministic.

## Re-runnability

Each skill is independently re-runnable via `/ace:step` without forcing
the whole phase to re-run.

- **Regenerate data** (`/ace:step synthetic-data-generate --opp X`) —
  mints a fresh GDrive folder, flips `SyntheticOpportunity` to point
  at it. Old folder retained labs-side for forensics. Workflows do
  NOT re-run automatically — they consume the live synthetic data via
  labs, so they pick up the new fixtures on next render.
- **Refresh polish only** (`/ace:step synthetic-workflow-polish
  --opp X`) — re-edits render code without touching data. Useful when
  the report quality didn't land.
- **New persona walkthrough** (`/ace:step synthetic-walkthrough-run
  --opp X --persona <name>`) — runs a single persona; the
  `walkthroughs[]` list grows.
- **Full disable** — call `synthetic_disable(opp_int_id)` directly via
  the connect-labs MCP. No skill yet; planned for Stage 4 cleanup work.

## What this phase does NOT do

- **No solicitation handoff.** Phase 7 (solicitation-management) is
  not gated on Phase 6 — solicitation can publish independently.
  Phase 6's output is informational/marketing material, not part of
  the contractual flow.
- **No real OCS sessions.** Coaching conversations are embedded as
  transcript JSON on labs Task records and rendered chat-style by the
  workflow's task drawer. The actual OCS chatbot (Phase 4) is unused
  for synthetic content.
- **No production Connect mutations.** The opp in Connect stays
  exactly as Phase 3 left it. Synthetic mode is labs-only.
- **No automatic recurring regeneration.** Phase 6 fires once during
  the linear `/ace:run`, then re-runs are explicit (`/ace:step ...`).

## Pre-flight checklist

Before Step 1, verify:

- [ ] **`phases.connect-setup.outputs.connect.opportunity` exists** in
  the current run's `run_state.yaml` (Phase 3 ran, or its outputs
  seeded from a prior run via the orchestrator's run-init seed step).
  Falls back to `opp.yaml.connect.opportunity` for opps that pre-date
  state-consolidation PR a. Without an opportunity in Connect, the
  labs MCP has no opp to scope `synthetic_generate_from_manifest`
  against.
- [ ] **`phases.connect-setup.outputs.connect.opportunity.labs_int_id`
  populated** (Stage 4.5 of Plan B; `connect-opp-setup` recovers it
  via `labs_context` post-create, with legacy
  `opp.yaml.connect.opportunity.labs_int_id` as fallback). When null,
  Phase 6 falls back to operator-typed `--opp-int-id`. Re-run
  `connect-opp-setup` if labs hadn't observed the opp at first-create
  time.
- [ ] **`LABS_MCP_TOKEN` set** in `${CLAUDE_PLUGIN_DATA}/.env`.
  Required by every connect-labs MCP call. `bin/ace-doctor` reports
  the labs section.
- [ ] **Labs gdrive parent shared with ACE SA.** The fixture folder
  labs creates needs to be readable by ACE for verification (Step 2's
  defense-in-depth check). One-time admin action, not automated yet.
- [ ] **For Step 6 (walkthrough run):** gstack browse installed at
  `~/.claude/skills/gstack/browse/dist/browse`. Run
  `cd ~/.claude/skills/browse && ./setup` if missing.
- [ ] **`ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD`** in `.env`. Required
  for `bin/ace-labs-walkthrough-login`'s headless OAuth-via-CCHQ
  flow (reuses `mcp/connect/auth/hq-oauth-login.ts`).

## State updates

`run_state.yaml.phases.synthetic-data-and-workflows` accumulates per
step:

```yaml
phases:
  synthetic-data-and-workflows:
    started_at: <ISO>
    completed_at: <ISO>
    status: <pending|in_progress|done|partial>
    steps:
      synthetic-narrative-plan: { status: done, artifacts: {...} }
      synthetic-data-generate:  { status: done, ... }
      synthetic-workflow-seed:  { status: done, ... }
      synthetic-workflow-polish:{ status: done, ... }
      synthetic-walkthrough-spec: { status: done, ... }
      synthetic-walkthrough-run:  { status: done | partial, personas: {...} }
      synthetic-summary:        { status: done, ... }
```

Each step uses `update_yaml_file({..., merge: 'two-level'})` — the
two-level mode (added 0.13.118) recurses one level into object-valued
top-level keys, so each phase's patch leaves sibling phases' blocks
intact while still threading the read+CAS internally. The legacy
read-merge-write pattern via `drive_update_file` is no longer needed
for this case and should not be reintroduced.

`phases.synthetic-data-and-workflows.outputs.synthetic` accumulates
across writers (current run's `run_state.yaml`; inherited from prior
runs via the orchestrator's seed step). Three skills own different
sub-keys, so each does read-modify-write to preserve siblings under
`merge: 'two-level'`:

```yaml
phases:
  synthetic-data-and-workflows:
    outputs:
      synthetic:
        # synthetic-data-generate owns:
        enabled: <bool>
        current_folder_id: <gdrive id>
        current_run_id: <run-id>
        generated_at: <ISO>
        fixture_record_counts: {...}
        labs_opp_id: <int>
        # synthetic-workflow-seed owns:
        workflows:
          llo_weekly_review_id: <int>
          program_admin_audit_id: <int>
        # synthetic-walkthrough-run appends to:
        walkthroughs:
          - persona: prospective-llo
            slideshow_artifact: <Drive ID>
            eval_score: <float>
            run_at: <ISO>
          - persona: funder
            ...
```

Backward-compat: each writer also patches the legacy
`opp.yaml.synthetic` mirror until cleanup PR e.

## Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| `LABS_MCP_TOKEN` unset | Step 2 halt | `op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env` from 1Password. |
| Labs gdrive parent not shared with ACE SA | Step 2 [WARN] | Skill continues; per-file fixture verification skipped. Add `ace-service-account@connect-labs.iam.gserviceaccount.com` as Reader on the labs synthetic Shared Drive. |
| `synthetic_generate_from_manifest` returns INVALID_SCHEMA | Step 2 halt | Edit the manifest (error body written to `_error.md`) and re-invoke `/ace:step synthetic-data-generate`. |
| Connect opp has no payment units | Step 2 [WARN] | `completed_works` / `completed_module` will be 0. Add payment units via `connect-opp-setup` and regenerate, OR accept (visit-based dashboards still work). |
| `workflow_create_run` or `workflow_save_snapshot` returns transport error | Step 3 partial | Capture the labs error in the run summary; re-run `/ace:step synthetic-workflow-seed` after the transient resolves. Note: re-runs create NEW workflow definitions (no idempotency labs-side); use `workflow_delete` to retire stale ones first OR finish the snapshot manually in the labs UI. |
| canopy:walkthrough browser crash | Step 6 partial | Per-persona retry via `/ace:step synthetic-walkthrough-run --persona <name>`. Other personas in the original run are preserved. |
| Operator wants different cast / story | Step 1 review | Edit `synthetic-narrative-plan.yaml` directly in Drive, then re-run from Step 2 onwards. The narrative plan is meant to be operator-tunable. |

## Eval rollup

All Phase 6 evals join `opp-eval` (the umbrella scorecard) and
`cycle-grade` (closeout) per the standard ACE convention. Calibration
of polish-eval's vision-model component lives in Stage 4's
`ace:eval-calibration` extension.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Phase 6 agent — Stage 4a of Plan B. Skill list reflects Stages 1-3 ship state; eval skills declared but not yet implemented. | ACE team (Plan B Stage 4a) |
