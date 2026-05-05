# Shallow / Deep QA split for OCS and CommCare apps

**Date:** 2026-05-04
**Status:** Design accepted; ready for implementation plan
**Owner:** ACE

## Problem

`/ace:run` today runs deep QA on the OCS chatbot in Phase 4 by default
(both `--quick` and `--deep` sequentially), at a per-cycle cost of
roughly 90 LLM-as-Judge calls and up to 30 minutes wall-clock. The
CommCare-app side is asymmetric: Phase 5 generates a `qa-plan` and
captures screenshots but does no comparable behavioral grading, and
Phase 2's `app-test` is plan-only with inline self-eval. We have no
"is this app good for the FLW user" assessment anywhere in the pipeline.

We want three things:

1. `/ace:run` does shallow QA only — fast, cheap, focused on catching
   broken mechanics.
2. Deep QA is manually triggered when we actually want a quality
   assessment, and covers both the chatbot and the apps.
3. Phase 5 stops synthesizing QA plans. The phases that *know* the
   design intent (Phase 1) and the actual built structure (Phase 2)
   own those artifacts; Phase 5 just executes.

A safety net is needed so shallow-by-default can't accidentally ship
an un-deep-graded opportunity to live LLOs.

## Design overview

```
Phase 1 (design-review)         Phase 2 (commcare-setup)        Phase 5 (qa-and-training)
  pdd.md                          learn-app-summary.md             [executor only]
  test-prompts.md                 deliver-app-summary.md           reads upstream artifacts
  expected-journeys.md  [NEW]     app-test-cases.yaml  [NEW]       runs smoke recipes
                                                                   captures screenshots
                                                                   thin UX judge

Manual: /ace:qa-deep <opp>
  → deep OCS eval + deep app UX eval against expected-journeys.md
  → writes verdicts/*-deep.yaml (uniform shape, fed to opp-eval)

Phase 6 (llo-manager / llo-launch)
  → activation gated on fresh, passing deep verdicts for both OCS and apps
```

## 1. Artifact ownership

Each phase owns artifacts it can produce from what it actually knows.

| Artifact | Phase | New? | Source |
|---|---|---|---|
| `pdd.md` | 1 | existing | idea-to-pdd |
| `test-prompts.md` | 1 | existing | pdd-to-test-prompts (OCS deep ground truth) |
| `expected-journeys.md` | 1 | NEW | pdd-to-app-journeys |
| `learn-app-summary.md` | 2 | existing | pdd-to-learn-app |
| `deliver-app-summary.md` | 2 | existing | pdd-to-deliver-app |
| `app-test-cases.yaml` | 2 | NEW | app-test-cases skill |

**`expected-journeys.md` shape:** narrative form. Each journey carries
a persona reference (matched to the PDD's FLW description), a goal,
a happy-path narrative, and edge cases phrased as UX outcomes ("FLW
understands why the form rejected them" rather than "form rejects
input"). PDD-grounded; app-agnostic.

**`app-test-cases.yaml` shape:** binds Phase 1 journeys to real
Phase-2-built artifacts. Each entry: journey ID, list of forms/fields
exercised, a Maestro recipe stub filled out with real selectors (not
`REPLACE_*` scaffolds), and the structural pass criteria. Generated
after Nova builds and before `app-release`.

**Phase 5 stops synthesizing.** The `qa-plan` skill is retired. Phase 5
reads upstream artifacts and executes.

## 2. Skill changes

**New skills:**

- `pdd-to-app-journeys` (Phase 1). Mirror of `pdd-to-test-prompts`
  for apps. Reads PDD → emits `expected-journeys.md`.
- `app-test-cases` (Phase 2). Runs after Nova builds, before
  `app-release`. Reads `expected-journeys.md` + actual built app
  structure → emits `app-test-cases.yaml`.
- `app-ux-eval` (deep, manual only). LLM-as-Judge over captured
  screenshots + `expected-journeys.md`. Writes
  `verdicts/app-ux-eval-deep.yaml` in the uniform verdict shape.

**Retired skills:**

- `qa-plan` (Phase 5). Job moves upstream.
- `app-test` (Phase 2). Was plan-only with inline self-eval; replaced
  by `app-test-cases` which is artifact-emission only. The Phase-5
  execution that `app-test` was nominally about always lived in
  `app-screenshot-capture` anyway.

**Changed skills:**

- `ocs-chatbot-qa` / `ocs-chatbot-eval`. `--quick` thinned (see §3).
  `--deep` unchanged in behavior, but now invoked only from
  `/ace:qa-deep`, not from Phase 4.
- `app-screenshot-capture`. Becomes the shallow execution path.
  Runs one smoke recipe per app, captures the screenshot set training
  needs, plus a thin UX judge (see §3). No longer reads or depends on
  `qa-plan` output.

**Phase 4 (`ocs-setup`):** drops the `--deep` gate. Shipping `--quick`
passing is enough to proceed to Phase 5.

**Phase 5 (`qa-and-training`):** orchestrates `app-screenshot-capture`
(shallow) → the per-artifact training skills in parallel
(`training-llo-guide`, `training-flw-guide`, `training-quick-reference`,
`training-faq`, `training-onboarding-email`, `training-deck-outline`)
→ `training-deck-build`. No `qa-plan` step.

## 3. Shallow path — what `/ace:run` always runs

Goal: catch broken mechanics, plus a tiny LLM-judge presence per skill
so rubrics don't atrophy from disuse. Budget ceiling: **5 LLM judge
calls total per `/ace:run`.**

**OCS shallow (Phase 4 default):**

- 3 smoke prompts (currently 5 in `--quick`).
- 3 prompts × 1 dimension (`overall_quality_0_to_3`) = **3 LLM calls**.
- Pass criteria: all 3 prompts received responses + cited sources +
  no `overall_quality` verdict below 2/3.
- Wall-clock: 90s × 3 = ~4 min cap.

**App shallow (Phase 5 default, runs as part of training capture):**

- 1 smoke recipe per app from `app-test-cases.yaml` (Learn + Deliver).
- Screenshots captured into `ACE/<opp>/screenshots/` as today; training
  skills consume these regardless.
- 1 single-question UX judge per app:
  *"Looking at these screenshots, would a low-literacy FLW be able to
  complete this without confusion? Rate 0-3 + one-line reason."*
  = **2 LLM calls**.
- Pass criteria: both recipes complete without crash + both UX
  judgments ≥ 2/3.
- Wall-clock: dominated by AVD execution (~5–10 min per app).

**Re-use, not double-run.** App shallow's smoke recipes ARE the
screenshot pass that training needs. We are not adding AVD time for
QA; we are adding 2 LLM calls.

## 4. Deep path — `app-ux-eval` rubric

Five dimensions, each scored 1-3, ground-truth = `expected-journeys.md`.
Mirrors the OCS-eval pattern (multi-dimensional + hard-deductions).

| Dimension | What to look for | Hard deduction |
|---|---|---|
| `clarity` | Field labels and prompts unambiguous to the target FLW persona | Any field name only a developer would understand |
| `flow_predictability` | Conditional branches go where FLW expects; skip patterns don't surprise | A screen appears or disappears with no apparent cause from the user's perspective |
| `error_recovery` | Validation/required-field errors tell the FLW what's wrong and how to fix | Dead-end errors with no recovery path |
| `time_budget` | Visit length matches PDD-stated FLW tolerance, counted from recipe step count + estimated input time | 2x the PDD-stated budget |
| `journey_completion` | Recipe accomplishes the journey's stated goal end-to-end | Recipe ends without confirmation / stuck screen |

**Aggregation:** per-journey verdict = weighted average, hard-deduction
clamps to fail. Phase verdict = all journeys pass → pass; any journey
fail → fail with summary of which journeys failed which dimensions.

**Why no `tone` or `cultural_fit` dimension:** for chatbots tone is
the product, hence its own dimension in `ocs-chatbot-eval`. For apps
tone lives in field labels and lands inside `clarity`. Avoiding rubric
bloat.

The rubric is what makes "would this be good for the user" tractable
for an LLM judge. Expected to iterate on dimensions and hard-deductions
once we have ~3 calibration runs per CRISPR opp archetype.

## 5. `/ace:qa-deep <opp>` command

Manual deep-QA surface. Thin wrapper over existing skills — no new
orchestration agent.

```
/ace:qa-deep <opp-name>                       # OCS deep + apps deep
/ace:qa-deep <opp-name> --ocs-only            # skip apps
/ace:qa-deep <opp-name> --apps-only           # skip OCS
/ace:qa-deep <opp-name> --since=<verdict-id>  # apps only: re-grade
                                                journeys whose recipes
                                                changed since prior verdict
```

**Inputs (read from Drive, `ACE/<opp-name>/`):** `pdd.md`,
`test-prompts.md`, `expected-journeys.md`, `app-test-cases.yaml`, the
existing OCS chatbot, the released CommCare apps.

**Behavior:**

- **OCS path:** `ocs-chatbot-qa --deep` → `ocs-chatbot-eval --deep`
  (current behavior, unchanged).
- **Apps path:** read `app-test-cases.yaml`; for each journey, run
  `mobile_run_recipe`, capture screenshots, upload to Drive. Run
  `app-ux-eval` over the captured set, judging each journey against
  `expected-journeys.md` per the §4 rubric.

Both write `verdicts/<skill>-deep.yaml` in the uniform shape so
`opp-eval` can aggregate. Each run also appends a row to the per-rubric
run log in `eval-calibration/` so calibration metrics keep accumulating.

**What it does NOT do:**

- No re-running of Phase 5 training materials. Deep QA is purely
  quality assessment, not artifact regeneration.
- No CommCare app rebuild. If apps are stale, user runs `/ace:run` first.
- No Phase 6 activation side-effects. Pure read-and-grade.

**Implementation shape:**

- New file: `commands/qa-deep.md` (slash command).
- Calls `/ace:step <skill> --deep` under the hood for each piece.
- No new agent; thin script that dispatches existing skills.

The `--since` flag is optional in v1 if it complicates the
implementation. AVD execution is the wall-clock dominator, so the
ergonomics win is real but can defer.

## 6. Phase 6 deep-verdict gate (safety net)

Without a gate, someone could run `/ace:run` then activate an
opportunity for real LLOs without ever running deep QA. This is the
class-level preventer.

**Where:** `llo-launch` skill in Phase 6 (`llo-manager`), immediately
before `connect_activate_opportunity`.

**Gate logic:**

```
Before activation, llo-launch reads:
  ACE/<opp>/verdicts/ocs-chatbot-eval-deep.yaml
  ACE/<opp>/verdicts/app-ux-eval-deep.yaml

Required for activation:
  - Both files exist
  - Both have status: pass
  - Both verdict timestamps are newer than:
      - the OCS chatbot's last published version (for OCS verdict)
      - the latest released CommCare build (for app verdict)

If any condition fails, llo-launch halts with:
  "Deep QA verdicts missing or stale. Run /ace:qa-deep <opp> before activation."
  [BLOCKER] tag — review-mode and default-mode both pause.
```

**Override:**

```
/ace:step llo-launch <opp> --override-deep-qa-gate="<reason>"
```

Reason is required and gets written to `comms-log/observations.md` for
audit. Default `/ace:run` cannot pass this flag.

**Why timestamp freshness matters:** without it, a previously
deep-QA-blessed chatbot v1 could be edited and re-shipped via
`/ace:run` (shallow) and still pass the gate. Timestamps close that.

## Cost story

| Path | LLM judge calls | Wall-clock (QA only) | Notes |
|---|---|---|---|
| Today's `/ace:run` (Phase 4 deep + Phase 5 qa-plan) | ~90 | ~30 min OCS + AVD time | Deep gate every run |
| New `/ace:run` (shallow only) | **~5** | ~10–20 min, dominated by AVD | Smoke recipes are training screenshots, no extra AVD time |
| `/ace:qa-deep <opp>` (manual) | ~65+ OCS + per-journey app | ~30 min OCS + AVD per recipe | Run when you actually want a quality assessment |

**Per-`/ace:run` reduction: ~18×** in judge calls. Wall-clock reduction
depends on opp size; OCS deep alone dropping out saves up to 30 min.

## Migration / rollout

**Order of operations** (each step keeps the pipeline runnable):

1. Add `pdd-to-app-journeys` skill + `expected-journeys.md` artifact.
   Phase 1 starts emitting it; nothing reads it yet.
2. Add `app-test-cases` skill + `app-test-cases.yaml` artifact.
   Phase 2 starts emitting; `qa-plan` still runs.
3. Add `app-ux-eval` skill + `/ace:qa-deep` command. Both can be used
   manually before they're wired into Phase 6.
4. Switch Phase 5 to executor-only: `qa-plan` removed,
   `app-screenshot-capture` reads the new yaml. Test on a fresh `/ace:run`.
5. Thin OCS `--quick` to 3 prompts × 1 dim. Drop Phase 4 `--deep` gate.
6. Wire Phase 6 gate. Last step — until this lands, deep QA is
   advisory, not enforced.
7. Retire `qa-plan` and `app-test` skills + their references.

**Migration script:** `migrations/0.x.0-shallow-deep-qa.md` documents
the old → new artifact mapping for in-flight opps. Existing opps with
a `qa-plan.md` but no `expected-journeys.md` get a one-time
backfill option (re-run Phase 1 just for the new artifact).

**Doctor checks added:**

- `/ace:doctor` warns if a skill exists but its retired sibling is
  still being referenced elsewhere.
- `opp-eval` checks for verdict freshness against artifact timestamps
  (mirrors the Phase 6 gate logic).

## Open questions

1. **Deep app QA on first opp without a prior verdict.** First-ever
   `/ace:qa-deep` for an opp has no `--since` baseline. Just runs all
   journeys; not really a question, but flagging.
2. **`expected-journeys.md` template.** Need a concrete template
   matching the rigor of `templates/pdd-template.md`. Open question:
   how many journeys per archetype?
3. **Shallow UX judge prompt wording.** "Would a low-literacy FLW
   complete this without confusion?" assumes a specific persona; if
   the opp's persona differs (e.g., trained nurse), the prompt should
   pull persona from PDD. Not blocking; iterate.
4. **`opp-eval` weighting between shallow and deep verdicts.** Today
   `opp-eval` aggregates whatever verdicts exist. If shallow and deep
   for the same skill both exist, which wins? Probably deep when fresh,
   shallow when not — needs a rule.

These are non-blocking — the design is implementable as-is and these
get resolved during plan/implementation.
