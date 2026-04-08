# CRISPR-Test-002 — Focus-Group Synthetic Test Fixture

Permanent synthetic opportunity for regression-testing ACE skills against the **`focus-group` delivery archetype**. Pair fixture to `CRISPR-Test-001` (which covers `atomic-visit`).

## Why this fixture exists

`CRISPR-Test-001` only protects atomic-visit behavior — i.e., the behavior the framework was originally hard-coded for. The framework changes that landed alongside this fixture (delivery archetypes, Evidence Model, stress-test rubric) added focus-group support to 7 skills. Without a focus-group fixture, future SKILL.md edits can silently re-break that support and we won't know until a real focus-group opportunity exposes it.

This fixture is the **regression check** for the focus-group code path. Any SKILL.md change that touches archetype branching or Evidence Model consumption should be re-validated against this fixture before being merged.

## Source

A simplified version of the vaccine-hesitancy IDD at `docs/examples/idd-vaccine-hesitancy.md`:

- **Stage 1 only** (the focus-group stage). The full IDD is multi-stage; we drop Stage 2 to keep this fixture single-archetype and small.
- **2 segments** instead of 6 (women-close-to-PHC-undervaccinated, men-remote-mixed). Halves the recruitment surface while still exercising segment differentiation in `flw-data-review`.
- **1 LLO** (a fake one) instead of multiple. Simplifies onboarding and invite logic.
- **Stress-test rubric grades all `pass`**. The original vaccine-hesitancy IDD fails 4 of 5; this fixture is the version where those gaps have been resolved, so `idea-to-idd` doesn't loop on it.

## Contents

- `idd.md` — Stage-1-only vaccine-hesitancy IDD with `archetype: focus-group`, full Evidence Model, and a `## Stress Test Results` appendix showing all-pass
- `state.yaml` — Initial state, mode `review`, all steps pending
- `app-summaries/learn-app-summary.md` — Stub: facilitation-training app structure (the focus-group Learn app brief)
- `app-summaries/deliver-app-summary.md` — Stub: session-documentation app structure (the focus-group Deliver app brief)
- `connect-setup/invites.md` — One fake LLO

## Usage

Same as `CRISPR-Test-001`. Always use `--dry-run`:

```
/ace:run CRISPR-Test-002 --mode review --dry-run
```

Or single-step:

```
/ace:step <skill-name> CRISPR-Test-002 --dry-run
```

## Expected behaviors per skill (the regression spec)

When a SKILL.md is edited and re-run against this fixture, here is what each skill **should** produce. If the actual output materially diverges from the spec below — and that divergence isn't intentional and documented in the SKILL.md change log — the change is a regression.

### `idea-to-idd`
- Reads `archetype: focus-group` from the IDD frontmatter
- Drafts an IDD with the focus-group additional sections: **Recruitment Plan**, **Facilitation Protocol**, **Question Guide**, **Output Specification** (per `## Archetypes` in `skills/idea-to-idd/SKILL.md`)
- Runs the 5-question stress-test rubric against the draft
- Produces **all `pass`** for this fixture (it was constructed to pass the rubric)
- Writes IDD with `## Stress Test Results` appendix showing the grades

### `idd-to-learn-app`
- Reads `archetype: focus-group`
- Generates a **facilitation training app brief** for Nova, not a form-walkthrough brief
- Brief includes: facilitation basics, probing techniques, neutral framing, group dynamics, question-guide walkthrough, session-form walkthrough, consent and ethics, logistics
- Brief explicitly references the IDD's Facilitation Protocol section
- Does **not** generate a generic data-collection-form-walkthrough brief

### `idd-to-deliver-app`
- Reads `archetype: focus-group`
- Generates a **session documentation form** brief for Nova
- Form has pre-session, per-question-domain (one section per domain in the IDD's question guide), and post-session sections
- Case management is **per-segment**, not per-participant
- Brief explicitly references the IDD's Output Specification section
- Does **not** generate a per-beneficiary form

### `app-test`
- Reads `archetype: focus-group` and the IDD's Evidence Model
- Generates a test plan focused on per-domain section coverage, file-upload paths (audio, attendance photo), consent gating, segment-level case lifecycle
- Every Layer A artifact in the Evidence Model has a corresponding test
- Does **not** include atomic-visit-specific tests like duplicate beneficiary detection

### `connect-opp-setup`
- Reads the IDD's Evidence Model Layer A as the source of verification rules
- Sets **delivery unit = one completed focus group session** (not one participant)
- Sets **payment unit = per verified session**, total count from IDD planned sessions
- Verification rules quote Layer A entries directly: GPS, audio duration ≥ 45 min, attendance form, per-domain summaries, consent confirmation, facilitator reflection
- Layer B/C entries become **soft flags**, not hard gates
- Uses delivery type "Experiment" (or flags that "Experiment" delivery type is required)

### `flw-data-review`
- Reads `archetype: focus-group`
- Performs **qualitative review**: per-session quality, cross-session synthesis, saturation check, quote bank, facilitator coaching signals
- Does **not** run quantitative checks (submission rates, outlier detection, daily caps)
- Does **not** grade FLWs on volume

### `cycle-grade`
- Reads `archetype: focus-group`
- Grades FLW Performance on **facilitation quality**, not submission volume
- Grades Intervention Effectiveness on **research yield** (theme specificity, segment differentiation, IDD research questions answered)
- Adds a 7th dimension: **Research Quality** (0–10)
- Grading evidence quotes actual session content from the Evidence Model layers

## Fake contacts

The LLO contact in `connect-setup/invites.md` is fictional. Do **not** send real emails to it during testing — always use `--dry-run`.

## Capturing golden outputs

The current ACE eval framework (`test/eval/`) is built for Nova blueprints, not for SKILL.md prompt outputs. Capturing skill outputs against this fixture is a manual step for now: run each skill in `--dry-run` mode and inspect the resulting files in `comms-log/dry-run-<step>.md` against the spec above. When ACE gains automated skill regression (planned), this fixture will be its primary focus-group test case.
