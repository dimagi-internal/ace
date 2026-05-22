---
name: cycle-grade
description: >
  Grade the closed CRISPR-Connect cycle end-to-end with concrete
  improvement recommendations for the next cycle.
disable-model-invocation: true
---

# Cycle Grade

Produce a final grade and assessment of the complete CRISPR-Connect cycle.

## Process

1. **Read all opportunity artifacts from GDrive**, including learnings summary, the PDD's `archetype:` field, and the PDD's `## Evidence Model` section. The archetype determines which dimensions and rubric to use (see `## Archetypes` below). The Evidence Model determines what "the work was done" actually means: every Layer A entry should appear as an explicit pass/fail in the FLW Performance grade evidence; Layer B/C entries should appear in the Intervention Effectiveness / Research Quality (focus-group) evidence.

2. **Grade across dimensions:**
   - **Intervention Effectiveness** (0-10) — did the intervention achieve its goals?
   - **App Quality** (0-10) — were the Learn/Deliver apps well-designed and functional?
   - **LLO Execution** (0-10) — did LLOs execute effectively?
   - **FLW Performance** (0-10) — did FLWs deliver quality data/services?
   - **Process Efficiency** (0-10) — how smoothly did the CRISPR-Connect process run?
   - **Communication Quality** (0-10) — was communication with LLOs effective?
   - **Overall Grade** — weighted average with narrative assessment

3. **Self-evaluate (LLM-as-Judge):**
   - Is the grading fair and evidence-based?
   - Are the recommendations actionable?
   - Does the grade accurately reflect the opportunity's outcomes?

4. **Generate recommendations:**
   - Top 3 things that went well (keep doing)
   - Top 3 things to improve (for next cycle)
   - Specific recommendations for each ACE skill that was used

5. **Write final report** to `ACE/<opp-name>/runs/<run-id>/8-closeout/cycle-grade.md`.

5.5. **Write `phases.closeout.products.cycle_grade`** to the current
   run's `run_state.yaml` so downstream readers (ace-web summary in
   particular — the hero status chip flips to "closed" with the actual
   grade letter once this lands) get the headline grade from typed
   state.

   ```yaml
   phases:
     closeout:
       products:
         cycle_grade:
           letter: <e.g. "A" | "A-" | "B+">
           overall_score: <weighted average from Step 2, 0-10>
           headline: <one-sentence narrative summary of the outcome>
           archetype: <atomic-visit | focus-group | multi-stage>
           scorecard_file_id: <Drive fileId of cycle-grade.md>
   ```

   Apply via `mcp__plugin_ace_ace-gdrive__update_yaml_file` with
   `merge: 'two-level'`. Sole writer of `products.cycle_grade`.

6. **Email admin group** with the full cycle grade report.

## Archetypes

The grading dimensions and rubric depend on the PDD's `archetype:` field. The 6 dimensions in step 2 above are the `atomic-visit` defaults. Other archetypes need different dimensions or different rubrics for the same dimensions.

### `atomic-visit`
Use the 6 dimensions as written:
- Intervention Effectiveness, App Quality, LLO Execution, FLW Performance, Process Efficiency, Communication Quality.

**FLW Performance** is graded on submission volume, data quality, cap compliance, and per-FLW outliers. **Intervention Effectiveness** is graded on whether quantitative success metrics from the PDD were met.

### `focus-group`
The same 6 dimensions, but **FLW Performance** and **Intervention Effectiveness** need different rubrics:

- **FLW Performance** is graded on **facilitation quality** — depth of probing, balance across participants, summary specificity, audio completeness, neutral framing — not submission volume. Number of sessions facilitated is a floor (did they hit the planned count), not a quality signal.
- **Intervention Effectiveness** is graded on **research yield** — did the focus groups produce findings that meaningfully informed the next stage or the team's understanding? Are the themes specific, segment-differentiated, and supported by quotes? Did the PDD's research questions get answered? This is a qualitative grade and the LLM-as-Judge should quote actual session content as evidence.

Add a 7th dimension for `focus-group`:
- **Research Quality** (0–10) — Were the session outputs of high enough quality to be the input to a downstream synthesis or decision? Are themes triangulated across segments? Is there visible saturation? Are quotes attributed and verbatim?

### `multi-stage`
Grade each stage's archetype separately, then produce an overall cycle grade that considers the **stage-gate transitions** as well: did Stage 1's findings actually flow into Stage 2 design? Was the stage gate honored or skipped? This is a process-quality signal that doesn't appear in any single stage's grade.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`

## Mode Behavior
- **Auto:** Generate grade, email report, mark opportunity as closed
- **Review:** Present grade for team review and discussion

## Dry-Run Behavior
When `--dry-run` is active:
- Grade report is still generated and written to GDrive as normal
- Write the admin group email (recipients, subject, body with grade report) to `comms-log/dry-run-cycle-grade.md` instead of sending
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-08 | Add `## Archetypes` section: focus-group grading uses facilitation-quality and research-yield rubrics for FLW Performance / Intervention Effectiveness, plus a 7th Research Quality dimension; multi-stage grades stage-gate transitions | ACE team (PM scout, focus-group framework lens) |
| 2026-04-08 | Read PDD `## Evidence Model` in step 1; Layer A drives FLW Performance evidence, Layer B/C drive Intervention Effectiveness / Research Quality evidence | ACE team (PM scout, focus-group framework lens) |
