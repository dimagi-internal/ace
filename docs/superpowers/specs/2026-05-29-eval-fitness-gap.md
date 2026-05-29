# The Eval Fitness Gap — ITN post-mortem + systemic audit

**Date:** 2026-05-29 · **Trigger:** ITN run `20260528-1607` (opp `malaria-itn-app`)
scored **9.6/pass** on both app-build evals, but a human expert's hand-finished
Nova build was a materially better, deployable instrument. The eval system
certified a hollow build as near-perfect.

**Source comparison doc:** `1Ch8Hb9byn3mIz1p0oi7qqB_KS2CHPIlrgrgWmEJsSDA`
(field-by-field ACE-vs-Sarvesh diff).

**This spec has three parts** (matching the three asks):
1. **The generalized failure mode** — why 9.6 was true *and* meaningless, stated as a law.
2. **Systemic audit** — all 33 `-eval` skills classified against that law. The weakness is systemic, not ITN-specific.
3. **Comprehensive fix lists** — skill improvements + eval improvements, prioritized, mapped to files, sequenced into staged PRs.

---

## Part 1 — The generalized failure mode

### Name it: **spec-conformance laundered as quality**

ACE's whole pipeline is one AI authoring chain:

```
idea → PDD (AI)  →  app / solicitation / training / synthetic (AI + Nova)  →  eval (AI grades output against the AI's PDD)
```

An eval is **self-referential** when its grading anchor is an upstream artifact
produced by the *same chain it is grading*. When an eval's dimensions reduce to
"does the output **contain / match / cover** what the upstream spec named," it
can only certify **fidelity to the skeleton** — never **fitness of the
instrument**. The PDD is itself a thin, first-pass AI interpretation, so a
faithful build of a thin skeleton scores ~9.6. **That 9.6 is arithmetically
correct and informationally empty.**

The ITN gaps the eval missed are exactly the axes that separate "contains the
topic" from "deployable instrument": input validation, GPS accuracy-gating,
case write-back on follow-up, bilingual strings, assessment *enforcement* (not
just a threshold tag), structured multi-selects vs free text. None of these are
in any app-eval dimension.

### Why it inflates *and stays hidden* — four structural causes

1. **No out-of-chain anchor.** Nothing in the dimension set is grounded outside
   the AI chain — no observed runtime behavior, no human ground truth, no
   real-world viability benchmark, no live probe. Conformance is fully
   satisfiable by an undeployable artifact.

2. **Conformance wearing a 0–10 costume.** `_eval-template.md` says "no
   structural checks in eval — those go to QA." Authors satisfied that rule
   *cosmetically*: they turned count/order/name checks into soft 0–10 scores
   (`field_count_match: 9.0`) instead of choosing genuinely evaluative axes. A
   0–10 score over a presence check is still a presence check.

3. **Calibration validates detection, not coverage.** The ground-truth
   catalogue (`eval-calibration/known-issues.md`) is operator-authored *after a
   run* and lists nits the operator already noticed. Hitting ≥80% detection on a
   structural-nit catalogue says nothing about whether the rubric's *dimensions
   span fitness*. **A blind spot cannot be a known issue.** So calibration
   manufactures confidence precisely where the rubric is weakest. Every eval's
   calibration target is "detection-rate against a known-issues catalogue" —
   the calibration loop is itself self-referential.

4. **Amplifiers** that make conformance pay *more* than fitness:
   - **"PDD-deferral exemption"** (Phase 2 evals): the judge is told to *only
     score against surfaces the PDD already declares.* This mathematically
     forecloses any judgment about what a deployable artifact *should* contain —
     PDD thinness becomes a free pass, not a finding.
   - **`time_budget` rewards thinness** (`app-ux-eval`): step-count × 5s only
     deducts when it exceeds **2×** the budget, so a skeletal, fast form scores
     9.5. The one runtime eval in the pipeline rewards the ITN failure.
   - **`error_recovery` is unmeasurable without validation** (`app-ux-eval`): it
     grades "errors recover gracefully *when they fire*" — a form with zero
     validation never fires an error, so it never trips the deduction.
   - **The aggregator launders** (`opp-eval`): `--deep` is pure score-rollup
     (mean of upstream `overall_score`s, weighted across 7 categories). No
     independent fitness term. 9.6 sub-scores → 9.6 cycle PASS. Its one guard
     (coverage cap) is orthogonal — it catches "too few categories graded," not
     "all categories inflated." Worse, `incomplete` verdicts are *excluded* from
     the mean, so honest "couldn't grade this" is filtered out and inflation is
     retained.
   - **Tone-match re-propagates inflation** (`learnings-summary-eval`):
     `tone_calibration_vs_cycle_grade` anchors to cycle-grade's own number, so a
     wrongly-rosy synthesis scores 9.5 for matching a wrongly-rosy grade.

### The predictive law (diagnosis *and* design rule)

> **An eval's inflation risk is inversely proportional to the distance between
> its grading anchor and the AI authoring chain.**
>
> - Anchor = observed runtime behavior / human decision / real-world benchmark /
>   live probe → **LOW risk.**
> - Anchor = upstream AI spec's *stated structure* → **HIGH risk.**

This law is confirmed empirically below: **every** LOW-risk eval in the suite
has an out-of-chain anchor; **every** HIGH-risk one lacks one. The good pattern
already exists in-repo — the fix is a *port*, not an invention.

### The systemic fix (one sentence)

Every eval needs at least one **out-of-chain fitness dimension** with real
deduction / hard-gate power, and the aggregator needs one **independent
raw-artifact deployability probe** that can cap the cycle grade — breaking the
self-referential loop at the one funnel point every score passes through.

---

## Part 2 — Systemic audit (all 33 `-eval` skills)

Classification: **target** (A self-referential / B external-fitness / C
runtime-or-ground-truth), whether a skeletal-but-conformant artifact can score
9+, and ITN-failure-mode risk.

### HIGH risk — self-referential, conformance-in-a-costume (15)

| Eval | Why HIGH | Highest-leverage fix |
|---|---|---|
| `pdd-to-deliver-app-eval` | All 5 dims (field_count/order/gate/conditional/connectify) match the PDD; validation & GPS accuracy *explicitly excluded* | Add `capture_fitness` dim (≥20%, hard-gate): validation on credit fields, GPS accuracy enforced, structured vs free-text, other→specify — graded vs expert bar, not PDD |
| `pdd-to-learn-app-eval` | `assessment_score_wiring` grades threshold-*tag-match*, not enforcement; `content_topic_coverage` = section-presence; placeholders score "as present" | Convert assessment dim to *enforcement* fitness; add `instructional_depth` at item granularity; cap all-placeholder build at `warn` |
| `pdd-to-app-journeys-eval` | Every dim conformance/prose-style; **deferral exemption** rewards thinness; 55% weight is prose voice | Add `deployability_fitness` dim, exempt from deferral carve-out |
| `pdd-to-test-prompts-eval` | ~55% conformance/prose; only `adversarial_prompt_quality` (20%) is fitness | Raise adversarial to 30%+; add `failure_mode_coverage` exempt from deferral |
| `connect-opp-setup-eval` | All 5 dims triangulate PDD↔Connect-config↔Deliver-summary; rate-sanity is `[INFO]`-only | Add `deployability` dim w/ deduction power: rate affordability vs *real regional* benchmark, runtime-survivable thresholds |
| `connect-program-setup-eval` | Near-identical to sibling; `program_fit_decision` grades the skill's *own self-reported rationale* | Same external-benchmark dim; re-derive fit independently |
| `pdd-to-work-order-eval` | 5/6 dims trace WO→PDD→decisions.yaml; only `verification_realism` is fitness | Raise `verification_realism`; add `commercial_realism` (rate/NTE vs external benchmark, counsel lens) |
| `training-deck-generate-eval` | Arc-shape + screenshot-count + topic-tally; never reads slide prose | Add `content_substance` (≥0.25): could a naive reader do the job from the slide bodies |
| `training-quick-reference-eval` | Purest presence-check: "has the listed numbers, formatted as a table" | Add `field_utility` + salience check on *which* numbers |
| `synthetic-walkthrough-spec-eval` | Coverage/falsifiability/no-banned-word checklist; orthogonal to "would impress"; inflation guard *removed* | Add `persona_resonance` (≥0.25) from the viewer's POV |
| `synthetic-data-generate-eval` | All 5 dims = count/field/URL match the manifest; zero fitness | Add `data_plausibility` reading *actual records*: would it fool a domain expert glancing at the dashboard |
| `synthetic-summary-eval` | Grades the summary doc, never the demo it summarizes; own inflation guard is a documented no-op | Cross-check headline claims vs *rendered labs state* |
| `synthetic-workflow-seed-eval` | Every dim = "ID present AND matches manifest count" | Add `kpi_decision_relevance`: would seeded KPIs drive the LLO's weekly decision |
| `solicitation-create-eval` | 70% weight = "carries the PDD forward" | Add applicant-facing `respondability` dim, independent of PDD |
| **`opp-eval`** (aggregator) | **Launders** all of the above — pure rollup, no independent fitness term; `incomplete` excluded from mean | **Add one independent raw-artifact deployability spot-check that hard-caps the run verdict** (see Part 4 §A) |

### MEDIUM risk — mixed; partial fitness dims, or inherits inflation (10)

| Eval | Note |
|---|---|
| `app-ux-eval` | MEDIUM-**HIGH**. Right substrate (real screenshots) but `time_budget` *rewards thinness* and `error_recovery` can't see missing validation. Fix: `capture_robustness` dim that drives negative/edge paths (blank required, low-GPS, out-of-range, "other") and hard-deducts when garbage is accepted |
| `training-faq-eval` | Dominant 0.35 `comprehensiveness` is a topic tally; scannability + field-realism (0.30) give partial teeth |
| `training-flw-guide-eval` | `step_concreteness` anchors collapse to "names the visible control"; `error_recovery_coverage` (0.15) is the real guard. Fix: held-out comprehension test |
| `training-llo-guide-eval` | `action_orientation` (0.25) resists wall-of-theory; add `operational_realism` (would this run a real cohort) |
| `synthetic-narrative-plan-eval` | 0.60 weight on cast/coaching/narrative realism = genuine fitness; PDD-anchor + schema (0.40) conformance |
| `synthetic-workflow-polish-eval` | visual-judge (projector test) is real fitness but only 0.15 weight; raise to ~0.40 + let `blocked` hard-cap |
| `solicitation-review-eval` | Heaviest dim (`recommendation_alignment` 0.4) is human-award ground truth — *but only after award exists*. Fix: emit `incomplete` pre-award so the anchor can't be silently dropped |
| `llo-uat-eval` | Real UAT substrate; `uat_coverage_completeness` is PDD-conformance. Fix: weight the UAT pass/fail *outcome* as its own dim |
| `cycle-grade-eval` | Anti-inflation by design, but its "find a failure mode" check reads the same inflated per-skill verdicts. Fix: re-derive ≥1 outcome from *raw run data* |
| `learnings-summary-eval` | `tone_calibration_vs_cycle_grade` *amplifies* upstream inflation. Fix: anchor tone to an independent outcome signal |

### LOW risk — out-of-chain anchored (the good pattern, 8)

| Eval | Out-of-chain anchor (why it resists) |
|---|---|
| `idea-to-pdd-eval` | `demand_reality` / `resource_realism` / `mission_alignment` (60%) grade real-world viability, not PDD structure |
| `ocs-chatbot-eval` (deep) | Grades a **live transcript**; factual-error 7-cap, hallucination→fail, citation ≤3 clamp, adversarial-coverage cap. *Caveat:* the in-run gate uses `--quick` (single 0–3 dim) — the strong rubric only runs out-of-band via `/ace:qa-deep` |
| `ocs-widget-handoff-eval` | Live HTTP 200 probe + credential-leak auto-fail |
| `training-onboarding-email-eval` | Reader-effect fitness (warmth/clarity/CTA = 80%); names Phase-9 response-rate telemetry |
| `video-spec-eval` | Explicit anti-inflation block; voice/coherence/compression are real quality axes |
| `llo-launch-eval` | 40% launch-time viability axis (`llo_capacity_actual`, `day_one_readiness`, `downstream_handoff_alignment`) — the exact good pattern |
| `flw-data-review-eval` | Cross-checks the report vs **observed real FLW submission data**; demands σ-thresholds, FLW-IDs, row counts |
| `solicitation-review-eval` | (also listed MEDIUM) human award decision IS ground truth |

**Tally:** 15 HIGH (incl. the aggregator) + 10 MEDIUM + 8 LOW. The majority of
the suite shares the ITN failure mode; the in-run app gate (`app-ux` quick +
`ocs` quick) is the weakest layer; the aggregator launders everything upstream.

---

## Part 3 — Skill improvement list (the build side)

ITN-specific findings from the comparison doc, generalized into skill changes.
Priorities: **P0** = ACE failed an explicit PDD requirement; **P1** = quality
bar (PDD-aligned, expert materially better); **P2** = polish.

### P0 — spec misses

1. **Honor the PDD working-language in the build.** — `pdd-to-learn-app`,
   `pdd-to-deliver-app`. PDD said "app strings in French"; ACE shipped
   English-only and punted localization "downstream." Extract `Working
   language` from the PDD and pass it into the autobuild spec (bilingual or
   primary-language = PDD working-language). *Gated by open decision #1.*

2. **Standard GPS accuracy-capture component.** — `pdd-to-deliver-app` (+
   reusable reference). Codify Sarvesh's `gps_block` (preferred/minimum
   accuracy, background-vs-manual capture, normalized lat/lon outputs, live
   accuracy-guidance labels) as a named, parameterized component the build emits
   whenever the PDD's evidence model specifies a GPS radius. Mirror the mobile
   MCP's static recipe palette.

3. **Default data-quality constraints.** — `pdd-to-deliver-app`. Emit by
   default: numeric bounds + cross-field checks on counts (`under_5 ≤
   household_size`), phone regex when a phone field exists, char limits on free
   text. ACE ships almost none today.

4. **Follow-up visits must persist observations to the case.** —
   `pdd-to-deliver-app` + assertion in `app-connect-coverage`. ITN Visit 2 wrote
   **zero** case properties — the entire point of V2 (observe change) was lost.
   New structural check: *case-update forms that capture new observations must
   write ≥1 case property.*

### P1 — quality bar

5. **Learn assessment + gating machinery.** — `pdd-to-learn-app`. When the PDD
   specifies a readiness gate, emit: pre-test, content modules writing
   `*_completed` user properties, post-test with structured `passing_score` +
   `passed`/`retry` writes, module display-conditions for sequential unlock,
   pass/fail result screens. ACE built a single 5-Q quiz with no gating.

6. **Full KAP enumeration + structured choices.** — `pdd-to-deliver-app`.
   Enumerate every KAP item the PDD lists (ITN dropped replacement interval,
   washing method, prior-repair, attitudes, mosquito alternatives). Prefer
   multi-select + "Other (specify)" over free text for enumerable answers;
   bucketed selects (net age) over raw ints.

7. **Section timestamps for the cost model.** — `pdd-to-deliver-app`. PDD wants
   section-level timestamps to reconstruct visit-time distributions; emit hidden
   `now()`/`today()` per section.

8. **Embed the BC script in the deliver form.** — `pdd-to-deliver-app`. PDD
   wants the behavior-change segment delivered verbatim; put the read-aloud
   script in-form rather than relying on FLW recall from Learn.

### P2 — polish

9. Help & Support form, Standards / Payment-Rules reference forms, media
   placeholders (good/bad photo examples), `<output value=.../>` interpolation,
   `random_number` Layer-B sampling field, graceful consent-refusal path.

### Cross-cutting build principle (new)

10. **"Faithful to a thin PDD" is a build smell, not a success.** The deeper
    root cause is upstream: Phase 1 produced a thin PDD and Phase 3 built
    faithfully to it. Two complementary moves:
    - **Strengthen the PDD** (`idea-to-pdd`): when the evidence model implies
      GPS radius / counts / phone / multi-select enumerations / a readiness
      gate, the PDD should *specify* the validation, capture-fidelity, and
      enforcement — not leave them implicit for Nova to skip.
    - **Reusable component library**: GPS-accuracy block, default-constraints
      pack, assessment-gating machinery, case-write-back pattern become named
      components the build skills emit by archetype — so depth is the default,
      not bespoke hand-craft. (Open decision #2: which Sarvesh choices are
      generic vs opportunity-specific.)

---

## Part 4 — Eval improvement list (the specifics)

Two layers: **(A) systemic** changes that fix the failure-mode class, and **(B)
per-eval** changes (the highest-leverage fix column from Part 2).

### A. Systemic (highest leverage — fixes the class)

**A1. Add an out-of-chain fitness dimension to every HIGH/MEDIUM eval.** The
standard shape (port from `idea-to-pdd-eval` / `ocs-chatbot-eval`): one
dimension, ≥20% weight, with **deduction and hard-gate power**, graded against a
"would a domain expert ship/use this?" bar that is **decoupled from the upstream
spec**. Critically, it must be *exempt from any deferral exemption* so that
upstream (PDD) thinness becomes a finding, not a free pass.

**A2. Give `opp-eval` one independent deployability probe.** A raw-artifact
LLM-as-Judge spot-check that reads the *actual* build/data/solicitation
artifacts (CCZ, generated records, published listing) and asks "would a Dimagi
expert ship this to a real LLO?" — and **hard-caps the run-level verdict** when
it disagrees with the rolled-up score. This breaks the loop at the funnel point.
Also: stop excluding `incomplete` from the mean in a way that hides thinness;
surface category-level "graded conformance only, fitness unmeasured" explicitly.

**A3. Fix the calibration methodology (`eval-calibration`).** Detection-rate
against an operator's known-issues catalogue can't surface a missing dimension.
Add a **coverage step**: for each artifact, enumerate the axes that separate
"conformant" from "deployable" (validation, fidelity, persistence, enforcement,
viability, resonance) and require the rubric to *have a dimension touching each*.
Use **Sarvesh's `[Final]` ITN builds as the ground-truth quality bar** for the
malaria-itn-app opp's calibration. Add a "negative control": a deliberately thin
build the rubric MUST score below pass.

**A4. Kill the inflation amplifiers.**
- Remove / invert the **"PDD-deferral exemption"** in `pdd-to-app-journeys-eval`
  + `pdd-to-test-prompts-eval` — deferred surfaces should be *flagged*, not
  exempted.
- Fix **`time_budget`** in `app-ux-eval` so "suspiciously fast / too few steps
  for the PDD scope" deducts (thinness signal), not just "too slow."
- Re-anchor **`tone_calibration_vs_cycle_grade`** (`learnings-summary-eval`) to
  an independent outcome signal, not cycle-grade's own number.

**A5. Promote the in-run gate.** Today the Phase 5→6 in-run gate is
`ocs-chatbot-eval --quick` (single 0–3 dim); the strong rubric only runs
out-of-band. Add a mid-tier that runs `correctness` + `refusal_correctness`
in-run. Likewise, `app-ux-eval`'s `capture_robustness` (A4) must run in the
in-`/ace:run` shallow pass, not only `/ace:qa-deep` — the ITN failure escaped
*because* the deep gate is out-of-band.

**A6. Update `_eval-template.md` contract.** Make A1 a *requirement*: "Every
eval MUST have ≥1 out-of-chain fitness dimension. A rubric whose every dimension
is satisfiable by an artifact that matches the upstream spec but is undeployable
does NOT meet the eval contract — that's QA's job, not eval's." Add the
predictive law (Part 1) as the authoring guide.

### B. Per-eval (see Part 2 "highest-leverage fix" column)

The 15 HIGH and 10 MEDIUM evals each get their named fix. The app evals are
top priority since they're the ITN locus:
- `pdd-to-deliver-app-eval` → `capture_fitness` + `case_persistence` +
  `data_quality_validation` + `localization_match` (hard-fail, not WARN).
- `pdd-to-learn-app-eval` → `assessment_gating` (enforcement) + item-granular
  `content_topic_coverage` + `localization_match` hard-fail.
- `app-ux-eval` → `capture_robustness` (negative-path AVD probe).

---

## Part 5 — Staged rollout (one PR per batch; merge before next)

Sequenced to (a) prove the pattern on the ITN locus first, (b) avoid colliding
with the open Phase 6 `connect-claim-opp.yaml` claim-flow blocker, and (c) keep
each PR small per the staged-PR convention.

| PR | Scope | Why first/last |
|---|---|---|
| **PR-1** | `_eval-template.md` contract (A6) + the predictive law as authoring guide | Defines the bar every later PR is measured against; pure doc, no behavior |
| **PR-2** | Build the malaria-itn-app calibration ground truth from Sarvesh's `[Final]` builds + a negative-control thin build (A3) | Gives every later eval PR an objective pass/fail it must hit |
| **PR-3** | `pdd-to-deliver-app-eval` + `pdd-to-learn-app-eval` fitness dims (B, app locus) | Highest-stakes; validated against PR-2 ground truth |
| **PR-4** | `app-ux-eval` `capture_robustness` + `time_budget` fix (A4) + promote to shallow gate (A5) | Catches hollowness at runtime, in-run |
| **PR-5** | `opp-eval` deployability probe + stop laundering (A2) | Closes the funnel; depends on PR-3/4 fitness signals existing |
| **PR-6** | Phase-2 deferral-exemption removal (A4) + `connect-*`/`work-order` fitness dims (B) | |
| **PR-7** | synthetic-* + training-* + solicitation-create fitness dims (B) | Broadest, lowest individual stakes |
| **PR-8** | Build-skill changes (Part 3 P0/P1) + reusable component library | Separate track from eval PRs; do after evals can *catch* regressions |

Build-side P0s (Part 3) can run in parallel as their own track, but land the
eval fitness dims *first* so the build improvements have a rubric that actually
grades them.

---

## Open decisions (carry-forward)

1. **Localization target** — ✅ **RESOLVED 2026-05-29:** build the core app in
   **English**, but **hard-fail the gate if the PDD names a working language and
   the translations for it were not also built.** English is always the
   authoring/primary language; the PDD working-language ships as a required
   translation layer. So `localization_match` is a **hard-fail dimension** (not a
   WARN): English-only build when the PDD named French = gate fail. Build skills
   (`pdd-to-learn-app`, `pdd-to-deliver-app`) author English first, then emit the
   translation set for the PDD working-language; `localization_match` fails if the
   translation set is missing or incomplete.
2. **Generic vs bespoke** — which Sarvesh choices become reusable components
   (validation, case-persistence, localization, GPS block — clearly generic) vs
   stay opportunity-specific hand-craft (single-vs-two-form deliver
   architecture)? ✅ **RESOLVED 2026-05-29:** the generic components are
   catalogued in `skills/_app-component-library.md` (GPS accuracy-capture,
   init-safe calculates, data-quality constraints, case-write-back,
   structured-capture, section-timestamps, embedded-BC-script, assessment-gate,
   localization-layer); the build skills emit them by name + trigger. Deliver
   form architecture and domain content stay opportunity-specific. Closes the
   PR-8 build-track component-library item.
3. **Fitness bar calibration source** — is Sarvesh's `[Final]` the canonical
   quality bar for *all* opps, or just malaria-itn-app? (Recommend: opp-specific
   ground truth, but the *dimension set* — validation/fidelity/persistence/
   enforcement — is universal.)

## Reusable lens for canopy

This defines a reusable improvement lens — **`eval-fitness`** (a.k.a.
conformance-vs-fitness): for any eval/judge in any plugin, ask "is the grading
anchor inside or outside the authoring chain?" Applicable beyond ACE to
canopy's own DDD/walkthrough judges.
