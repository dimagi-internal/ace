---
name: training-llo-guide
description: >
  Generate the LLO-facing operations document for overseeing FLW
  deployment. Owns one artifact: llo-manager-guide.md.
disable-model-invocation: true
---

# Training LLO Guide

Produce the LLO Manager Guide — operations-flavored, day-to-day-focused,
written for an LLO admin who manages a roster of FLWs. Audience: someone
running the field operation who needs to know morning check-ins, quality
watch, daily caps, escalation triggers, and Connect/payment mechanics.

## When to run

Phase 5 (`qa-and-training`), after `app-screenshot-capture`. Independent
of `training-flw-guide`, `training-faq`, etc. — re-running this skill
rebuilds only `llo-manager-guide.md`.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | opp framing, archetype, target FLW persona, escalation triggers |
| Phase 2 | `ACE/<opp>/runs/<run-id>/2-commcare/pdd-to-learn-app_summary.md` | LLO context on what FLWs are learning |
| Phase 2 | `ACE/<opp>/runs/<run-id>/2-commcare/pdd-to-deliver-app_summary.md` | LLO context on per-visit data shape |
| Phase 2 | `ACE/<opp>/runs/<run-id>/2-commcare/app-deploy_summary.md` | HQ domain quoted in the "where the data lives" section |
| Phase 3 (`run_state.yaml`) | `connect.opportunity` + `connect.payment_units` + `connect.verification_flags` | payment per visit, max-per-day, verification rules |
| Phase 4 | `ACE/<opp>/runs/<run-id>/4-ocs/ocs-setup_widget-handoff.md` (`widget_url`) | "where to ask questions" link |
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/pdd-to-app-journeys.md` | seed the "Pre-deployment UAT" section from per-journey pass criteria |
| Phase 5 Step 1 (`app-screenshot-capture`) | `ACE/<opp>/runs/<run-id>/5-qa-and-training/app-screenshot-capture_manifest.yaml` | optional — embed key screenshots in the "what FLWs see" section |

## Output

Single file: `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-llo-guide.md`.

## Format

Markdown document, structured sections. Audience: an experienced LLO
admin — assume knowledge of how Connect works generally; explain only
opp-specific mechanics. Sections (in order):

```markdown
# LLO Manager Guide — <Opportunity Name>

For LLO operators overseeing FLW deployment of this opportunity.

## What your FLWs are doing
<2-3 sentence paragraph from PDD intervention summary, framed as
"your FLWs are doing X to produce Y outcome">

## Day-to-day responsibilities
- **Morning check-in:** <opp-specific pre-flight items, e.g., MTN
  cards intact, phones charged, etc.>
- **Quality watch:** <what to look for in the first N submissions; pull
  from PDD's Evidence Model § Layer-A>
- **Daily cap enforcement:** <X per FLW per day, Y per <unit>; pulled
  from connect.payment_units max counts>
- **Escalations:** <opp-specific escalation triggers from PDD §
  Escalation, mapped to who handles each>

## Payment mechanics
- FLWs are paid <amount> per <unit>, up to <max> per day, capped at
  <total> total. (from `connect.payment_units`)
- Verification rules (from `connect.verification_flags`):
  <human-readable list — GPS fence radius, photo-required, duplicate
  detection window, etc.>

## Pre-deployment UAT (do this before inviting FLWs)
<derive a checklist from each journey's pass criteria in
`pdd-to-app-journeys.md` — one tickable line per criterion>

## Where the data lives
- HQ domain: <ACE_HQ_DOMAIN from 2-commcare/app-deploy_summary.md>
- Connect opportunity URL: <opportunity URL from connect-setup/opportunity.md>
- Submission audit: <how LLO can review FLW submissions from Connect>

## Where to get help
- The OCS support widget at <widget_url> answers questions about
  this opportunity in particular
- For Connect platform issues: <support contact>
- ACE program team: <ACE_GMAIL_ACCOUNT>
```

## Format rules

- **Operations-tone, not training-tone.** This is for someone running
  the field — assume experienced. The FLW-facing detail belongs in
  `training-flw-guide.md`.
- **Quote real numbers from `run_state.yaml`.** Payment amounts, max
  counts, GPS fence values come from the actual Connect config — don't
  paraphrase or round.
- **Derive the Pre-deployment UAT checklist from per-journey
  `pass_criteria` in `pdd-to-app-journeys.md`.** Every journey's
  pass-criterion line becomes a tickable item. Don't paraphrase —
  paste the criterion verbatim with a leading `- [ ]`.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Read connect state for hard numbers.** Open `run_state.yaml` and pull
   `connect.opportunity.{name, max_visits_per_day, claim_limit_total}`,
   `connect.payment_units[].{unit_name, amount, max_visits_per_day,
   max_total_visits}`, `connect.verification_flags`. These are the
   non-negotiable values that get quoted verbatim in the guide.

3. **Determine archetype.** From PDD frontmatter. For `focus-group`,
   "Quality watch" reframes around session conduct (consent flow,
   debrief notes); for `multi-stage`, add a "Cohort cadence" section
   between Day-to-day and Payment mechanics.

4. **Draft the guide** following the structure above.

5. **Derive UAT checklist from journey pass criteria.** Read
   `ACE/<opp>/runs/<run-id>/1-design/pdd-to-app-journeys.md` and convert each journey's
   `pass_criteria` lines into checkbox items under the
   Pre-deployment UAT section. The LLO ticks through every journey
   before go-live.

6. **Self-check before write.** Verify:
   - Every payment-unit number quoted matches `run_state.yaml` exactly
   - Every escalation trigger from PDD § Escalation is referenced
   - The UAT checklist section has at least 5 line items (real
     checklists do)
   - Word count 500-1200 — operations docs should be scannable

7. **Write** to `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-llo-guide.md`
   via `drive_create_file`. Overwrite if it exists.

8. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Hard-number fidelity:** every payment / cap / GPS-fence number
     matches `run_state.yaml`
   - **Coverage:** every Layer-A verification rule + every PDD
     escalation trigger referenced
   - **Audience fit:** operations-tone, not FLW-walkthrough-tone
   - **UAT completeness:** every journey in `pdd-to-app-journeys.md`
     is represented by at least one checklist item, and each item's
     wording matches the journey's `pass_criteria` (no editorial
     dropping)

   Verdict to `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-llo-guide_verdict.yaml`.

9. **Hand off.** Print Drive URL + verdict summary.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`

## Mode Behavior

- **Auto:** Run end-to-end. Write guide, write verdict.
- **Review:** Pause after step 6, present the drafted guide.
- **Dry-run:** Steps 1-6, skip `drive_create_file`. Verdict with
  `dry_run: true`.

## Products

- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-llo-guide.md`
- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-llo-guide_verdict.yaml`

## Why a separate skill

Same rationale as `training-flw-guide`: independent iteration, eval,
rerun. The LLO guide and FLW guide have very different audiences and
benefit from different prompts and self-eval criteria.

This is the **third of the per-artifact training skills**, after
`training-deck-outline` (0.10.79) and `training-flw-guide` (0.10.83).

## Change Log

- v1 (0.10.84): Initial skill. Owns `llo-manager-guide.md` only.
