---
name: training-llo-guide
description: >
  Generate `llo-manager-guide.md` — the LLO-facing operations document
  for overseeing FLW deployment of this opportunity. Owns one artifact
  only. Third of the per-artifact training skills.
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
| Phase 1 | `ACE/<opp>/pdd.md` | opp framing, archetype, target FLW persona, escalation triggers |
| Phase 2 | `ACE/<opp>/app-summaries/learn-app-summary.md` | LLO context on what FLWs are learning |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | LLO context on per-visit data shape |
| Phase 2 | `ACE/<opp>/deployment-summary.md` | HQ domain quoted in the "where the data lives" section |
| Phase 3 (`state.yaml`) | `connect.opportunity` + `connect.payment_units` + `connect.verification_flags` | payment per visit, max-per-day, verification rules |
| Phase 4 | `ACE/<opp>/ocs-setup/widget-handoff.md` (`widget_url`) | "where to ask questions" link |
| Phase 5 Step 1 (`qa-plan`) | `ACE/<opp>/qa-plan/uat-checklist.md` | embedded as "Pre-deployment UAT" section |
| Phase 5 Step 2 (`app-screenshot-capture`) | `ACE/<opp>/screenshots/manifest.yaml` | optional — embed key screenshots in the "what FLWs see" section |

## Output

Single file: `ACE/<opp>/training-materials/llo-manager-guide.md`.

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
<embed `uat-checklist.md` content verbatim>

## Where the data lives
- HQ domain: <ACE_HQ_DOMAIN from deployment-summary.md>
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
- **Quote real numbers from `state.yaml`.** Payment amounts, max
  counts, GPS fence values come from the actual Connect config — don't
  paraphrase or round.
- **Embed `uat-checklist.md` verbatim** as the Pre-deployment UAT
  section. The LLO needs the same checks the qa-plan judge applies.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Read connect state for hard numbers.** Open `state.yaml` and pull
   `connect.opportunity.{name, max_visits_per_day, claim_limit_total}`,
   `connect.payment_units[].{unit_name, amount, max_visits_per_day,
   max_total_visits}`, `connect.verification_flags`. These are the
   non-negotiable values that get quoted verbatim in the guide.

3. **Determine archetype.** From PDD frontmatter. For `focus-group`,
   "Quality watch" reframes around session conduct (consent flow,
   debrief notes); for `multi-stage`, add a "Cohort cadence" section
   between Day-to-day and Payment mechanics.

4. **Draft the guide** following the structure above.

5. **Embed UAT checklist verbatim.** Read
   `ACE/<opp>/qa-plan/uat-checklist.md` and inline it under the
   Pre-deployment UAT section. Don't summarize — the LLO needs the
   exact list to tick through before go-live.

6. **Self-check before write.** Verify:
   - Every payment-unit number quoted matches `state.yaml` exactly
   - Every escalation trigger from PDD § Escalation is referenced
   - The UAT checklist section has at least 5 line items (real
     checklists do)
   - Word count 500-1200 — operations docs should be scannable

7. **Write** to `ACE/<opp>/training-materials/llo-manager-guide.md`
   via `drive_create_file`. Overwrite if it exists.

8. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Hard-number fidelity:** every payment / cap / GPS-fence number
     matches `state.yaml`
   - **Coverage:** every Layer-A verification rule + every PDD
     escalation trigger referenced
   - **Audience fit:** operations-tone, not FLW-walkthrough-tone
   - **UAT completeness:** the embedded UAT checklist is verbatim
     from `qa-plan` (no editorial dropping of items)

   Verdict to `ACE/<opp>/verdicts/training-llo-guide.yaml`.

9. **Hand off.** Print Drive URL + verdict summary.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`

## Mode Behavior

- **Auto:** Run end-to-end. Write guide, write verdict.
- **Review:** Pause after step 6, present the drafted guide.
- **Dry-run:** Steps 1-6, skip `drive_create_file`. Verdict with
  `dry_run: true`.

## Outputs

- `ACE/<opp>/training-materials/llo-manager-guide.md`
- `ACE/<opp>/verdicts/training-llo-guide.yaml`

## Why a separate skill

Same rationale as `training-flw-guide`: independent iteration, eval,
rerun. The LLO guide and FLW guide have very different audiences and
benefit from different prompts and self-eval criteria.

This is the **third of the per-artifact training skills**, after
`training-deck-outline` (0.10.79) and `training-flw-guide` (0.10.83).

## Change Log

- v1 (0.10.84): Initial skill. Owns `llo-manager-guide.md` only.
