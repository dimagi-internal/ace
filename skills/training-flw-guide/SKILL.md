---
name: training-flw-guide
description: >
  Generate the FLW-facing step-by-step guide for the Learn and Deliver
  apps. Owns one artifact: flw-training-guide.md.
disable-model-invocation: true
---

# Training FLW Guide

Produce the FLW-facing training document — concrete, screenshot-rich,
step-by-step. Audience: a field worker with no prior context who needs
to know exactly which buttons to tap, in what order, to deliver one
visit successfully.

## When to run

Phase 5 (`qa-and-training`), after `app-screenshot-capture` has uploaded
the per-opp screenshots. Independent of `training-llo-guide`,
`training-faq`, etc. — re-running this skill rebuilds only
`flw-training-guide.md`.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | opp framing, archetype, target FLW persona |
| Phase 2 | `ACE/<opp>/runs/<run-id>/2-commcare/pdd-to-learn-app_summary.md` | Learn modules + assessment threshold |
| Phase 2 | `ACE/<opp>/runs/<run-id>/2-commcare/pdd-to-deliver-app_summary.md` | Deliver form structure (the "what to do here" section) |
| Phase 3 (`run_state.yaml`) | `connect.opportunity` (claim flow), `connect.payment_units` | "what FLWs get paid for" framing |
| Phase 4 | `ACE/<opp>/runs/<run-id>/4-ocs/ocs-setup_widget-handoff.md` (`widget_url`) | "where to get help" section |
| Phase 5 Step 1 (`app-screenshot-capture`) | `ACE/<opp>/runs/<run-id>/5-qa-and-training/app-screenshot-capture_manifest.yaml` + per-opp PNGs | embed step-by-step Learn/Deliver screenshots |
| Common assets | `ACE/_common/connect-screenshots/<v>/manifest.yaml` + PNGs | embed common Connect navigation (sign-in, claim opp, sync, payments) |

## Output

Single file: `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-flw-guide.md`.

## Format

The guide is a markdown document with embedded image references. The
structure is opinionated and written for a high-school-reading-level
audience. Sections (in order):

```markdown
# FLW Training Guide — <Opportunity Name>

For field workers delivering this opportunity.

## What you'll be doing
<2-3 sentences from PDD intervention summary; concrete and outcome-focused>

## Before you start (one-time setup)
1. <step with embedded common-pool screenshot for sign-in>
2. <claim the opportunity — common-pool screenshot>
3. <install the Learn app — common-pool screenshot if available>

## Complete the Learn app
<one section per Learn module, with the per-opp screenshot for each>
- The assessment passing score is <X>%. You can retake it as many times as you need.

## Doing one delivery (the Deliver app)
<one section per Deliver form, walking through every required field
with a screenshot. Includes "what good looks like" guidance pulled
from PDD's Evidence Model.>

## Common pitfalls
<bullet list pulled from PDD stress-test appendix + expected-journeys.md edge cases>

## What you get paid for
<short framing from connect.payment_units in run_state.yaml>

## Where to get help
- The OCS chat widget is available at all times: <widget_url>
- Your LLO manager: <name from connect-setup/opportunity.md>
- For technical issues with the app, contact <support contact from PDD>
```

## Format rules

- **One screenshot per step where possible.** A step with a screenshot
  is far more useful than three steps with no screenshot. If a step
  has no matching screenshot in the manifest, write the step in plain
  text without a placeholder image — never reference a fileId you
  haven't verified exists.
- **Every screenshot ref uses `drive:<fileId>` from the manifest.** No
  guessed IDs, no `[screenshot needed]` markers.
- **Common-pool screenshots come first** (sign-in, claim, sync) — these
  are the Connect navigation surfaces shared across opps. They live
  under `ACE/_common/connect-screenshots/<v>/`.
- **Per-opp screenshots come second** (Learn modules, Deliver form
  walkthrough) — these are unique to this opp and live under
  `ACE/<opp>/runs/<run-id>/5-qa-and-training/screenshots/`.
- **Speaker-style prose, not bullet-list-only.** A working FLW guide
  has narrative connecting the bullets, not just a flat checklist.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Resolve the common-screenshots set.** Read the latest manifest
   under `ACE/_common/connect-screenshots/`. Pick the version directory
   matching the live Connect APK version (from `run_state.yaml`'s
   deployment summary or `ACE_CONNECT_APK_VERSION`); if none matches
   exactly, use the most recent and emit an INFO note in the verdict.

3. **Build the screenshot resolution map.** Two pools merged into one
   `{ alias → drive_file_id }`:
   - Per-opp aliases from `ACE/<opp>/runs/<run-id>/5-qa-and-training/app-screenshot-capture_manifest.yaml` (e.g.,
     `learn-mod-1-step-3`, `deliver-form-photo-step-1`)
   - Common-pool aliases from
     `ACE/_common/connect-screenshots/<v>/manifest.yaml` (e.g.,
     `connect-signin-splash`, `claim-opp-detail`)

   Cross-pool alias collisions: per-opp wins (per-opp is more specific
   to this guide).

4. **Determine archetype.** Read `Archetype:` from PDD frontmatter.
   - `atomic-visit` (default): one Deliver form, one delivery per
     vendor/visit. Section "Doing one delivery" has one form
     walkthrough.
   - `focus-group`: session-based, multiple participants per session.
     Replace the per-vendor walkthrough with per-session-stage
     (consent → group task → debrief).
   - `multi-stage`: hybrid; first-stage and follow-up stages get their
     own subsections.

5. **Draft the guide.** Use the format above. For each Learn module
   and Deliver form, walk through the screenshots referenced in the
   manifest, weaving prose around them. Stay concrete — "Tap GO TO
   CONNECT MENU" beats "navigate to the Connect menu".

6. **Self-check before write.** Verify:
   - Every `drive:<fileId>` ref exists in the resolved map (no
     fabricated IDs)
   - Every Learn module from `learn-app-summary.md` is referenced at
     least once
   - Every required Deliver field is mentioned at least once
   - Word count is 600-1500 — shorter feels skeletal, longer is
     unrealistic for a field worker to absorb

7. **Write** to `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-flw-guide.md`
   via `drive_create_file`. Overwrite if it already exists.

8. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Coverage:** every Learn module + every Deliver form referenced
     by name
   - **Concreteness:** uses real button/field names from the
     app-summaries, not generic "tap the button"
   - **Image hygiene:** zero unresolved screenshot refs, every
     embedded image came from the resolved map
   - **Audience fit:** language a high-school reader can follow; no
     jargon without explanation

   Write a verdict YAML to
   `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-flw-guide_verdict.yaml` in the standard shape
   (see `lib/verdict-schema.ts`). `passed: true` only if all four
   pass.

9. **Hand off.** Print the guide's Drive URL + the verdict summary.
   Phase 5 orchestrator continues with the next training skill.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`

No live AVD or Slides — this skill is pure document generation against
existing per-opp + common-pool artifacts.

## Mode Behavior

- **Auto:** Run end-to-end. Write guide, write verdict.
- **Review:** Pause after step 6 (self-check), present the drafted
  guide, resume on approval.
- **Dry-run:** Steps 1-6 in memory, skip the `drive_create_file`.
  Verdict written with `dry_run: true`.

## Outputs

- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-flw-guide.md`
- `ACE/<opp>/runs/<run-id>/5-qa-and-training/training-flw-guide_verdict.yaml`

## Known limitations

- **Single-language only.** v1 produces English. Multilingual rollouts
  need a separate `training-flw-guide-translate` skill that takes the
  English guide + target locale and produces a translated copy.
- **No images-only sections.** Every section has at least some prose;
  there's no "screenshot wall" mode for FLWs who prefer pure visual
  walkthroughs. Could add a hint syntax (e.g.,
  `<!-- mode: visual-walkthrough -->` in PDD's audience section)
  later if needed.

## Why a separate skill

The original `training-materials` monolith emitted 7 docs in one LLM
call. Splitting per artifact gives:
- **Independent iteration.** Improving the FLW-guide prompt doesn't
  risk regressing the LLO guide.
- **Independent eval.** A failing FLW-guide judge doesn't block the
  LLO guide from shipping.
- **Independent rerun.** Re-running this skill regenerates only the
  FLW guide, not the other 4 artifacts.

This is the **second of the per-artifact training skills**, after
`training-deck-outline`. Planned siblings (next migration cycles):
- `training-llo-guide` — `llo-manager-guide.md`
- `training-quick-reference` — `quick-reference.md`
- `training-faq` — `faq.md`
- `training-onboarding-email` — `onboarding-email-body.md`

## Change Log

- v1 (0.10.83): Initial skill. Owns `flw-training-guide.md` only.
  Common + per-opp screenshot layering. Archetype-aware structure.
- 2026-05-07: Per-opp screenshot path corrected from `ACE/<opp>/screenshots/` to `ACE/<opp>/runs/<run-id>/5-qa-and-training/screenshots/` to match the runs/<run-id>/<phase>/ scheme producers actually use. Doc-only fix; matches what `app-screenshot-capture` writes.
