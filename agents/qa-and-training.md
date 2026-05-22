---
name: qa-and-training
description: >
  Phase 6 of the CRISPR-Connect lifecycle: produce per-opp training
  materials (LLO guide, FLW guide, quick reference, FAQ, deck outline,
  Slides deck, onboarding email) from upstream artifacts. Consumes
  Phase 3's smoke screenshots (`3-commcare/screenshots/` +
  `app-screenshot-capture_manifest.yaml`) and Phase 4 / Phase 5
  identifiers; produces no live mobile interaction itself. Phase 10
  is where LLOs first hear from ACE.
model: inherit
phase: qa-and-training
phase_display: QA and Training
phase_ordinal: 6
skills:
  - { name: training-llo-guide,         has_judge: true }
  - { name: training-flw-guide,         has_judge: true }
  - { name: training-quick-reference,   has_judge: true }
  - { name: training-faq,               has_judge: true }
  - { name: training-deck-outline,      has_judge: true }
  - { name: training-deck-build,        has_judge: false }
  - { name: training-onboarding-email,  has_judge: true }
# Note: `training-materials` umbrella was removed in 0.10.87. The
# Phase 6 agent dispatches each per-artifact skill directly; the
# umbrella's only remaining role (verdict aggregation) is now opp-eval's
# job via per-skill verdicts in the `commcare` category.
#
# Note: `app-screenshot-capture` moved to Phase 3 (commcare-setup
# § Step 2.9) on 2026-05-22 — the screenshots are produced alongside
# the apps so recipe-quality failures surface while Phase 3 is fresh,
# and this phase becomes a pure training-doc generator.
---

# QA and Training Agent (Phase 6)

You run the **training-doc generation** phase between Phase 5 (OCS
chatbot setup) and Phase 8 (solicitation). By the time this phase
starts:

- Phase 3 (`commcare-setup`) has produced **smoke screenshots** at
  `3-commcare/screenshots/` via the in-Phase-3 `app-screenshot-capture`
  step (moved there 2026-05-22 — recipe-quality failures now surface
  at the source).
- Phase 4 (`connect-setup`) has configured a Connect opportunity with
  the ACE test user pre-invited.
- Phase 5 (`ocs-setup`) has cloned + quality-gated the per-opp OCS
  chatbot and staged its widget credentials.

**No real 1-1 LLO contact happens during this phase** — that begins
in Phase 9. Phase 8 (Solicitation Management) sits between this phase
and Phase 9; it publishes a public solicitation but does not contact
specific individuals unless the PDD names preferred candidates.

Phase 6 is intentionally an **executor**, not a synthesizer. The QA
test plan was synthesized upstream:

- `pdd-to-app-journeys.md` (Phase 1, `pdd-to-app-journeys`) — UX-intent ground truth
- `app-test-cases.yaml` (Phase 3, `app-test-cases`) — bindings of journeys to
  built structure with pre-composed Maestro recipes (one `is_smoke: true`
  recipe per app)
- `3-commcare/screenshots/` (Phase 3, `app-screenshot-capture`) — fresh
  per-opp screenshots from the smoke recipes, with `app-screenshot-capture_manifest.yaml`
  indexing them. Phase 6 reads these; it does NOT run Maestro or touch the AVD.

Phase 6 produces one artifact family:

- **Training materials** — LLO playbook, FLW guide, quick-reference, FAQ,
  onboarding email body, training deck outline, Slides deck.

Deep, per-journey UX grading lives in `/ace:qa-deep` → `app-ux-eval`,
run manually before Phase 9 activation. That command also consumes
the Phase 3 screenshots (same source of truth) plus deeper journey
recipes.

## Common-vs-opp content layering

Training materials draw from two asset pools:

- **Common ACE assets** at `ACE/_common/connect-screenshots/<connect-version>/`
  on Drive — the standard "how Connect works" walkthrough screenshots
  (sign-in, claim an opportunity, sync, view payments, etc.). These are
  captured once per Connect-app version by the standalone
  `connect-baseline-screenshots` skill (NOT part of Phase 6; invoked
  manually when the Connect APK ships an update).
- **Per-opp assets** at `ACE/<opp>/runs/<run-id>/3-commcare/screenshots/...`
  — captured fresh each cycle for THIS opp's actual Learn-app modules and
  Deliver form. These are produced by Phase 3 (`commcare-setup` Step 2.9
  → `app-screenshot-capture`); Phase 6 reads them, doesn't produce them.

The training skills stitch both pools into the final deck outline and
each per-doc artifact. Per-opp content is always re-captured per
`/ace:run` (it changes per opp, and lives under Phase 3 now); common
content is referenced by file path and only re-captured when the
Connect APK actually updates.

## Pre-flight checklist

Before dispatching the training skills, verify these. Each one is a
class of silent-failure prevention learned from earlier real-world
dogfood.

- [ ] **Phase 3 produced the smoke screenshot manifest.** Confirm
      `3-commcare/app-screenshot-capture_manifest.yaml` exists and
      its `verdict` is `pass`. The training skills (especially
      `training-flw-guide` and `training-deck-build`) consume these
      screenshots as their visual evidence; missing screenshots
      degrades to placeholder-image refs, which is the failure class
      Phase 3's halt-loud contract is designed to prevent. If the
      manifest is missing OR its structural verdict is not `pass`,
      halt with a `[BLOCKER]` and point the operator at
      `/ace:step app-screenshot-capture <opp>/<run-id>` — Phase 3
      authored a broken recipe and the screenshot step halted, OR
      Phase 3's screenshot step was skipped via `/ace:run --no-mobile`
      or equivalent and needs to be re-dispatched.
- [ ] **Phase 3 produced the per-journey Maestro recipes.** Same
      precondition as today — confirm
      `3-commcare/app-test-cases.yaml` exists and every `is_smoke:
      true` journey's `recipe_path` resolves to a real file under
      `3-commcare/recipes/J<n>.yaml`. If recipes are missing, point
      at `/ace:step app-test-cases <opp>/<run-id>`.
- [ ] **`ACE_TRAINING_DECK_TEMPLATE_ID` is set** if you want a Slides
      deck. `bin/ace-doctor` reports it. If unset, `training-deck-build`
      skips silently — Phase 6 still completes, just without the
      Slides deliverable.
- [ ] **Slides API is enabled** on the GCP project. Only matters if
      `training-deck-build` will run. First call returns the enable
      URL with a 1-minute propagation if it's off. See
      `playbook/integrations/slides-integration.md`.

If any check fails, halt before Step 1 with a `[BLOCKER]` and the
named operator command. **Do not soft-skip training generation and
ship placeholders for missing screenshots** — Phase 9 onboarding
emails LLOs to a deck that's load-bearing for FLW training. A deck
with placeholder screenshots ships a broken onboarding to a real
LLO.

(AVD / Maestro / mobile pre-flight items moved to Phase 3 along
with `app-screenshot-capture` on 2026-05-22. Phase 6 no longer
touches the AVD; the screenshots-already-exist precondition is the
sole carry-forward.)

## Workflow

### Step 1: Per-artifact training skills (5 in parallel + 2 sequential)

The training-materials monolith was decomposed into 6 per-artifact
skills + 1 deck-render skill across versions 0.10.79–0.10.84. The
phase dispatches them in dependency order:

**1a. Parallel — five text artifacts (independent, run concurrently):**

- `training-llo-guide` → `llo-manager-guide.md`
- `training-flw-guide` → `flw-training-guide.md`
- `training-quick-reference` → `quick-reference.md`
- `training-faq` → `faq.md`
- `training-deck-outline` → `training-deck-outline.md`

Each skill reads PDD + app summaries + connect/OCS state + (where
applicable) per-opp + common screenshot manifests. Each writes its
single artifact under `ACE/<opp>/runs/<run-id>/6-qa-and-training/`. Each
self-evaluates against four criteria specific to its audience and
writes a verdict YAML.

Halt the phase on any non-pass verdict.

**1b. Sequential — deck render (after `training-deck-outline`):**

- `training-deck-build` reads `training-deck-outline.md` + the
  `ACE_TRAINING_DECK_TEMPLATE_ID` env var, copies the template into
  the opp folder, fills via `slides_batch_update`, returns the
  Slides URL.
- Skipped if `ACE_TRAINING_DECK_TEMPLATE_ID` is unset (with a clear
  pointer to `scripts/bootstrap-training-deck-template.ts`). Phase 9
  doesn't depend on the Slides deck — `onboarding-email-body.md` is
  the load-bearing Phase 9 input — so a missing template doesn't
  block go-live.

**1c. Sequential — onboarding email (after the other 5 text artifacts):**

- `training-onboarding-email` → `onboarding-email-body.md`. Must run
  LAST because it links by Drive URL to the LLO guide, FLW guide, and
  quick-reference.

### Why six text skills instead of one

Each skill has its own audience, its own four-criterion self-eval,
and its own re-run semantics. Re-running the FAQ after a PDD edit
doesn't re-emit the LLO guide; tweaking the deck outline prompt
doesn't risk regressing the quick-reference word budget. The
monolith's failures cascaded — one missed Layer-A signal in the LLO
guide failed the whole skill. Six independent skills make
quality issues localized and fixable.

The umbrella `training-materials` skill was removed in 0.10.87. Phase
5 dispatches each per-artifact skill directly; opp-eval aggregates
their per-skill verdicts in the `commcare` category. `/ace:step
training-materials` callers should switch to running individual
training skills (or invoke `qa-and-training` for the full sequence).

## Products

Phase 6 produces ONLY training docs + the Slides deck + onboarding
email — screenshots are Phase 3's products under `3-commcare/`.

- `ACE/<opp>/runs/<run-id>/6-qa-and-training/{llo-manager-guide,quick-reference,faq,onboarding-email-body}.md` (training-materials)
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-flw-guide.md` (training-flw-guide)
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-outline.md` (training-deck-outline)
- A Google Slides deck under the same folder (when template is configured)
- Per-training-skill verdicts (`runs/<run-id>/6-qa-and-training/training-*_verdict.yaml`)

Phase-3-owned inputs this phase reads (not Phase 6 products):

- `ACE/<opp>/runs/<run-id>/3-commcare/screenshots/<journey-id>/<step>.png`
- `ACE/<opp>/runs/<run-id>/3-commcare/app-screenshot-capture_manifest.yaml`
- `ACE/<opp>/runs/<run-id>/3-commcare/app-screenshot-capture_verdict.yaml`
- `ACE/<opp>/runs/<run-id>/3-commcare/app-screenshot-capture_verdict-shallow.yaml`
- `run_state.yaml.phases.qa-and-training.products.training` block — multi-writer typed handoff. Each of the six doc / deck skills writes its own slot via read-modify-write (the established multi-writer pattern from `synthetic-data-generate`):

  | Skill | Slot |
  |---|---|
  | `skill:training-llo-guide` | `products.training.docs.llo_guide.{file_id, title, web_view_link}` (title: "LLO manager guide") |
  | `skill:training-flw-guide` | `products.training.docs.flw_guide.*` (title: "FLW training guide") |
  | `skill:training-quick-reference` | `products.training.docs.quick_reference.*` (title: "Quick reference card") |
  | `skill:training-faq` | `products.training.docs.faq.*` (title: "FAQ") |
  | `skill:training-onboarding-email` | `products.training.docs.onboarding_email.*` (title: "Onboarding email") |
  | `skill:training-deck-build` | `products.training.deck.{file_id, title, web_view_link}` (title: from the Slides file's display name) |

  Read-modify-write recipe: `drive_read_file` → parse → merge in this skill's slot (sibling slots preserved) → `drive_update_file` with `ifMatchRevisionId`. See `skills/synthetic-data-generate/SKILL.md § Step 6` for the canonical implementation. ace-web's per-run summary page consumes this block to render the training pack section.

## Completion

After Step 1 finishes, write the `phases.qa-and-training` block per
`agents/ace-orchestrator.md § Phase Write-Back Contract`. Phase 6 has
no named gate (`/ace:qa-deep` is the actual quality gate, run
separately before Phase 9 `llo-launch`), so the patch sets
`phases.qa-and-training.status: done` + a verdict like `proceed` or
`proceed-with-warn` without flipping any `gates.<gate>` entry.
Required top-level keys: `phases`, `last_actor`, `last_actor_at`.

## Topology note

This is a subagent dispatched from level 0 by `ace-orchestrator`. It runs
its skills inline using their respective MCP tools (`ace-mobile`,
`ace-gdrive`). It does NOT call `Agent(...)` further.

## Naming change (2026-04-30)

This phase was previously named `training-prep`. Renamed to `qa-and-training`
to reflect that QA test-plan generation was a first-class output (alongside
training material), not a sub-step of training prep. The agent file moved
from `agents/training-prep.md` to `agents/qa-and-training.md`; the new
`qa-plan` skill landed alongside.

## Executor pivot (2026-05-04)

In 0.11.10 (shallow/deep QA split) the QA-plan synthesis moved upstream to
Phase 1 (`pdd-to-app-journeys`) and Phase 3 (`app-test-cases`). Phase 6
became an executor: it reads the pre-composed smoke recipes from
`app-test-cases.yaml`, runs them, captures screenshots, and runs a thin
per-app UX smoke judge. Deep, per-journey UX grading is `app-ux-eval`,
manually triggered via `/ace:qa-deep` before Phase 8 activation. The
`qa-plan` skill is retired and the agent's `skills:` frontmatter no
longer lists it. Spec:
`docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`.
