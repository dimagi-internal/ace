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

## Phase 7 (synthetic-data-and-workflows)

### Initial Phase 7 agent — 2026-05-06 (Plan B Stage 4a)

Agent created. Skill list reflects Stages 1-3 ship state at the time; eval skills were declared but not yet implemented.

Authored by: ACE team (Plan B Stage 4a).
