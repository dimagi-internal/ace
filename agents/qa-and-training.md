---
name: qa-and-training
description: >
  Phase 5 of the CRISPR-Connect lifecycle: produce per-opp QA test plan +
  walkthrough screenshots + training materials (deck outline and video
  script). All derived from the design docs (PDD, app summaries, opp
  identifiers, OCS chatbot URL) so the Phase runs from artifacts; no live
  LLO contact. Phase 6 is where LLOs first hear from ACE.
model: inherit
phase: qa-and-training
phase_display: QA and Training
phase_ordinal: 5
skills:
  - { name: qa-plan,                 has_judge: true }
  - { name: app-screenshot-capture,  has_judge: true }
  - { name: training-materials,      has_judge: true }
  - { name: training-flw-guide,      has_judge: true }
  - { name: training-deck-outline,   has_judge: true }
  - { name: training-deck-build,     has_judge: false }
---

# QA and Training Agent (Phase 5)

You run the synthesis phase between OCS chatbot setup and the first LLO contact.
By the time this phase starts, Phases 1-4 have produced an approved PDD,
deployed CommCare apps, a configured Connect opportunity (with the ACE test
user already invited), and a quality-gated OCS chatbot. **No real LLOs hear
from ACE during this phase** — that begins in Phase 6.

This phase produces three artifact families:

1. **A per-opp QA test plan** (matrix of test cases per module, per form,
   per Evidence-Model layer) — drives the walkthrough automation and gives
   the LLO concrete acceptance criteria.
2. **Per-opp screenshots** captured by walking through the live AVD with
   the QA-plan-derived Maestro recipes — used in the training deck/video.
3. **Training materials** — LLO playbook, FLW guide, quick-reference, FAQ,
   onboarding email body, training deck outline, training video script.

## Common-vs-opp content layering

Training materials draw from two asset pools:

- **Common ACE assets** at `ACE/_common/connect-screenshots/<connect-version>/`
  on Drive — the standard "how Connect works" walkthrough screenshots
  (sign-in, claim an opportunity, sync, view payments, etc.). These are
  captured once per Connect-app version by the standalone
  `connect-baseline-screenshots` skill (NOT part of Phase 5; invoked
  manually when the Connect APK ships an update).
- **Per-opp assets** at `ACE/<opp>/screenshots/...` — captured fresh each
  cycle for THIS opp's actual Learn-app modules and Deliver form.

`training-materials` stitches both pools into the final deck outline and
video script. Per-opp content is always re-captured (it changes per opp);
common content is referenced by file path and only re-captured when the
Connect APK actually updates. This keeps Phase 5 runtime predictable and
avoids burning AVD time on screenshots that don't change.

## Workflow

### Step 1: QA Plan
Invoke the `qa-plan` skill.

- **Input:** PDD (Phase 1), test-prompts.md (Phase 1), app summaries
  (Phase 2), deployment-summary.md (Phase 2), connect state (Phase 3),
  ocs-agent-config + widget-handoff (Phase 4)
- **Output:**
  - `ACE/<opp>/qa-plan/test-matrix.md` — per-form test cases (happy path,
    required-field-empty, conditional-skip-logic, boundary values, Layer-A
    verification rules, Layer-B coherence checks)
  - `ACE/<opp>/qa-plan/walkthrough-recipes/{learn,deliver}/module-N.yaml`
    — per-module Maestro recipes generated via
    `mobile_generate_recipe_for_module`
  - `ACE/<opp>/qa-plan/screenshot-manifest.yaml` — what each step should
    capture, ordered for the training deck
  - `ACE/<opp>/qa-plan/uat-checklist.md` — LLO-facing acceptance criteria
    derived from the PDD's Evidence Model
- **LLM-as-Judge:** verify the matrix has full coverage of the PDD's
  Evidence Model (every Layer-A required field has at least one test;
  every conditional skip-logic branch has at least one test) and that the
  generated recipes have the correct module-level navigation skeleton.

### Step 2: App Screenshot Capture
Invoke the `app-screenshot-capture` skill.

- **Input:** `qa-plan/walkthrough-recipes/...` + `qa-plan/screenshot-manifest.yaml`
- **Output:** per-step PNGs in `ACE/<opp>/screenshots/<recipe>/<step>.png`
  + `ACE/<opp>/screenshots/manifest.yaml` (linking each PNG back to its
  test case)
- **LLM-as-Judge:** verify recipe execution status, screenshot integrity,
  manifest correctness against the qa-plan manifest
- Halts the phase on non-pass verdict — Phase 6 must not start without
  the per-opp screenshots

### Step 3: Training Materials (LLO + supplementary text)
Invoke the `training-materials` skill.

- **Input:** PDD + qa-plan + app summaries + connect state + ocs config
  + per-opp screenshots from Step 2 + common screenshots from
  `ACE/_common/connect-screenshots/<connect-version>/`
- **Output:**
  - `ACE/<opp>/training-materials/llo-manager-guide.md`
  - `ACE/<opp>/training-materials/quick-reference.md`
  - `ACE/<opp>/training-materials/faq.md`
  - `ACE/<opp>/training-materials/onboarding-email-body.md` (Phase 6 input)

  Per-artifact split is in progress: `training-deck-outline.md` moved to
  `training-deck-outline` (0.10.79); `flw-training-guide.md` moved to
  `training-flw-guide` (0.10.83). The remaining 4 artifacts will move in
  subsequent migration cycles.
- **LLM-as-Judge:** verify content matches app structure, common +
  opp-specific screenshots embedded correctly, real URLs resolved
- Halts the phase on non-pass verdict

### Step 4: Training FLW Guide
Invoke the `training-flw-guide` skill.

- **Input:** PDD + Learn/Deliver app summaries + connect state + ocs
  widget URL + per-opp screenshot manifest + common Connect screenshot
  manifest
- **Output:** `ACE/<opp>/training-materials/flw-training-guide.md` —
  step-by-step FLW-facing walkthrough with embedded screenshots
- **LLM-as-Judge:** coverage (every Learn module + Deliver form
  referenced), concreteness (real button/field names), image hygiene
  (no fabricated fileIds), audience fit (high-school reading level)
- Halts the phase on non-pass verdict

### Step 5: Training Deck Outline
Invoke the `training-deck-outline` skill.

- **Input:** PDD + app summaries + per-opp screenshot manifest +
  common screenshot manifest + (optional) `flw-training-guide.md`
  for caption phrasing alignment
- **Output:** `ACE/<opp>/training-materials/training-deck-outline.md`
  — slide-by-slide markdown matching `parseDeckOutline` contract in
  `lib/training-deck-spec.ts`
- **LLM-as-Judge:** coverage (every Learn module + Deliver form
  referenced), concreteness (speaker notes opp-specific not boilerplate),
  image hygiene (zero unresolved screenshot refs), length (8-15 slides)
- Halts the phase on non-pass verdict — Step 5 needs a valid outline

### Step 6: Training Deck Build
Invoke the `training-deck-build` skill.

- **Input:** `training-deck-outline.md` + `ACE_TRAINING_DECK_TEMPLATE_ID`
  env var (set once via `scripts/bootstrap-training-deck-template.ts`)
- **Output:** A real Google Slides deck in
  `ACE/<opp>/training-materials/`, plus a `training_deck:` block in
  `state.yaml` with the deck URL
- **No LLM-as-Judge** — this is a deterministic render; the upstream
  outline judge already gated content quality
- Skipped if `ACE_TRAINING_DECK_TEMPLATE_ID` is empty (with a clear
  pointer to the bootstrap script). Phase 6 doesn't depend on the
  Slides deck — onboarding-email-body is the load-bearing Phase 6
  input — so a missing template doesn't block go-live.

## Outputs

- `ACE/<opp>/qa-plan/test-matrix.md`
- `ACE/<opp>/qa-plan/walkthrough-recipes/{learn,deliver}/module-N.yaml`
- `ACE/<opp>/qa-plan/screenshot-manifest.yaml`
- `ACE/<opp>/qa-plan/uat-checklist.md`
- `ACE/<opp>/screenshots/<recipe>/<step>.png` + `ACE/<opp>/screenshots/manifest.yaml`
- `ACE/<opp>/training-materials/{llo-manager-guide,quick-reference,faq,onboarding-email-body}.md` (training-materials)
- `ACE/<opp>/training-materials/flw-training-guide.md` (training-flw-guide)
- `ACE/<opp>/training-materials/training-deck-outline.md` (training-deck-outline)
- A Google Slides deck under the same folder (when template is configured)
- `verdicts/qa-plan.yaml`
- `verdicts/app-screenshot-capture.yaml`
- `verdicts/training-materials.yaml`

## Topology note

This is a subagent dispatched from level 0 by `ace-orchestrator`. It runs
all three skills inline using their respective MCP tools (`ace-mobile`,
`ace-gdrive`). It does NOT call `Agent(...)` further.

## Naming change (2026-04-30)

This phase was previously named `training-prep`. Renamed to `qa-and-training`
to reflect that QA test-plan generation is a first-class output (alongside
training material), not a sub-step of training prep. The agent file moved
from `agents/training-prep.md` to `agents/qa-and-training.md`; the new
`qa-plan` skill landed alongside.
