---
name: training-materials
description: >
  Generate training materials for LLOs and FLWs from app summaries and
  template collateral. Output guides, quick-reference cards, and onboarding docs.
---

# Training Materials

Generate training materials from the app summaries and standard templates.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/pdd.md` | overall framing, opp goals, archetype |
| Phase 1 | `ACE/<opp>/test-prompts.md` | seed FAQ entries |
| Phase 2 | `ACE/<opp>/app-summaries/learn-app-summary.md` | content + form names in FLW guide |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | content + form names in FLW guide |
| Phase 2 | `ACE/<opp>/deployment-summary.md` | HQ domain quoted in LLO Manager Guide |
| Phase 3 (state.yaml) | `connect.opportunity` + `connect.payment_units` + `connect.finalize` | payment + verification details in LLO Manager Guide |
| Phase 4 | `ACE/<opp>/ocs-agent-config.md` + `widget-handoff.md` (`widget_url`) | "where to ask questions" link in FLW Training Guide, Quick Reference, and onboarding-email body |
| Phase 5 Step 1 (qa-plan) | `ACE/<opp>/qa-plan/test-matrix.md` + `uat-checklist.md` | UAT-acceptance section of LLO Manager Guide; FAQ entries |
| Phase 5 Step 2 (this phase) | `ACE/<opp>/screenshots/manifest.yaml` + per-opp PNGs | embed per-opp step-by-step screenshots in FLW Training Guide + training deck/video |
| **Common assets** | `ACE/_common/connect-screenshots/<connect-version>/manifest.yaml` + the PNGs it points to | embed common Connect-navigation screenshots (sign-in, claim opp, sync, payments) — sourced from the standalone `connect-baseline-screenshots` skill |

## Process

1. **Read inputs from GDrive** as listed above. Template collateral from `templates/` directory (if available).

2. **Resolve the common-screenshots set.** Read the latest manifest under
   `ACE/_common/connect-screenshots/`. Pick the version directory that
   matches the live Connect APK version (from
   `state.yaml`'s deployment summary or `ACE_CONNECT_APK_VERSION` env);
   if none matches exactly, pick the most recent one and emit an INFO
   note in the verdict. This pool covers the standard Connect navigation
   surfaces (sign-in, claim opp, sync, payments) — not opp-specific.

3. **Generate training materials:**
   - **LLO Manager Guide** — overview of the opportunity, what LLOs need to do,
     timeline, expectations, escalation contacts. Embeds qa-plan's
     `uat-checklist.md` as the "Pre-deployment UAT" section.
   - **FLW Training Guide** — step-by-step instructions for using the Learn
     and Deliver apps, with screenshots of each form. Layers common Connect
     screenshots (sign-in, claim, sync) at the front; opp-specific
     screenshots (Learn-app modules + Deliver form) in the middle.
   - **Quick Reference Card** — one-page summary of key workflows, common
     issues, OCS support widget URL.
   - **FAQ** — anticipated questions from LLOs and FLWs. Seeded from
     `test-prompts.md` and qa-plan's `test-matrix.md` edge cases.
   - **Onboarding Email Body** — the email body Phase 6 `llo-onboarding`
     personalizes per LLO. Embeds the OCS widget URL.

   **NOT produced here (moved to dedicated per-artifact skills as of 0.10.79):**
   - `training-deck-outline.md` — owned by the `training-deck-outline` skill
   - `training-video-script.md` — planned, not yet implemented (will land
     as a `training-video-script` skill paired with a future video-build skill)

   See § "Per-artifact split (in progress)" below for the migration roadmap.

4. **Embed step-by-step screenshots** in `flw-training-guide.md`. For each
   relevant entry in either screenshot manifest, render the screenshot
   inline with its step label and a 1–2 sentence caption.
   - Common-pool entries are referenced by their `_common/...` Drive path
   - Per-opp entries are referenced by their `ACE/<opp>/screenshots/...`
     Drive path
   - Both use the same markdown image syntax — the layered approach is
     transparent to the final renderer.

4. **Self-evaluate (LLM-as-Judge):**
   - Are instructions clear enough for someone with no prior context?
   - Do the materials match the actual app structure?
   - Are all key workflows covered?
   - Is the language appropriate for the target audience?

5. **Write to GDrive:** `ACE/<opp-name>/training-materials/`
   - `llo-manager-guide.md`
   - `flw-training-guide.md`
   - `quick-reference.md`
   - `faq.md`
   - `onboarding-email-body.md` — Phase 6 `llo-onboarding` consumes this

   `training-deck-outline.md` is produced by the sibling
   `training-deck-outline` skill (and rendered to a real Slides deck by
   `training-deck-build`). Don't write it here.

6. **Write verdict** to `ACE/<opp-name>/verdicts/training-materials.yaml`. The shape MUST conform to `lib/verdict-schema.ts` so `opp-eval` can aggregate.

   ```yaml
   skill: training-materials
   target: <opp-name>
   ran_at: <ISO timestamp>
   capture_path: training-materials/

   overall_score: 8.5
   verdict: pass | warn | fail | incomplete

   dimensions:
     content_matches_app_structure: { score: 9.0, weight: 0.25 }
     screenshots_embedded:          { score: 8.0, weight: 0.20 }
     real_urls_resolved:            { score: 10.0, weight: 0.15 }
     audience_calibration:          { score: 9.0, weight: 0.20 }
     pdd_fidelity:                  { score: 9.0, weight: 0.20 }

   per_item:
     - ref: "llo-manager-guide.md"
       score: 9.0
       verdict: pass
       note: "Operations-oriented, escalation paths covered"
     # ... one per produced doc

   auto_surfaced:
     - severity: WARN
       message: "Screenshots not embedded — capture blocked. See verdicts/app-screenshot-capture.yaml."
   ```

   When screenshots are pending (the `app-screenshot-capture` verdict
   came back `incomplete`), keep the `screenshots_embedded` dimension
   weighted but score it ≤ 5.0 and emit a `[WARN]` `auto_surfaced`
   entry pointing at the upstream block. Do not set the verdict to
   `incomplete` solely on screenshots — content fidelity is the
   primary thing this skill grades.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`

## Mode Behavior
- **Auto:** Generate materials, notify admin group, proceed
- **Review:** Present materials for review before distributing to LLOs

## Per-artifact split (in progress)

This skill is being decomposed into one skill per training artifact so
each can be iterated, evaluated, and re-run independently. As of 0.10.79
the deck outline has moved out:

| Artifact | Owner skill | Status |
|---|---|---|
| `llo-manager-guide.md` | `training-materials` | still here |
| `flw-training-guide.md` | `training-materials` | still here |
| `quick-reference.md` | `training-materials` | still here |
| `faq.md` | `training-materials` | still here |
| `onboarding-email-body.md` | `training-materials` | still here |
| `training-deck-outline.md` | `training-deck-outline` | **moved out (0.10.79)** |
| training-deck.pptx → Google Slides | `training-deck-build` | new (0.10.78) |
| `training-video-script.md` | (planned `training-video-script` skill) | not yet implemented |

The five remaining artifacts will each get a dedicated
`training-<artifact>` skill in a future migration cycle. After that,
this skill becomes a thin umbrella (or is removed and the Phase 5
orchestrator dispatches the children directly).

Don't add new artifacts to this skill — create a sibling
`training-<x>` skill instead.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-28 | Move skill from Phase 2 (commcare-setup) to Phase 5 (qa-and-training). Add upstream-input contract: read connect-state.yaml, ocs-state.yaml, screenshots/manifest.yaml. Embed real screenshots in flw-training-guide. | ACE team (mobile-emulation) |
| 2026-04-30 | Phase 5 restructure (0.10.44): consume `qa-plan` (test-matrix + uat-checklist) for UAT section + FAQ seeding. Add **common-vs-opp screenshot layering**: read `ACE/_common/connect-screenshots/<connect-version>/manifest.yaml` for standard Connect navigation (sourced by the standalone `connect-baseline-screenshots` skill); per-opp screenshots remain at `ACE/<opp>/screenshots/`. Add two new outputs: `training-deck-outline.md` (slide-by-slide with screenshot refs) and `training-video-script.md` (narration + screen-cue timing). | ACE team |
| 2026-05-02 | Per-artifact split begins (0.10.79): move `training-deck-outline.md` to its own `training-deck-outline` skill. `training-video-script.md` removed (will get its own skill later). Other 5 artifacts stay here pending the rest of the migration. | ACE team |
