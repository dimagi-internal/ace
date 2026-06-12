---
name: synthetic-workflow-polish
description: >
  Layer per-opp visuals on top of the seeded workflows — hero panel,
  named FLW story cards, anomaly callouts, opp-domain branding cues.
disable-model-invocation: true
---

# Synthetic Workflow Polish

Stage 3.2 of ACE Phase 7 (Plan B). The `synthetic-workflow-seed` skill
instantiates the SEED templates with opp-agnostic render code; this
skill applies surgical edits to make the dashboards look genuinely
tailored to a specific opp's data. The polish step is what moves a
demo from "competent" to "amazing."

Two modes:
- **Surgical patches** (`workflow_patch_render_code`) — preferred. One
  exact-match search/replace per visual element. Safe, reversible, low
  blast radius. Use when the seeded scaffold is broadly suitable.
- **Full rewrite** (`workflow_update_render_code`) — fallback. Used
  when `synthetic-workflow-seed` flagged `scaffold_unsuitable: true`.
  Replaces the entire render_code with bespoke JSX. Higher risk; eval
  must catch any broken-render regressions.

**Preserve the pipeline alias when editing render_code (jjackson/ace#633).**
Whatever the workflow's pipeline reads as — `view.pipelines.<alias>` —
is fixed by the workflow definition's `pipeline_sources[].alias`, not by
you. On an ADAPTed template the alias is the template's (for
`llo_weekly_review` it is **`data`**, NOT `flw_kpis`). A surgical patch
must keep the existing `view.pipelines.<alias>` key verbatim; a full
rewrite must read the alias from the captured `render_code` /
`get_workflow` and use that exact key. Substituting a guessed alias
renders every saved-run view all-zero while passing every patch/update
call — see the seed skill's alias-consistency guardrail.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 7 | `7-synthetic/synthetic-narrative-plan.md` (preferred) or `synthetic-narrative-plan.yaml` | the data story — drives which FLWs to feature, which anomalies to call out |
| Phase 7 | `7-synthetic/synthetic-workflow-seed.md` | workflow IDs + `scaffold_unsuitable` flag |
| Drive | `ACE/<opp>/opp.yaml` | `synthetic.workflows.{llo_weekly_review_id, program_admin_audit_id}`, `synthetic.labs_opp_id` |
| Drive | `inputs/pdd.md` | opp's domain language, branding cues (e.g. "turmeric vendors", "KMC mothers") |
| Operator (CLI, optional) | `--workflow llo\|audit\|both` | scope this run; default `both` |

## Products

- `7-synthetic/synthetic-workflow-polish.md` — run summary (per-workflow patch list, eval flag)
- `run_state.yaml.phases.synthetic-data-and-workflows.synthetic-workflow-polish: done`
- Side effect in labs: render_code on each polished workflow advanced by N versions (one per applied patch)

## Process

1. **Read inputs.** Load the narrative plan, workflow seed summary,
   `opp.yaml`, the current run's `run_state.yaml`, and the PDD via
   `drive_read_file`. Resolve `llo_weekly_review_id` from
   `phases.synthetic-data-and-workflows.products.synthetic.workflows.llo_weekly_review_id`
   in the current run's `run_state.yaml`. Halt if missing: "run
   `synthetic-workflow-seed` first (in this run)."

   Read `scaffold_unsuitable` from the workflow seed summary. Branch:

   - `false` (default) → step 2 (surgical patches)
   - `true` → step 4 (full rewrite)

2. **(Surgical mode) Fetch current render code.**

   For each workflow in the polish scope (LLO weekly + program admin):

   ```
   mcp__connect-labs__workflow_get(
     workflow_id: <id>,
     opportunity_id: <synthetic.labs_opp_id>,
     include_render_code: true,
   )
   ```

   Capture `render_code`, `render_code_version`. The version is
   required by every subsequent `workflow_patch_render_code` call as
   `expected_version`.

3. **(Surgical mode) Compose + apply patches.**

   Polish surface (atomic-visit archetype):

   - **Hero panel.** The seed's `<header><h1>{definition.name}</h1>`
     becomes a richer headline showing the opp's signature metric. For
     turmeric: "850 vendor visits · 92% photo-quality verified · 5
     FLWs across 26 markets". Numbers come from the manifest's
     record counts and KPIs.
   - **Named FLW story cards.** Replace the generic `workers.map(...)`
     row rendering with per-FLW cards that name the FLW (Asha M.,
     Dinesh P.) and surface their archetype label + a one-line note
     from `manifest.flw_personas[].notes`.
   - **Anomaly callouts.** For each entry in `manifest.anomalies`, add
     a "needs attention" badge on the affected FLW's card with the
     anomaly's plain-language description (NOT the field path —
     "photos missing MTN card" beats `form.location_id.photo`).
   - **Coaching arc visualization.** For each
     `manifest.coaching_arcs` entry, add a small inline timeline
     rendering: detection-week → coaching-task → follow-up-week
     improvement number.
     **⚠️ Do NOT assert a per-period delta the snapshot cannot show
     (jjackson/ace#764).** The LLO-review `flw_kpis` rollup is NOT
     period-filtered — Week 1 and Week 2 snapshots render identical
     numbers (labs-side root cause). Static "by Week 3, +18%" text baked
     from `manifest.coaching_arcs` is then a falsified claim: the snapshot
     it renders on shows no such change. Keep any week-referencing /
     improvement-delta narrative **conditional on a genuinely distinct
     per-period figure** being present in the rendered state; if the
     figures are identical across periods, render the coaching arc as a
     forward-looking plan ("coaching assigned; follow-up next cycle")
     rather than asserting a realized improvement. (Mirrors the
     `synthetic-workflow-seed` step-8 warning.)
   - **Domain branding.** Pick icons + language matching the PDD's
     domain. Turmeric → market/vendor language; KMC → maternal-health
     iconography; vaccine focus group → immunization framing.

   For each patch, call:

   ```
   mcp__connect-labs__workflow_patch_render_code(
     workflow_id: <id>,
     opportunity_id: <synthetic.labs_opp_id>,
     search: "<exact substring from current render_code>",
     replace: "<new substring>",
     expected_version: <fetched in step 2; bumps after each successful patch>,
   )
   ```

   Each patch must be a single exact-match replacement; the labs side
   refuses ambiguous patches (count != 1). Bump `expected_version`
   after each successful call.

   **Patch ordering.** Apply outer-shell patches first (hero panel,
   header), then inner-loop patches (per-FLW cards), then leaf
   adornments (anomaly badges). This minimizes search-string drift —
   inner patches don't get invalidated by outer changes.

4. **(L2-rewrite mode) Replace render code wholesale.**

   When `scaffold_unsuitable: true`, the seed's per-FLW-aggregate
   shape doesn't fit the opp's KPI model. Compose a bespoke JSX
   render based on the manifest + PDD, then:

   ```
   mcp__connect-labs__workflow_update_render_code(
     workflow_id: <id>,
     opportunity_id: <synthetic.labs_opp_id>,
     component_code: "<full JSX>",
     expected_version: <from step 2 fetch>,
   )
   ```

   The full-rewrite path is rare — most ACE atomic-visit and
   focus-group archetypes work with the SEED scaffold's per-worker
   shape. Plan B's design § 4.4 calls this "L2 mode."

5. **Smoke render.**

   After applying patches (or wholesale rewrite), verify the workflow
   doesn't crash by calling `pipeline_preview` on its primary
   pipeline:

   ```
   mcp__connect-labs__pipeline_preview(
     pipeline_id: <from workflow_get's response>,
     opportunity_id: <synthetic.labs_opp_id>,
     sample_size: 10,
   )
   ```

   If the preview returns rows, the pipeline is healthy. If it returns
   a schema validation error, the patch broke the render's data
   contract — surface in the run summary as a `[WARN]` and recommend
   the operator open the workflow in labs UI to inspect.

   **Also check for silently-zeroed filtered counts (jjackson/ace#595).**
   The preview returning rows is NOT sufficient. If the schema has `count`
   fields with a `filter_path`/`filter_value` that share a `field_path`
   with a bare `last`/`first`/`list` field, the labs SQL generator
   collapses the shared-path extraction and the filtered counts read **0**
   (not null — so no schema error fires). Inspect the preview: any
   `filter_path` `count` field that is uniformly 0 across rows that have
   data is the smoking gun — remove the colliding bare aggregation on that
   path (see `synthetic-workflow-seed` § Step 4 shared-path guardrail) and
   re-preview before declaring the pipeline healthy.

   We can't yet headlessly screenshot the rendered JSX from this
   skill (would require driving the labs UI through Playwright);
   visual eval lives in `synthetic-workflow-polish-eval` (Stage 4).

6. **Write the run summary** to
   `7-synthetic/synthetic-workflow-polish.md` via `drive_create_file`
   (find-or-update). Body:

   - Per-workflow patches applied: one row per patch with the
     intent label (e.g., "hero panel", "Dinesh story card", "MTN-card
     anomaly badge")
   - Final `render_code_version` per workflow
   - Smoke result: `pipeline_preview` row count or error
   - L2-rewrite flag if step 4 fired

7. **Update `run_state.yaml`** via the read-merge-write pattern:

   ```yaml
   phases:
     synthetic-data-and-workflows:
       steps:
         synthetic-workflow-polish:
           status: done
           mode: <surgical | l2-rewrite>
           patches_applied:
             llo_weekly_review: <int>
             program_admin_audit: <int>
           render_code_versions:
             llo_weekly_review: <int>
             program_admin_audit: <int>
           artifacts:
             summary: <Drive ID>
   ```

## MCP Tools Used

- `mcp__connect-labs__workflow_get`
- `mcp__connect-labs__workflow_patch_render_code` (surgical mode)
- `mcp__connect-labs__workflow_update_render_code` (L2 mode)
- `mcp__connect-labs__pipeline_preview` (smoke test)
- `mcp__plugin_ace_ace-gdrive__drive_read_file`
- `mcp__plugin_ace_ace-gdrive__drive_create_file` (find-or-update)
- `mcp__plugin_ace_ace-gdrive__drive_update_file` (run_state read-merge-write)

## Mode Behavior

- **Default:** apply patches to both workflows in surgical mode (or
  full rewrite if `scaffold_unsuitable: true`).
- **`--workflow llo`** or **`--workflow audit`:** scope to one
  workflow only. Useful when iterating on one deck.
- **`--mode l2-rewrite`:** force L2 even if the seed flagged it
  suitable. For deliberate full-rewrites when the operator wants a
  bespoke JSX experience.

## Dry-Run Behavior

`--dry-run` fetches render code, plans the patch list, writes the run
summary describing what *would* be patched (without calling
`workflow_patch_render_code` / `update_render_code`), and stamps state
as `dry-run-success`.

## Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| Workflow IDs missing in opp.yaml | step 1 halt | Run `synthetic-workflow-seed` first. |
| `workflow_patch_render_code` returns AMBIGUOUS_MATCH | step 3 partial | The search string matched zero or 2+ times. Likely the seed's render_code drifted between fetch and patch (concurrent update?), or the patch is poorly chosen. Re-fetch via `workflow_get` and try a more specific search string. |
| `workflow_patch_render_code` returns VERSION_CONFLICT | step 3 retry-once | Another writer (rare) advanced render_code_version. Re-fetch and retry with the new version. If second conflict fires, halt and surface — the workflow may be under active human edit in labs UI. |
| `pipeline_preview` returns a schema error in step 5 | step 5 [WARN] | A patch broke the pipeline's data contract. Open the workflow in labs UI; if the visual is wrong, roll back via `workflow_patch_render_code` with an inverse patch (or `workflow_update_render_code` to reset to the seed's render_code). |
| Re-run on already-polished workflow | step 2-3 | `workflow_patch_render_code` requires exact-match search, so re-applying the same patches will fail with AMBIGUOUS_MATCH (zero matches because the patch already landed). Treat this as success-no-op; log "already polished" in the run summary. |

## Related skills

- `synthetic-workflow-seed` — produces the workflows + the
  `scaffold_unsuitable` flag this skill consumes.
- `synthetic-narrative-plan` — produces the manifest content (FLW
  names, anomaly descriptions) the patches embed.
- `synthetic-workflow-polish-eval` (Stage 4) — vision-model eval of
  rendered screenshots; runs *after* this skill.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Stage 3a skill — surgical render-code patches with L2-rewrite fallback. | ACE team (Plan B Stage 3) |
