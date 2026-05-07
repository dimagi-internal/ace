---
name: synthetic-summary
description: >
  Compose a one-page reviewer-facing summary of an opp's synthetic data
  demo — labs URL, fixture folder, narrative — for stakeholder forwarding.
disable-model-invocation: true
---

# Synthetic Summary

Stage 1 sibling of `synthetic-data-generate`. Reads the Phase 6 artifacts in
the run folder and produces a single markdown page a Dimagi staffer can
forward to a stakeholder ("here is what this opportunity looks like running
well"). Pure aggregator — no MCP calls beyond Drive reads/writes, no eval.

In Stage 1 the only Phase 6 inputs are the data-generate summary and its
manifest. Later stages add walkthrough slideshows, workflow URLs, and
narrative-plan output; this skill grows to bundle them then.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 | `6-synthetic/synthetic-data-generate.md` | labs URL, GDrive folder ID, record counts |
| Phase 6 | `6-synthetic/synthetic-data-generate_manifest.yaml` OR `6-synthetic/synthetic-narrative-plan.yaml` | FLW personas, cohort size, anomalies, timeline (for the narrative paragraphs) |
| Phase 6 (optional) | `6-synthetic/synthetic-narrative-plan.md` | richer prose narrative — preferred over the manifest's bare data when present |
| Drive | `ACE/<opp>/opp.yaml` | `display_name`, `slug`, opp-level context, `synthetic.walkthroughs[]` (Stage 2) |

## Outputs

- `6-synthetic/synthetic-summary.md` — one-page reviewer-facing summary
- `run_state.yaml.phases.synthetic-data-and-workflows.synthetic-summary: done`

## Process

1. **Read Phase 6 artifacts.**

   From `ACE/<opp>/runs/<last_run_id>/6-synthetic/`, read via
   `mcp__plugin_ace_ace-gdrive__drive_read_file`:

   - `synthetic-data-generate.md` — labs URL, GDrive folder ID, record
     counts, any warnings
   - The active manifest: prefer `synthetic-narrative-plan.yaml` (Stage 2)
     when present; fall back to `synthetic-data-generate_manifest.yaml`
     (Stage 1).
   - `synthetic-narrative-plan.md` (Stage 2, optional) — its prose seeds
     the "What you'll see" paragraphs more directly than the manifest
     can. Skip if absent.

   If `synthetic-data-generate.md` is absent, halt with: "run
   `/ace:step synthetic-data-generate --opp <slug> --opp-int-id <int>` first
   — this skill aggregates its output."

   Also read `ACE/<opp>/opp.yaml` for `display_name`, `slug`, and the
   `synthetic.walkthroughs[]` list (Stage 2 — empty in Stage 1, populated
   per-persona by `synthetic-walkthrough-run`).

2. **Compose the summary** at
   `ACE/<opp>/runs/<last_run_id>/6-synthetic/synthetic-summary.md`. Shape:

   ```markdown
   # <opp.yaml.display_name> — Synthetic Demo

   **Opp:** `<slug>` · **Fixture run:** `<last_run_id>` · **Generated:** <ISO from opp.yaml.synthetic.generated_at>

   **See it live:** <labs URL from synthetic-data-generate.md> ← clickable

   **Fixture folder (read-only, for review):** <GDrive folder URL from synthetic-data-generate.md>

   ## Demonstrative workflows (Stage 3)

   Render this section ONLY when `opp.yaml.synthetic.workflows.{llo_weekly_review_id, program_admin_audit_id}` are populated. For each:

   - **LLO Weekly Review** — `${LABS_BASE_URL}/labs/workflow/<llo_weekly_review_id>/?opportunity_id=<labs_opp_id>` (clickable)
     - Saved-runs progression (when `synthetic-workflow-seed.md` records `Week 1 run_id` + `Week 2 run_id`): "Week 1 → Week 2 trend visible: <one-line description from the manifest's `coaching_arcs[]` or `anomalies[]`>".
   - **Program Admin Audit** — `${LABS_BASE_URL}/labs/workflow/<program_admin_audit_id>/?opportunity_id=<labs_opp_id>` (clickable)
     - "Reads the LLO Weekly Review's saved runs to render week-over-week LLO process compliance."

   If polish ran (`synthetic-workflow-polish.md` exists), append: "Per-opp visuals applied: <patches_applied count> patches across hero / FLW cards / anomaly callouts / domain branding."

   If polish-eval's verdict scored visual-judge dimensions, append: "Visual-judge: hierarchy=<score>, brand-fit=<score>." Skip if either is null (capture failure).

   When `synthetic.workflows` is empty, omit this section.

   ## What you'll see

   <Paragraph 1 — opp context.>
   One sentence summarizing the opp from the PDD's intervention summary
   (or display_name if PDD not read here). Then one sentence on the
   four-week cadence and total dataset size: "<N> synthetic FLWs delivered
   <M> visits across <K> beneficiaries over <weeks> weeks." Numbers come
   from the manifest's `flw_personas`, `beneficiary_cohorts[].size`,
   `timeline.weeks`, and `record_counts.user_visits`.

   <Paragraph 2 — the cast.>
   Walk the reader through the FLW roster: who's a rockstar, who's
   steady, who's struggling, who's new. Use the manifest's
   `flw_personas[].display_name` and `archetype`. If any persona has
   notes or an `improvement_arc`, mention them. The point is to show
   the data was authored, not random.

   <Paragraph 3 — the story.>
   Describe what a stakeholder will notice in labs. If `anomalies` is
   non-empty, name them ("Dinesh's weight outliers spike in week 3";
   "Esi missed two follow-ups in week 2"). If `kpi_config` has KPIs,
   describe what each measures and the threshold. If both are empty
   (default Stage 1 manifest), be honest: "This is a baseline dataset —
   no anomalies seeded yet. Add them by editing the manifest and
   re-running synthetic-data-generate."

   ## Persona walkthroughs (Stage 2)

   Render this section ONLY when `opp.yaml.synthetic.walkthroughs[]` is
   non-empty. For each entry:

   - **<persona display name>** — `<eval_score>/5` average · captured
     `<run_at>`
     [Open slideshow](<webViewLink of slideshow_artifact>)

   Group by persona; if a persona has multiple runs (re-captures), list
   the most recent first and show older runs collapsed under "Earlier
   captures."

   If `walkthroughs[]` is empty, omit this entire section — don't emit
   "no walkthroughs yet." A stakeholder reading a Stage 1 summary
   shouldn't see promises about Stage 2 deliverables that didn't run.

   ## What's next

   Phase 6 ships in stages — emit only the lines that match THIS opp's state:

   - When `opp.yaml.synthetic.workflows` is empty: "Stage 3 (demonstrative workflows) hasn't run for this opp — `/ace:step synthetic-workflow-seed` instantiates the LLO weekly review + program admin audit."
   - When `synthetic.workflows` exists but `synthetic-workflow-polish.md` is absent: "Stage 3.2 (polish) hasn't run — `/ace:step synthetic-workflow-polish` applies hero panels + named FLW cards + anomaly callouts."
   - When `synthetic.walkthroughs[]` is empty: "Stage 2.6 (persona walkthroughs) hasn't run — `/ace:step synthetic-walkthrough-run` produces stakeholder-ready slideshows. Requires `/ace:labs-login` first."
   - Always: "To regenerate this opp's data with a different manifest, run `/ace:step synthetic-data-generate --opp <slug>`. To fully disable synthetic mode, call `mcp__connect-labs__synthetic_disable(opportunity_id=<int>)`."

   Skip the entire section if all three stage gaps are filled (the demo is complete).
   ```

   Write via `mcp__plugin_ace_ace-gdrive__drive_create_file`. If the file
   already exists (re-run), overwrite via `drive_update_file`.

3. **Update `run_state.yaml`** via `update_yaml_file`:

   ```yaml
   phases:
     synthetic-data-and-workflows:
       synthetic-summary: done
   ```

## MCP Tools Used

- `mcp__plugin_ace_ace-gdrive__drive_read_file`
- `mcp__plugin_ace_ace-gdrive__drive_create_file`
- `mcp__plugin_ace_ace-gdrive__drive_update_file`
- `mcp__plugin_ace_ace-gdrive__update_yaml_file`

## Mode Behavior

Aggregator only — same behavior in auto and review modes. No external
side effects beyond writing the summary file.

## Dry-Run Behavior

`--dry-run` is a no-op pass-through: write the summary as normal (no
external side effects in this skill anyway). State tracks as
`dry-run-success`.

## Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| `synthetic-data-generate.md` missing | step 1 halt | Run `synthetic-data-generate` first. |
| Manifest YAML malformed | step 2 fallback | Skip persona-walk paragraph; emit a `> manifest unparseable — narrative truncated` banner and continue. |
| `opp.yaml.synthetic.generated_at` missing | step 2 fallback | Use file-modified timestamp of `synthetic-data-generate.md` instead. |

## Related skills

- `synthetic-data-generate` — produces the inputs this skill aggregates.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Stage 1 MVP skill — three-paragraph reviewer summary aggregating data-generate output | ACE team (Plan B Stage 1) |
| 2026-05-06 | Stage 2: prefer `synthetic-narrative-plan.{md,yaml}` when present; render Persona Walkthroughs section from `opp.yaml.synthetic.walkthroughs[]`. Section is omitted entirely when empty (Stage 1 summaries unchanged). | ACE team (Plan B Stage 2) |
| 2026-05-07 | Stage 3+: render Demonstrative Workflows section from `opp.yaml.synthetic.workflows.{llo_weekly_review_id, program_admin_audit_id}`; surface saved-runs Week-1/Week-2 trend (Stage 3b) + polish patch count + visual-judge scores (post canopy:visual-judge wire-up). Replace the static "What's next" block with conditional gap-detection so the summary self-describes which stages haven't run for this opp. | ACE team (Plan B Stage 3+) |
