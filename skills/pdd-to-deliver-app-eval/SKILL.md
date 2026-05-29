---
name: pdd-to-deliver-app-eval
description: >
  Grade a Nova-built Deliver app against the PDD that specified it —
  field count, ordering, conditional logic, Connectify wiring.
disable-model-invocation: false
---

# PDD-to-Deliver-App Eval

The Deliver app is the most testable artifact ACE produces. This skill
grades it on **two axes**: (1) does the build match the PDD's stated
structure (count, order, conditional logic, gate, Connectify wiring) —
*conformance*; and (2) **is the build a deployable data-capture
instrument** — *fitness* — graded against an expert "would a CommCare
specialist ship this?" bar that is **decoupled from the PDD**.

The second axis is load-bearing and dominates the weight (55%). It
exists because conformance alone is the ITN failure mode: a faithful
build of a thin PDD (no input validation, plain geopoint instead of
accuracy-gated GPS, a follow-up form that writes nothing back to the
case, English-only when the PDD named French) matched its skeleton and
scored 9.6 — while being materially undeployable next to a human
expert's hand-finished build. See `skills/_eval-template.md § The
out-of-chain fitness requirement` and
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`.

Sibling rubric to `pdd-to-learn-app-eval`. See `skills/_eval-template.md`
for shared contracts (verdict shape, severity rules, stock blocks)
and `skills/eval-calibration/SKILL.md` for calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; archetype + Deliver App Specification + delivery unit drive expectation |
| Phase 3 | `3-commcare/pdd-to-deliver-app_summary.md` | Deliver-app structure summary (`nova_app_id`, forms, fields) |
| Nova MCP (optional) | `get_app({app_id: <nova_app_id>})` | authoritative field-by-field blueprint (recommended) |

## Products

- `3-commcare/pdd-to-deliver-app-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect HITL-pending stub.** If the deliver app summary contains
   any of:
   - `nova_app_id: null`, `nova_app_id: TBD`, or no `nova_app_id` at all
   - explicit status text marking the build as HITL-pending
     (e.g. "actual app JSON/CCZ not yet produced", "awaiting human
     completion", "HITL-pending", "stub-only")
   - the summary lists *only* placeholders/section names with no
     field-level structure (the "skeleton" shape Phase 3 emits before
     Nova finishes a build)

   then emit `verdict: incomplete` immediately with `[INFO] HITL-stub
   summary; no built app to grade against PDD spec`. Do NOT score zero
   or warn — like degraded mode in `connect-program-setup-eval`, this
   is a structural gap in the upstream environment, not a quality
   defect. Once Nova produces a real `nova_app_id` and field-level
   structure, the rubric becomes gradable. Surfaced 0.9.11 cross-opp
   validation: trying to grade a HITL-pending summary makes 2 of 5
   dimensions ungradable (field-order, conditional-logic) and inflates
   the others toward "looks fine" because there's nothing concrete to
   discriminate against.

3. **Extract the PDD's Deliver spec.** Parse the `## Deliver App
   Specification` section (or equivalent for `multi-stage`). Build a
   structured expectation:
   - Total field count (sum across all sections).
   - Section list with question count per section.
   - Question order (the LLO-spec'd numbering).
   - Required-yes consent gate location (which question, what semantics).
   - Conditional-display rules (e.g. "only shown if Q11 = yes").
   - Connectify Deliver Unit name and Entity ID composite formula.
   - Operational caps that should appear in form intro copy.

4. **Extract the built app's actual structure** from the Nova
   blueprint (or app summary). Build the matching structured snapshot.

5. **Grade across 9 dimensions** — 5 conformance (45%) + 4 fitness
   (55%). Each dimension is 0–10. Overall score is the weighted mean.

   **The fitness dimensions are graded against an external expert
   "would a CommCare data-capture specialist ship this instrument?"
   bar — NOT against the PDD.** If the PDD was silent on something a
   deployable instrument needs, that silence is a *finding against the
   build*, never an exemption (per `_eval-template.md` contract rule 3).
   Read the live Nova blueprint (`get_app`) for these — `validate`/
   `constraint` expressions, capture type (geopoint vs accuracy-gated),
   choice-list vs free-text, `case_property` writes on update forms, and
   itext/translation entries are all visible there.

   *Conformance axis (45% — does it match the PDD skeleton):*

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Field-count match** | 7% | Total field count matches the PDD's spec. **Split rule (0.9.1):** one PDD field implemented as parent + relevance-conditional child = one half-deviation (-0.5). **Sub-question rule:** a separate `_other` field for spec'd "free-text other" = zero deviation. ±1 net = 0.5 off; ±2+ = 2 off. |
   | **Question-order match** | 6% | Per-section order matches LLO numbering. 1-point deduction per out-of-order question, dimension floor 5.0. |
   | **Gate semantics match** | 14% | Required-yes consent gate present, in correct form-flow position, with correct branch behavior ("if no → refusal-reason + submit"). Missing gate ≤3. Wrong branch ≤4. |
   | **Conditional logic match** | 8% | Relevance/display-conditional fields ONLY (e.g. "Q12 shown iff Q11=yes"). Missing relevance condition = 2-point deduction; inverted = ≤3. (Capture-quality validation expressions are graded under `data_quality_validation`, not here.) |
   | **Connectify wiring** | 10% | (a) Deliver Unit name exact match; (b) Entity ID composite matches PDD formula (or sensible — market_name + GPS hash for atomic-visit); (c) required-for-credit fields (photo + GPS + consent) wired with relevant `validate` rules. |

   *Fitness axis (55% — is it a deployable instrument, graded vs expert bar):*

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Capture fitness** | 18% | Does the instrument capture *reliable, structured* data? Check, independent of the PDD: (a) **GPS** — where the PDD's evidence model specifies an arrival/location radius, GPS must be **accuracy-gated** (preferred/minimum accuracy thresholds, a capture-gate that rejects low-accuracy fixes, normalized lat/lon outputs) — a plain `geopoint` with only a text hint does **not** satisfy a stated radius; (b) **structured choices** — answers with an enumerable option set (who-sleeps-under-net, net-condition, risk groups) use single/multi-select, not free `text`; (c) **`other → specify`** — every "Other" option has a conditional free-text follow-up; (d) **bucketed numerics** where field-reliable (net age as `<1 / 1–2 / 3–4 / 5+ / don't know` rather than a raw int). **Hard-gate:** PDD specifies a GPS radius AND the build uses a plain geopoint with no accuracy enforcement → dimension **≤3**. ≥2 enumerable answers left as free-text → ≤4. |
   | **Data-quality validation** | 15% | Does the instrument *enforce* data quality? Graded vs what a deployable form should constrain, NOT vs the PDD: numeric bounds on counts (`household_size 1–30`), cross-field checks (`under_5 ≤ household_size`), phone-format regex where a phone field exists, char limits on free text, required `validate` on every credit-bearing field. **Hard-gate:** a data-capture instrument with near-zero validation (only a consent check + one range) → dimension **≤3**. Each whole class of missing constraint that a deployable build needs (counts unbounded, phone unformatted, free-text uncapped) = 1.5-point deduction. |
   | **Case persistence** | 14% | Do follow-up / case-update forms **write back the observations they capture**? A case-update form that captures new observations (retention, change, V2 readings) but writes **zero** case properties defeats its own purpose. **Hard-gate:** a case-update form that captures new user-facing observations and writes 0 case properties → dimension **≤2** (this is the exact ITN Visit-2 defect). **N/A rule:** single-form atomic-visit with no follow-up form has nothing to persist — score this dimension `null` and redistribute its weight proportionally across the other fitness dims (do NOT score it 10 — absence of the form isn't a win). |
   | **Localization match** | 8% | **HARD-FAIL dimension.** If the PDD names a working language other than English, the build must ship the **translation set** for it (labels, choices, hints, validation messages) on top of the English core. English authoring is fine; *missing or materially-incomplete translations are not.* **Hard-gate:** PDD names a working language AND the build is English-only (or the translation set is materially incomplete) → dimension **≤3 → suite `fail`.** **N/A rule:** PDD names no working language (English intervention) → score `null` and redistribute weight. (Resolves the open localization decision 2026-05-29: build the core in English, hard-fail if the named-language translations weren't also built.) |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean. (This now bites the fitness hard-gates: a build that
     conforms perfectly but has a plain-geopoint GPS against a stated
     radius, near-zero validation, a write-nothing V2, or missing
     required translations **fails** — it can no longer launder to 9.6.)
   - **`null` dimensions** (case_persistence / localization_match when
     N/A) are excluded from the weighted mean and their weight is
     redistributed proportionally across the scored dimensions.
   - **Inflation guard (0.9.1, mirrors `ocs-chatbot-eval`):** if the
     rubric surfaces ≥2 `[WARN]`-tier `auto_surfaced` entries, overall
     is capped at **8.5**.
   - 2+ dimensions in 4–6 range → suite verdict `warn`.
   - All scored dimensions ≥ 7 AND overall ≥ 7.5 → suite verdict `pass`.

6. **Write the verdict YAML** to
   `3-commcare/pdd-to-deliver-app-eval_verdict.yaml` using the shape
   from `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     # Conformance axis (45%) — matches the PDD skeleton
     field_count_match:        { weight: 0.07 }
     question_order_match:     { weight: 0.06 }
     gate_semantics_match:     { weight: 0.14 }
     conditional_logic_match:  { weight: 0.08 }
     connectify_wiring:        { weight: 0.10 }
     # Fitness axis (55%) — deployable instrument, graded vs expert bar
     capture_fitness:          { weight: 0.18 }
     data_quality_validation:  { weight: 0.15 }
     case_persistence:         { weight: 0.14 }   # null + redistribute when no follow-up form
     localization_match:       { weight: 0.08 }   # null + redistribute when PDD names no working language; HARD-FAIL otherwise
   ```

7. **Write the human-readable report** to
   `3-commcare/pdd-to-deliver-app-eval_report.md` summarizing each
   dimension's score, surfaced discrepancies (WARN/INFO table), and
   suggested Nova edits to bring the build into spec.

8. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[WARN]` for each user-facing field present in the build but not
     in the PDD spec.
   - `[INFO]` for hidden/computed fields added beyond spec (case_name,
     entity_id, etc.) — those are typical Nova decisions, not bugs.
   - `[BLOCKER]` for each fitness hard-gate that fired (plain geopoint
     vs stated radius; near-zero validation; write-nothing case-update
     form; missing required-language translations).
   - `[WARN]` for each enumerable answer left as free-text, each whole
     class of missing data-quality constraint, and each "Other" option
     with no specify follow-up.

## LLM-as-Judge Rubric

This rubric is **structural-first, semantic-second**. Most
discrepancies between PDD and built app are mechanical: count, order,
condition, name. The judge prompt should compute these
deterministically from the two snapshots before spending tokens on
"is this Connectify wiring sensible?" semantic judgments.

When invoking the LLM judge, seed the prompt with both snapshots in
structured form (parsed JSON or YAML), not the raw artifact text.
That way the judge spends its tokens on the comparison, not on
parsing the markdown.

**Calibration:** the rubric is calibrated against the
`eval-calibration` ground-truth catalogue. For
`smoke-20260428-1242`, known discrepancies the rubric MUST detect
are listed in
`ACE/smoke-20260428-1242/eval-calibration/known-issues.md` (the
Q8/Q8b split, the Q21b sub-question, the operational-caps
server-side note). Detection rate must be ≥ 80% on a calibration
run.

**Fitness-axis ground truth (added 2026-05-29):** the fitness
dimensions are calibrated against the malaria-itn-app pair —
the human expert's `[Final]` builds as the *deployable* bar and the
ACE run `20260528-1607` thin build as the *negative control*. The
negative control MUST score: `capture_fitness ≤3` (plain geopoint vs
a stated 100m radius), `data_quality_validation ≤3` (only a consent
check + confidence 1–5), `case_persistence ≤2` (Visit 2 writes no
case properties), `localization_match ≤3 → fail` (English-only vs a
French PDD). If the rubric scores the thin ITN build above `warn` on
any of these, the rubric is not yet calibrated. See
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades the single-form Deliver app against the PDD's Deliver Specification. |
| `focus-group` | Grades the FGD facilitation form (typically multi-section, attendance + per-domain summaries) against the PDD's session-form spec. The "consent gate" criterion shifts to the participant-consent script's location and semantics. |
| `multi-stage` | Run once per stage that has its own delivery work, branching on each stage's archetype. The stage-gate field is graded under `gate_semantics_match`. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus:
- Nova MCP: `get_app` (authoritative blueprint, recommended over the
  human summary alone)

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. Cross-artifact rubric: 5 dimensions (field_count_match, question_order_match, gate_semantics_match, conditional_logic_match, connectify_wiring). Calibrated against `eval-calibration/known-issues.md`. Template for future cross-artifact evals. | ACE team (eval system buildout) |
| 2026-04-29 | Added step-2 HITL-pending stub detection. If the deliver app summary has no `nova_app_id`, has `TBD`/`null`, is explicitly marked HITL-pending, or carries only skeleton structure, emit `verdict: incomplete` immediately. Surfaced 0.9.11 cross-opp validation against `turmeric-dogfood-20260427`: trying to grade a HITL-pending summary made 2 of 5 dimensions ungradable (field-order, conditional-logic) and inflated the others. The early-return pattern mirrors `connect-program-setup-eval`'s degraded-mode detection — both treat upstream environmental gaps as `incomplete`, not as quality defects. | ACE team (0.10.8) |
| 2026-05-05 | Step 7 report path migrated to `runs/<run-id>/3-commcare/pdd-to-deliver-app-eval_report.md` (was opp-level `eval-reports/YYYY-MM-DD-pdd-to-deliver-eval.md`). No methodology change. | ACE team |
| 2026-05-29 | **Fitness axis added (ITN post-mortem).** Reweighted the 5 conformance dims 100%→45% and added 4 out-of-chain fitness dims (55%): `capture_fitness` (0.18), `data_quality_validation` (0.15), `case_persistence` (0.14), `localization_match` (0.08, hard-fail). All four graded against an expert deployability bar decoupled from the PDD, with hard-gates that drop a faithful-but-undeployable build below `pass`. Was: a thin build that matched a thin PDD scored 9.6 (ITN run `20260528-1607`). Calibrated against the malaria-itn-app `[Final]` (deployable bar) + thin ACE build (negative control). Per `_eval-template.md § out-of-chain fitness requirement` + `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team |
