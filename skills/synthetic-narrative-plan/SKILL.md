---
name: synthetic-narrative-plan
description: >
  LLM-author a richer synthetic-data manifest (named FLWs, deliberate
  anomalies, coaching arcs, week-over-week story) from upstream design docs.
disable-model-invocation: true
---

# Synthetic Narrative Plan

Stage 2 of ACE Phase 6 (Plan B). Where Stage 1's `synthetic-data-generate`
ships a clean baseline manifest (5 default FLWs, no anomalies, no coaching
arcs), this skill authors a *richer* manifest tuned to the specific opp's
intervention design — named FLWs with archetype-appropriate notes, deliberate
anomaly events, and coaching-arc transcripts that make the demo tell a story
a stakeholder can follow.

The output is the same manifest schema `synthetic-data-generate` already
consumes; this skill simply produces a more interesting version of it. When
this skill runs first, `synthetic-data-generate` consumes
`synthetic-narrative-plan.yaml` automatically (no `--manifest` flag needed).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `inputs/pdd.md` | intervention design, archetype, success metrics, evidence model |
| Phase 1 | `runs/<run-id>/1-design/expected-journeys.md` | FLW journey shape, edge cases worth seeding as anomalies |
| Phase 2 | `runs/<run-id>/2-commcare/app-deploy_summary.md` | deliver-app form structure (field paths, types) |
| Phase 2 (optional) | `runs/<run-id>/2-commcare/app-test-cases.yaml` | test-case anomalies that double as plausible field anomalies |
| Phase 3 | `runs/<run-id>/3-connect/connect-opp-setup.md` | payment units, deliver units, verification flags |
| Drive | `ACE/<opp>/opp.yaml` | `display_name`, slug, last_run_id, organization_slug |
| Operator (CLI, optional) | `--seed-prompt FILE\|-` | free-text steering ("emphasize fraud detection," "feature Asha as the rockstar") |

## Outputs

- `6-synthetic/synthetic-narrative-plan.md` — human-readable narrative explaining the data story
- `6-synthetic/synthetic-narrative-plan.yaml` — the manifest (schema identical to `synthetic-data-generate_manifest.yaml`)
- `run_state.yaml.phases.synthetic-data-and-workflows.synthetic-narrative-plan: done`

## Process

1. **Read inputs.** Load each artifact in the table above via
   `mcp__plugin_ace_ace-gdrive__drive_read_file`. Track which were
   present vs missing.

   **Required:** PDD + opp.yaml. If either is missing, halt with a clear
   error pointing the operator at the missing file.

   **Recommended:** expected-journeys, app-deploy summary, connect-opp-setup.
   If any are missing, degrade gracefully — note the gap in the narrative
   ("FLW journey detail not available; manifest uses generic atomic-visit
   shape") and continue. Don't halt.

2. **Determine archetype + intervention shape.**

   Read `archetype:` from the PDD frontmatter. Branch:

   - **`atomic-visit`** (default) — manifest's FLW personas have
     accuracy/completeness/flag-rate distributions; anomalies are
     field-outlier or missed-visit type.
   - **`focus-group`** — manifest's FLW personas have facilitation-quality
     distributions; anomalies are session-quality or audio-quality type.
     (Stage 2 handles atomic-visit; focus-group support extends in
     subsequent stages.)
   - **`multi-stage`** — pick the live stage's archetype and treat it as
     the manifest's primary mode; cross-stage anomalies are out of scope.

3. **Draft FLW personas.** Replace the 5-default cast (`asha`, `bao`,
   `carla`, `dinesh`, `esi`) with named FLWs whose names and notes reflect
   the program's geography and language context (read the PDD's Target
   Population section).

   Required mix per opp (atomic-visit):
   - 1 `rockstar` — names + a one-line note ("mentors peers," "fastest
     close-out time," "highest verification pass rate")
   - 2 `steady` — typical mid-tier; names + a short note each
   - 1 `struggling` — names + an `improvement_arc` block with
     `intervention_week` + `post_intervention_lift`
   - 1 `new_hire` — names + a one-line note ("ramping in, joined Week 2")

4. **Seed anomalies.** Draft 2–4 anomalies that produce specific,
   reviewer-visible signals downstream:

   - **field_outlier** — pick a measurement field path from the deliver
     app (e.g., `form.product_grp.price`, `form.weight_kg`); the
     struggling FLW exhibits week-N outliers on this field
   - **missing_visits** — one FLW (steady or new_hire) skips week M's
     follow-ups; surfaces in coverage / completeness charts
   - **photo_quality_drop** (atomic-visit only) — when the deliver app
     has a `photo` field, one FLW's photos start failing Layer B AI
     check in week K (used by Layer-B-AI verification flag if Phase 3
     enabled it)
   - **fraud_signal** (optional) — duplicate-vendor / GPS-cluster
     pattern that flags one FLW for review

   Anomalies must reference real field paths from the deliver app
   summary; never invent paths.

5. **Compose coaching arcs.** For each `improvement_arc` FLW (typically
   the 1 `struggling` persona), draft a `coaching_arcs` entry:

   - `flw_id`, `week_triggered` (matches the anomaly week), `persona`
     (`supportive_coach` is the default), `target_behavior` (concrete:
     "improve price-per-unit measurement accuracy", not "do better")
   - `transcript` — 4–8 turn embedded chat with `role` (`bot` / `flw`)
     + `text` + `ts` (ISO at sensible cadence — bot opens, FLW responds
     within minutes/hours, follow-ups within a day or two)
   - `follow_up_outcome_week` — week the lift kicks in (matches the
     improvement_arc's intervention_week + post_intervention_lift)

   The transcript should sound like a real coach. Avoid:
   - Generic encouragement ("Great job!" with no specifics)
   - Patronizing tone — match the FLW's apparent literacy + experience
   - Fixing-it-for-them — coach asks questions, FLW arrives at the
     correction

6. **Pick the KPI set.** Read the PDD's Success Metrics section. Translate
   each metric into one `kpi_config` entry — `kpi`, `field_path`,
   `aggregation`, `threshold_underperform`, `threshold_target`. 2–4 KPIs
   total; more is noise for a Stage-2 demo.

   Default `aggregation` rules:
   - Numeric measurement field → `validated_rate` (compares against
     verification flags) or `mean_within_range`
   - Required text/select field → `non_null_rate`
   - Visit-count metric → `count` with thresholds in absolute integers

7. **Set the timeline.** 4 to 8 weeks (default 4 for stakeholder demos —
   enough to show week-over-week deltas without making the deck too long).
   `start_date` is `today − weeks*7`. Random seed: today's date as
   `YYYYMMDD` integer for determinism across re-runs.

8. **Write the manifest** as `6-synthetic/synthetic-narrative-plan.yaml`
   via `mcp__plugin_ace_ace-gdrive__drive_create_file` (find-or-update —
   re-runs overwrite).

   Schema is identical to Stage 1's `synthetic-data-generate_manifest.yaml`
   (see `synthetic-data-generate/SKILL.md` step 2 for the full shape).
   This skill just authors a richer instance.

9. **Write the narrative companion** as
   `6-synthetic/synthetic-narrative-plan.md` — a 1–2 page reviewer-facing
   doc that explains the data story to a human:

   - **Opening (2–3 sentences):** What this opp is about, what the demo
     should leave a stakeholder with.
   - **The cast:** named FLWs, archetype labels, one line of personality
     each. Why they were chosen (e.g., "Dinesh shows the
     anomaly→coaching→improvement loop").
   - **The story arc:** week-by-week — what's the visible trend? When do
     anomalies surface? When does the coaching arc resolve?
   - **What stakeholders should notice:** 3–5 specific things a viewer
     should leave knowing (e.g., "the rockstar mentored 2 peers in week
     3; flagged FLW improved 15% post-coaching in week 7").

   This doc seeds the persona walkthrough specs in
   `synthetic-walkthrough-spec` — the "wow moments" downstream skills
   target should appear here first.

10. **Update `run_state.yaml`** via the read-merge-write pattern (NOT
    `update_yaml_file` — same caveat as `synthetic-data-generate` step 6;
    shallow-merge would clobber sibling phases):

    ```yaml
    phases:
      synthetic-data-and-workflows:
        steps:
          synthetic-narrative-plan:
            status: done
            artifacts:
              narrative: <Drive ID of .md>
              manifest: <Drive ID of .yaml>
            anomaly_count: <int>
            coaching_arc_count: <int>
            kpi_count: <int>
    ```

## MCP Tools Used

- `mcp__plugin_ace_ace-gdrive__drive_read_file`
- `mcp__plugin_ace_ace-gdrive__drive_create_file` (find-or-update default)
- `mcp__plugin_ace_ace-gdrive__drive_update_file` (run_state read-merge-write)

## Mode Behavior

- **Default:** Author the narrative + manifest, surface to operator for
  review, no auto-pause. Operator can edit either file in Drive directly
  before running `synthetic-data-generate`.
- **`--seed-prompt FILE|-`:** read free-text steering from the file or
  stdin and treat it as additional priors when authoring (e.g.,
  "emphasize fraud detection over performance variance").

## Dry-Run Behavior

`--dry-run` writes both files normally (no external side effects in this
skill); state tracks as `dry-run-success`.

## Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| PDD or opp.yaml missing | step 1 halt | Run Phase 1 first or check the run folder structure. |
| `archetype:` unrecognized | step 2 halt | Edit PDD to declare a valid archetype, re-run. |
| Deliver-app summary unavailable | step 1 warn | Use generic field paths; mark anomalies as `field_path: TBD` and warn the operator that anomalies will need editing before generation. |
| Operator wants different cast / story | step 8 review | Edit `synthetic-narrative-plan.yaml` directly in Drive before running `synthetic-data-generate`; this skill is re-runnable any time. |

## Related skills

- `synthetic-data-generate` — consumes this skill's `.yaml` output as the
  default manifest source if present in the run folder.
- `synthetic-walkthrough-spec` — Stage 2 sibling that turns this skill's
  narrative + manifest into per-persona walkthrough specs.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Stage 2 skill — LLM-authored manifest + narrative companion | ACE team (Plan B Stage 2) |
