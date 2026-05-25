---
name: qa-and-training
description: >
  Phase 6 of the CRISPR-Connect lifecycle: produce per-opp QA test plan +
  walkthrough screenshots + training materials (deck outline and video
  script). All derived from the design docs (PDD, app summaries, opp
  identifiers, OCS chatbot URL) so the Phase runs from artifacts; no live
  LLO contact. Phase 9 is where LLOs first hear from ACE.
model: inherit
phase: qa-and-training
phase_display: QA and Training
phase_ordinal: 6
skills:
  - { name: app-screenshot-capture,     has_judge: true }
  - { name: training-llo-guide,         has_judge: true }
  - { name: training-flw-guide,         has_judge: true }
  - { name: training-quick-reference,   has_judge: true }
  - { name: training-faq,               has_judge: true }
  - { name: training-deck-generate,      has_judge: true }
  - { name: training-deck-render,       has_judge: false }
  - { name: training-onboarding-email,  has_judge: true }
# Note: `training-materials` umbrella was removed in 0.10.87. The
# Phase 6 agent dispatches each per-artifact skill directly; the
# umbrella's only remaining role (verdict aggregation) is now opp-eval's
# job via per-skill verdicts in the `commcare` category.
---

# QA and Training Agent (Phase 6)

You run the executor phase between OCS chatbot setup and the first LLO
contact. By the time this phase starts, Phases 1-4 have produced an
approved PDD, deployed CommCare apps, a configured Connect opportunity
(with the ACE test user already invited), and a quality-gated OCS chatbot.
**No real 1-1 LLO contact happens during this phase** — that begins in
Phase 9. Phase 8 (Solicitation Management) sits between this phase and
Phase 9; it publishes a public solicitation but does not contact specific
individuals unless the PDD names preferred candidates.

Phase 6 is intentionally an **executor**, not a synthesizer. The QA test
plan was synthesized upstream:

- `pdd-to-app-journeys.md` (Phase 1, `pdd-to-app-journeys`) — UX-intent ground truth
- `app-test-cases.yaml` (Phase 3, `app-test-cases`) — bindings of journeys to
  built structure with pre-composed Maestro recipes (one `is_smoke: true`
  recipe per app)

Phase 6 produces two artifact families:

1. **Per-opp screenshots** from running the smoke recipes — used in the
   training deck and a thin per-app UX smoke judge (~2 LLM calls total).
   Deep, per-journey UX grading lives in `/ace:qa-deep` →
   `app-ux-eval`, run manually before Phase 8 activation.
2. **Training materials** — LLO playbook, FLW guide, quick-reference, FAQ,
   onboarding email body, training deck spec, training video script.

## Common-vs-opp content layering

Training materials draw from two asset pools:

- **Common ACE assets** at `ACE/_common/connect-screenshots/<connect-version>/`
  on Drive — the standard "how Connect works" walkthrough screenshots
  (sign-in, claim an opportunity, sync, view payments, etc.). These are
  captured once per Connect-app version by the standalone
  `connect-baseline-screenshots` skill (NOT part of Phase 6; invoked
  manually when the Connect APK ships an update).
- **Per-opp assets** at `ACE/<opp>/runs/<run-id>/6-qa-and-training/screenshots/...` — captured fresh each
  cycle for THIS opp's actual Learn-app modules and Deliver form.

`training-materials` stitches both pools into the final deck spec and
video script. Per-opp content is always re-captured (it changes per opp);
common content is referenced by file path and only re-captured when the
Connect APK actually updates. This keeps Phase 6 runtime predictable and
avoids burning AVD time on screenshots that don't change.

## Pre-flight checklist

Before dispatching Step 1, verify these. Each one is a class of
silent-failure prevention learned from earlier real-world dogfood.

- [ ] **AVD is booted + Maestro driver healthy + per-user state
      restored** — all three are owned by a SINGLE call to
      `mobile_ensure_avd_running` (since 0.13.204). Do NOT pre-flight
      with read-only probes (`mobile_probe_maestro_driver`,
      `mobile_capture_ui_dump`) and halt on them. Read-only probes
      cannot heal; halting on them means the heal funnel never runs.
      The contract:
        - `mobile_ensure_avd_running` returns → AVD is fully ready
          (booted, Maestro driver responsive, snapshot or bootstrap
          restored). Trust the return. Surface
          `AvdInfo.heal.deviceUserState` to the caller for telemetry.
        - `mobile_ensure_avd_running` throws (`AvdBootError`,
          `MaestroDriverError`, `DeviceUserStateError`) → halt with
          the typed error class + heal-attempt log in the halt return.
      Single entry point, single point of failure, single point of
      diagnosis. Pre-0.13.204 versions of this checklist called the
      read-only `mobile_probe_maestro_driver` as a halt gate and saw
      Phase 6 halt on driver-wedge states the heal would have fixed
      — that bug landed live in turmeric run 20260513-0616 retry on
      v0.13.203. Removed by the single-funnel rewrite.
- [ ] **CommCare 2.62.0+ is installed on the AVD.** `adb shell pm
      list packages org.commcare.dalvik` returns the package.
      `org.commcare.dalvik` IS the Connect-enabled CommCare client —
      there is NO separate "Connect APK" or `connect`-named package.
      Don't grep for `connect`; you'll find nothing and incorrectly
      conclude Connect is missing when it's installed and just in a
      wiped-state. `mobile-bootstrap` handles installation.
- [ ] **The AVD's per-user state is restored to the precondition.**
      Per the *"phase preconditions are restored, not adapted"*
      pattern (see `CLAUDE.md § Phase preconditions`),
      `mobile_ensure_avd_running` unconditionally restores the AVD
      to the known starting state every dispatch — no detect-and-adapt
      logic. Mechanism by backend:
      - **Local (since 0.13.203):** `loadSnapshot('registered-test-user')`,
        always. ~3s on the happy path. If the snapshot doesn't exist
        (fresh machine, deleted), tier-2 auto-bootstrap fires inline:
        install APK if missing → `registerTestUser` → `saveSnapshot`.
        ~3-5 min on first dispatch, then back to ~3s. Phase 4's
        `connect-opp-setup` already invited the test user, so the
        CONNECT-ID-3F precondition is satisfied automatically inside
        `/ace:run`.
      - **Cloud:** each `/api/mobile/ensure-running` cold-boots the
        AVD and runs the registration recipes (see
        `backends/cloud.ts` header). ~3-4 min, same contract.
      `AvdInfo.heal.deviceUserState` carries `{ classified_as,
      attempted, healed_via, verified_as, focused_activity,
      ui_dump_signal }` — surface that in your halt return on
      failure so the operator sees what was actually on screen.
      Recovery escalation: a `DeviceUserStateError` with code
      `snapshot-load-failed` means the snapshot doesn't exist (first
      machine setup, deleted) — operator runs `/ace:mobile-bootstrap`.
      A `DeviceUserStateError` with one of the wipe classes in the
      `verify:` segment (`needs-personal-id` /
      `needs-app-config` / `commcare-not-installed`) means the
      snapshot loaded but state is still wrong — snapshot corruption
      or post-snapshot APK upgrade drift; same remediation
      (`/ace:mobile-bootstrap` re-snapshots).
- [ ] **The opp-specific Learn + Deliver apps are claimable on the
      AVD via the test user.** Phase 4 `connect-opp-setup` should
      have pre-invited `${ACE_E2E_PHONE}`. Without an opp invite,
      `app-screenshot-capture` recipes that try to claim or interact
      with the app will fail. Note: the test user accumulates invites
      across every `/ace:run` — by run N the test user has N opp tiles
      in their app, distinguished only by the run-id suffix in the
      display name. The `${OPP_NAME}` matcher in `connect-claim-opp.yaml`
      relies on (a) the name being unique enough and (b) the newest
      invite sitting near the top of the list. **Read `OPP_NAME`
      verbatim from `run_state.yaml.phases.connect-setup.products.connect.opportunity.name`**
      — do NOT compose it from slug pieces. The live tile text uses an
      em-dash (`—`, U+2014) and the display-name prefix, neither of
      which a slug-based reassembly produces. See
      `skills/app-screenshot-capture/SKILL.md § Step 4 "OPP_NAME source"`.
- [ ] **`ACE_TRAINING_DECK_TEMPLATE_ID` is set** if you want a Slides
      deck. `bin/ace-doctor` reports it. If unset, `training-deck-render`
      skips silently — Phase 6 still completes, just without the
      Slides deliverable.
- [ ] **Slides API is enabled** on the GCP project. Only matters if
      `training-deck-render` will run. First call returns the enable
      URL with a 1-minute propagation if it's off. See
      `playbook/integrations/slides-integration.md`.
- [ ] **`adb devices` shows no other-user `unauthorized` entries.**
      ACE recipes since 0.10.65 bypass dadb auto-discovery via
      `--host`/`--port` so this isn't fatal — but doctor WARNs and
      ad-hoc `adb shell` without `-s` may pick the wrong device. See
      `playbook/integrations/mobile-integration.md` "Multi-user dadb
      landmine."
- [ ] **Phase 3 produced the per-journey Maestro recipes alongside
      `app-test-cases.yaml`.** For each `is_smoke: true` journey in
      `3-commcare/app-test-cases.yaml`, the journey's `recipe_path`
      must resolve to a real file under
      `3-commcare/recipes/J<n>.yaml`. The `app-test-cases` SKILL
      contracts BOTH outputs — the master yaml AND per-journey
      recipes (see `skills/app-test-cases/SKILL.md § Outputs`).
      Master-yaml-without-recipes is the canonical "upstream Phase 3
      produced incomplete output" failure mode (observed
      2026-05-06 leep-paint-collection run 20260506-1440 — surfaced
      because a Phase 3 dispatch paraphrased the SKILL contract and
      elided the recipe outputs). If recipes are missing, halt
      with a clear pointer to re-run
      `/ace:step app-test-cases <opp>/<run-id>` BEFORE running
      `/ace:step app-screenshot-capture <opp>/<run-id>`. Skip this
      check and you waste AVD-boot wall-clock for nothing.

If any check fails, halt before Step 1 with a `[BLOCKER]` and the
named operator command (`/ace:mobile-bootstrap` for AVD/Maestro state;
`/ace:step app-test-cases` for missing recipes). **Do not soft-skip
screenshot capture and ship placeholders.** Pre-0.13.165 this phase
accepted "AVD unavailable → write verdict:incomplete and proceed,"
which let real Phase 6 capability gaps hide behind benign-looking
yellow verdicts run after run. The orchestrator may also try to
authorize a soft-fail in its dispatch prompt ("proceed with
placeholder screenshots"); ignore that — discipline lives at the
agent level so it survives ad-libbed dispatcher prompts.

### On halt, capture diagnostic state — don't infer it

When this agent halts at the pre-flight (or when `app-screenshot-capture`
halts under us), the return summary MUST include:

1. **The failure screenshot path + read of its contents.** Maestro
   writes one on every recipe halt at `~/.maestro/tests/<timestamp>/screenshot-❌-*.png`.
   Read it before classifying. The image often names the failure mode
   literally (PersonalID banner, Enter Code screen, etc.) and avoids
   the inverted-conclusion class of bug (live 2026-05-13 turmeric run:
   subagent concluded "Connect not installed" because it didn't find a
   `connect`-named package — but `org.commcare.dalvik` is the Connect
   client, and the screenshot had the actual diagnosis in 16pt type).
2. **The last `mobile_ensure_avd_running` response in full**
   (`heal_attempted`, `heal_steps`, `heal_outcome`). Pre-0.13.165 these
   weren't structured; 0.13.165 introduced the auto-heal contract but
   the subagent often returns just "Maestro recipe failed" without the
   heal log. If the heal log is empty or absent in the return, the
   subagent didn't actually probe whether the heal ran — re-dispatch
   with an explicit "return the full `mobile_ensure_avd_running`
   response including heal_steps" instruction OR file a class-level
   issue on the heal contract. Don't immediately escalate to
   `/ace:mobile-bootstrap` if the heal log shows the heal never fired —
   the structural fix is fixing the heal contract, not papering with
   bootstrap.
3. **The focused activity and a `mobile_capture_ui_dump` excerpt** of
   the failure state, so the table in `app-screenshot-capture/SKILL.md`
   § Step 2.5 can classify deterministically.

The pre-flight has the evidence; reading it costs three tool calls
and prevents a whole class of "guessed from indirect signals" mistakes.

## Workflow

### Step 1: Capture smoke screenshots + thin UX judge

Dispatch `app-screenshot-capture`:
- Reads: `2-scenarios/pdd-to-app-journeys.md` (Phase 2), `3-commcare/app-test-cases.yaml` (Phase 3)
- Writes: `6-qa-and-training/screenshots/J*/*.png` + `6-qa-and-training/app-screenshot-capture_verdict-shallow.yaml`
- Halts on smoke-recipe failure or UX judge < 2/3

The skill filters `app-test-cases.yaml` to entries with `is_smoke: true`
(exactly one per app), runs each smoke recipe against the AVD, captures
screenshots, then runs a single LLM-as-Judge call per app (~2 calls
total) asking whether the persona-matching FLW could complete the
journey without confusion. Threshold ≥ 2/3 per app.

Deep, per-journey UX grading is `app-ux-eval`, run manually from
`/ace:qa-deep` before Phase 9 activation. The Phase 9 `llo-launch` gate
refuses activation without a fresh, passing
`6-qa-and-training/app-ux-eval_verdict-deep.yaml`.

### Step 2: Per-artifact training skills (5 in parallel + 2 sequential)

The training-materials monolith was decomposed into 6 per-artifact
skills + 1 deck-render skill across versions 0.10.79–0.10.84. The
phase dispatches them in dependency order:

**2a. Parallel — five text artifacts (independent, run concurrently):**

- `training-llo-guide` → `llo-manager-guide.md`
- `training-flw-guide` → `flw-training-guide.md`
- `training-quick-reference` → `quick-reference.md`
- `training-faq` → `faq.md`
- `training-deck-generate` → `training-deck-spec.yaml`

Each skill reads PDD + app summaries + connect/OCS state + (where
applicable) per-opp + common screenshot manifests. Each writes its
single artifact under `ACE/<opp>/runs/<run-id>/6-qa-and-training/`. Each
self-evaluates against four criteria specific to its audience and
writes a verdict YAML.

Halt the phase on any non-pass verdict.

**2b. Sequential — deck render (after `training-deck-generate`):**

- `training-deck-render` reads `training-deck-spec.yaml` + the
  `ACE_TRAINING_DECK_TEMPLATE_ID` env var, copies the template into
  the opp folder, fills via `slides_batch_update`, returns the
  Slides URL.
- Skipped if `ACE_TRAINING_DECK_TEMPLATE_ID` is unset (with a clear
  pointer to `scripts/bootstrap-training-deck-template.ts`). Phase 9
  doesn't depend on the Slides deck — `onboarding-email-body.md` is
  the load-bearing Phase 9 input — so a missing template doesn't
  block go-live.

**2c. Sequential — onboarding email (after the other 5 text artifacts):**

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

- `ACE/<opp>/runs/<run-id>/6-qa-and-training/screenshots/<journey-id>/<step>.png` + `ACE/<opp>/runs/<run-id>/6-qa-and-training/app-screenshot-capture_manifest.yaml`
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/{llo-manager-guide,quick-reference,faq,onboarding-email-body}.md` (training-materials)
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-flw-guide.md` (training-flw-guide)
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-deck-spec.yaml` (training-deck-generate)
- A Google Slides deck under the same folder (when template is configured)
- `runs/<run-id>/6-qa-and-training/app-screenshot-capture_verdict.yaml` (structural verdict)
- `runs/<run-id>/6-qa-and-training/app-screenshot-capture_verdict-shallow.yaml` (smoke-judge verdict)
- Per-training-skill verdicts (`runs/<run-id>/6-qa-and-training/training-*_verdict.yaml`)
- `run_state.yaml.phases.qa-and-training.products.training` block — multi-writer typed handoff. Each of the six doc / deck skills writes its own slot via read-modify-write (the established multi-writer pattern from `synthetic-data-generate`):

  | Skill | Slot |
  |---|---|
  | `skill:training-llo-guide` | `products.training.docs.llo_guide.{file_id, title, web_view_link}` (title: "LLO manager guide") |
  | `skill:training-flw-guide` | `products.training.docs.flw_guide.*` (title: "FLW training guide") |
  | `skill:training-quick-reference` | `products.training.docs.quick_reference.*` (title: "Quick reference card") |
  | `skill:training-faq` | `products.training.docs.faq.*` (title: "FAQ") |
  | `skill:training-onboarding-email` | `products.training.docs.onboarding_email.*` (title: "Onboarding email") |
  | `skill:training-deck-render` | `products.training.deck.{file_id, title, web_view_link}` (title: from the Slides file's display name) |

  Read-modify-write recipe: `drive_read_file` → parse → merge in this skill's slot (sibling slots preserved) → `drive_update_file` with `ifMatchRevisionId`. See `skills/synthetic-data-generate/SKILL.md § Step 6` for the canonical implementation. ace-web's per-run summary page consumes this block to render the training pack section.

## Completion

After Step 2 finishes, write the `phases.qa-and-training` block per
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

## History

Renamed from `training-prep` (2026-04-30) and pivoted from synthesizer to executor (2026-05-04, 0.11.10 shallow/deep QA split). See [`docs/agent-history.md § Phase 6`](../docs/agent-history.md#phase-6-qa-and-training).
