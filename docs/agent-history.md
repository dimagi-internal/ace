# Agent History

Curated history of agent renames, scope pivots, and structural reorganizations. This file is the destination for "naming change" / "executor pivot" / "change log" sections that previously accumulated at agent-file bottoms — moved here in 2026-05-25 so the agent files stay focused on current procedure.

Each entry is **load-bearing tribal knowledge** worth preserving across the project's lifetime — the reason a thing is named what it's named, why an artifact lives where it lives, what a phase used to do versus what it does now. Git blame can answer "when did this change?" — this file answers "why?".

Add new entries when an agent is renamed, has its scope materially reshaped, or absorbs/sheds responsibilities. Don't add entries for routine bug fixes or per-cycle PRs — those live in commit messages.

## Phase 3 (commcare-setup)

No notable history events yet. (Pre-0.13.116 changes are captured inline in `agents/commcare-setup.md` parenthetical notes.)

## Phase 6 (qa-and-training)

### Naming change — 2026-04-30

This phase was previously named `training-prep`. Renamed to `qa-and-training` to reflect that QA test-plan generation was a first-class output (alongside training material), not a sub-step of training prep. The agent file moved from `agents/training-prep.md` to `agents/qa-and-training.md`; the new `qa-plan` skill landed alongside.

### Executor pivot — 2026-05-04 (0.11.10, shallow/deep QA split)

QA-plan synthesis moved upstream to Phase 1 (`pdd-to-app-journeys`) and Phase 3 (`app-test-cases`). Phase 6 became an **executor**: it reads the pre-composed smoke recipes from `app-test-cases.yaml`, runs them, captures screenshots, and runs a thin per-app UX smoke judge. Deep, per-journey UX grading is `app-ux-eval`, manually triggered via `/ace:qa-deep` before Phase 8 activation. The `qa-plan` skill was retired and the agent's `skills:` frontmatter no longer lists it.

Spec: `docs/superpowers/specs/2026-05-04-shallow-deep-qa-split-design.md`.

### App previews filed with Phase 3 — 2026-09-29 (output previews contract v1)

`app-screenshot-capture` now uploads each passing smoke leg's PNGs to `3-commcare/previews/<app-output-slug>/` with an authoritative `_previews.yaml`, instead of `6-qa-and-training/screenshots/<recipe-base>/`: a preview lives with the phase that BUILT its output, whoever captured it, so a reader looking at Phase 3's apps sees them. Forensics (ui-dumps, `*-FAILURE.*`) stay in Phase 6's folder; the capture manifest stays in Phase 6 and keeps listing every frame by `file_id`. Spec: ace-web `docs/specs/2026-09-29-output-previews-design.md`; helpers `lib/output-previews.ts`.

## Phase 7 (synthetic-data-and-workflows)

### Initial Phase 7 agent — 2026-05-06 (Plan B Stage 4a)

Agent created. Skill list reflects Stages 1-3 ship state at the time; eval skills were declared but not yet implemented.

Authored by: ACE team (Plan B Stage 4a).

### Dashboard previews — 2026-09-29 (output previews contract v1)

New § Step 3.95: after the DDD render, one or two per-scene frames per dashboard in `products.synthetic.workflows` (matched by labs workflow id) are copied to `7-synthetic/previews/<slug of synthetic.workflows.<key>>/` with a `_previews.yaml` (`captured_by: ddd-run`). Best effort — never fails the phase; the summary says what was and was not previewed.

## Cross-phase — output previews

### `output-preview-capture` at every phase end — 2026-09-29 (output previews addendum)

Phases 3–8 now end their write-back by invoking `Skill(output-preview-capture)` filtered to their own phase (Phase 6 also runs it once for `commcare-setup`, the app fallback after the emulator walk; Phase 7 as § Step 4.5, after Step 3.95's render frames), and the orchestrator runs it once more at run end over all phases (`## Run end: capture remaining output previews`). Best effort: the phase summary states `previews: N captured, M gaps left (why)`; it never fails or blocks a phase.

## QA/eval gaps — 2026-10-01

- **Phase 4 (`connect-setup`):** new Step 3b dispatches `build-memo-eval` after the memo; `connect-opp-setup` gains Step 11, a post-condition read-back whose `phase6_blockers` Phase 6's pre-flight now honours.
- **Phase 6 (`qa-and-training`):** `training-deck-render-eval` runs after the render (2b). A `fail` does not halt the phase, but the deck is reported as not ready to project.
- **Phase 7 (`synthetic-data-and-workflows`):** `demo-data-setup-qa` is mandatory for every provider and always writes its result through `scripts/demo-data-setup-qa.ts`.
