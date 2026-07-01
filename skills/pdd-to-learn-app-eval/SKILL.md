---
name: pdd-to-learn-app-eval
description: >
  Grade a Nova-built Learn app against the PDD that specified it —
  module count, order, Assessment Score wiring, content coverage.
disable-model-invocation: false
---

# PDD-to-Learn-App Eval

The Learn app is the FLW-training side of every ACE opp.
This skill grades it on **two axes**: (1) does the build match the
PDD's stated structure (module count, order, the Connect-readable
Assessment Score tag, topic presence) — *conformance*; and (2) **does
the app actually train and gate competence** — *fitness* — graded
against an expert "would you let an FLW into the field after this?"
bar, decoupled from the PDD.

The fitness axis dominates (55%) because conformance alone is the ITN
failure mode: a Learn app of label-only modules + one 5-question quiz,
no pre/post-test, no sequential unlock, no pass/retry enforcement, and
English-only when the PDD named French, *named* every PDD topic and
scored 9.6 — while teaching and gating nothing a human expert's build
did. The distinction this rubric now draws: *assessment presence* (a
score tag Connect can read) is conformance; *assessment enforcement*
(pre/post structure, sequential unlock, pass/retry) is fitness. *Topic
presence* is conformance; *teachable depth at item granularity* is
fitness. See `skills/_eval-template.md § The out-of-chain fitness
requirement` and `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`.

Sibling rubric to `pdd-to-deliver-app-eval`. Same calibration
methodology, different dimensions tuned to Learn-app concerns. See
`skills/_eval-template.md` for shared contracts.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; archetype + Learn App Specification drive expectation |
| Phase 3 | `3-commcare/pdd-to-learn-app_summary.md` | Learn-app structure summary (`nova_app_id`, modules) |
| Nova MCP (optional) | `get_app({app_id: <nova_app_id>})` | authoritative live blueprint (recommended over summary) |

## Products

- `3-commcare/pdd-to-learn-app-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect HITL-pending stub.** If the learn app summary contains
   any of:
   - `nova_app_id: null`, `nova_app_id: TBD`, or no `nova_app_id` at all
   - explicit status text marking the build as HITL-pending
     (e.g. "actual app JSON/CCZ not yet produced", "awaiting human
     completion", "HITL-pending", "stub-only")
   - the summary lists *only* module titles with no Connectify
     wiring detail or content-topic breakdowns (the "skeleton" shape
     Phase 3 emits before Nova finishes a build)

   then emit `verdict: incomplete` immediately with `[INFO] HITL-stub
   summary; no built app to grade against PDD spec`. Do NOT score zero
   or warn — this is a structural gap in the upstream environment, not
   a quality defect. Surfaced 0.9.11 cross-opp validation: trying to
   grade a HITL-pending Learn summary makes Assessment Score wiring
   (the most load-bearing dimension at 30%) entirely missing — and the
   ≤3 → fail rule then fires on a stub, not on a real defect.

3. **Extract the PDD's Learn spec.** Parse `## Learn App
   Specification`. Build a structured expectation:
   - Total module count (PDD-numbered, not counting bonus
     certification modules Nova may add).
   - Module list with title + estimated duration + content topics.
   - Connectify Assessment Score requirements: which module(s) emit
     a score, what the threshold is (e.g. 10/12 calibration, 8/10
     final MCQ), retake count.
   - Reference-photo / reference-content requirements (often
     placeholders the LLO populates).
   - Archetype-specific: for `focus-group` Learn, the "facilitation
     craft" content (probing techniques, neutral framing, group
     dynamics) is load-bearing.

4. **Extract the built app's actual structure** from the blueprint
   (or app summary). Build the matching snapshot.

5. **Grade across 8 dimensions** — 5 conformance (45%) + 3 fitness
   (55%). Each dimension is 0–10. Overall score is the weighted mean.

   **The fitness dimensions are graded against an external expert
   "would you let an FLW into the field after completing this app?"
   bar — NOT against the PDD.** PDD silence on a readiness gate or on
   content depth is a *finding against the build*, not an exemption
   (per `_eval-template.md` contract rule 3). Read the live Nova
   blueprint (`get_app`) — user-property reads/writes, module display
   conditions, form-level relevance, assessment item bodies, and itext
   translation entries are all visible there.

   *Conformance axis (45% — does it match the PDD skeleton):*

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Module-count match** | 7% | Total module count matches PDD spec. **Bonus-module rule (0.9.4):** a final `assessment-only` cert module with PDD content preserved verbatim = 10.0; either condition unmet = 9.0. Other additions/omissions = 1-point deduction per gap. |
   | **Module-order match** | 6% | Modules in PDD order (intro → flow → consent → photo → calibration → safety → vendor talk). 1-point deduction per swap, dimension floor 7.0. |
   | **Assessment Score wiring (presence)** | 12% | The Connectify Assessment Score is **tagged so Connect can read it** as the unlock gate, and the numerator/denominator match the PDD threshold (10/12, 8/10). Missing tag ≤3. Wrong threshold = 3-point deduction. **Platform-limitation rule (0.9.4):** an internal score documented as "informational-only" surfaces `[INFO]`, no deduction. (NOTE: this dimension grades that the score *exists and is readable*; whether the app *enforces* the gate is graded under `assessment_gating` below.) |
   | **Content-topic coverage (presence)** | 12% | Each PDD topic is *present* somewhere. **Placeholder rule (0.9.4):** LLO-localized content (reference photos, phone numbers) scores as present if the field is wired with correct structure. **Stub-answer-keys carve-out (0.9.4):** placeholder fields that are the *answer key* for a Connect Assessment gate do NOT score as present (0.5-point deduction each, cap 2). (NOTE: presence only; whether the content is actually *teachable* is graded under `instructional_depth`.) |
   | **Archetype coherence** | 8% | `atomic-visit`: teaches form-walkthrough + calibration + safety, NOT facilitation. **M7 reading (0.9.4):** FLW-reads-script-TO-vendor, not a facilitation pattern. `focus-group`: teaches facilitation craft. Wrong-archetype framing = 4-point deduction. |

   *Fitness axis (55% — does it train and gate competence, graded vs expert bar):*

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Assessment gating (enforcement)** | 22% | Does the app **enforce** readiness, not just expose a trivial score? **Architecture note:** in ACE, the Deliver-unlock gate is enforced *Connect-side* — Connect reads the assessment completion; ACE Learn forms carry NO case blocks (see `pdd-to-learn-app § REQUIRED — Learn forms must NOT carry <case> blocks`). So do NOT require in-app case-property sequential unlock — that would contradict the build architecture. Enforcement fitness means, independent of the PDD: (a) **pre-test + post-test** structure with distinct item banks, not a single quiz; (b) **adequate assessment coverage** — enough scored items to actually test the curriculum (roughly ≥1 item per module/major topic; 5 items for a 5-module course is too thin); (c) the score is a **percentage correctly wired to `connect.assessment` at the PDD threshold** so Connect gates Deliver on it; (d) a **pass/fail result experience in-app** — a result label whose relevance is conditional on `user_score >= threshold` (vs a separate fail/retry label), NOT an unconditional "Well done!" that fires regardless of score; (e) retry guidance for a failing FLW. **Hard-gate:** the PDD specifies a readiness gate AND the build is a single quiz with no pre/post split, trivial item count, AND an unconditional pass message → dimension **≤3**. A score tag Connect can read but that sits behind a single trivial quiz with an unconditional "Well done!" is presence, not enforcement → caps this dimension at 5. |
   | **Instructional depth** | 25% | Is each module actually *teachable*, at item granularity — not a label naming the topic? Check, independent of the PDD: (a) module bodies carry real instructional substance (steps, examples, do/don't, reference imagery placeholders correctly typed), not one-line labels; (b) assessment items are non-trivial and **anti-guess** (plausible distractors, not "pick the obviously-correct option"); (c) citations / source references where the domain calls for them (WHO, PMI, etc.). **Hard-gate:** modules are label-only with no teachable substance → dimension **≤3**. **Mid-tier cap (added 2026-05-29 from ITN validation):** decent expository prose is necessary but NOT sufficient for a deployable training instrument. When modules carry teaching prose but lack pedagogical scaffolding — specifically ALL THREE of: (i) no worked examples or do/don't pairs, (ii) no domain citations where the source material cites them (WHO/PMI/GiveWell), AND (iii) fewer than 2 assessment items per taught module (the ITN build has 1 quiz item per module vs the expert `[Final]`'s 10-item pre-test + 10-item post-test) — cap this dimension at **4.0**. Each module that merely *names* its topic without teaching it = 1.5-point deduction. (This is the item-granular replacement for the old "topic present = covered" reading.) |
   | **Localization match** | 8% | **HARD-FAIL dimension.** If the PDD names a working language other than English, the build must ship the **translation set** for it (labels, choices, hints, assessment items) on top of the English core. **Hard-gate:** PDD names a working language AND the build is English-only (or the translation set is materially incomplete) → dimension **≤3 → suite `fail`.** **N/A rule:** PDD names no working language → score `null` and redistribute weight. (Resolves the 2026-05-29 localization decision: English core, hard-fail if named-language translations weren't also built.) |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean. (Now bites the fitness hard-gates: a Learn app that
     names every PDD topic but is label-only, ungated, and un-localized
     **fails** — it can no longer launder to 8.5+.)
   - **`null` dimensions** (localization_match when N/A) are excluded
     from the weighted mean; weight redistributed proportionally.
   - **Inflation guard (mirrors OCS / deliver-app rubrics):** if the
     rubric surfaces ≥2 `[WARN]`-tier `auto_surfaced` entries,
     overall is capped at **8.5** regardless of per-dimension math.
   - **Pre-cap and post-cap reporting (added 0.9.4):** the verdict
     YAML's `overall_score` is the post-cap value. Add a sibling
     `overall_score_pre_cap` field showing the raw weighted mean.
     This is essential for the Learn rubric specifically because
     the cap binds on every Learn build today (every build has 3+
     placeholder WARNs by design — M4 photos, M5 calibration, M6
     phone numbers). Without pre-cap reporting the variance
     protocol collapses to 0.00 post-cap and we lose visibility
     into the underlying judge discretion.

5b. **Standing-instruction hard-gates (binary, non-weighted).** Pass/fail
   conformance checks on the standing app-build instructions (see
   `skills/_app-component-library.md`). These are NOT weighted dimensions —
   they never enter the weighted mean — but a violation surfaces `[BLOCKER]`
   and forces suite verdict `fail`, exactly like a dimension ≤3. Both are
   readable straight from the Nova blueprint (confirmed applied by the
   2026-06-25 builds).

   - **`naming_convention`** — the app's display name MUST contain the words
     "Learn app". Read the name via `get_app`. Absent → `[BLOCKER]` → `fail`.
   - **`form_navigation`** — EVERY form's post-submit navigation MUST be
     "Previous Screen" (`postSubmit: "previous"`). Read each form via
     `get_form`. Any form not `previous` → `[BLOCKER]` → `fail`.

   *Not enforced here (deferred to the post-build HQ step per
   `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`):*
   `grid-menu-display` and the `assessment-display-lifecycle` Display
   Conditions are not representable in the Nova blueprint, so this rubric
   cannot read them yet.

6. **Write the verdict YAML** to
   `3-commcare/pdd-to-learn-app-eval_verdict.yaml` using the shape from
   `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     # Conformance axis (45%) — matches the PDD skeleton
     module_count_match:        { weight: 0.07 }
     module_order_match:        { weight: 0.06 }
     assessment_score_wiring:   { weight: 0.12 }   # presence of a Connect-readable score tag
     content_topic_coverage:    { weight: 0.12 }   # topic presence
     archetype_coherence:       { weight: 0.08 }
     # Fitness axis (55%) — trains + gates competence, graded vs expert bar
     assessment_gating:         { weight: 0.22 }   # enforcement: pre/post, sequential unlock, pass/retry
     instructional_depth:       { weight: 0.25 }   # item-granular teachable content + anti-guess items
     localization_match:        { weight: 0.08 }   # null + redistribute when PDD names no working language; HARD-FAIL otherwise
   ```

7. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall is below 7.0.
   - `[WARN]` for each placeholder-content gap that the LLO MUST
     fill before deploy (reference photos, phone numbers, market
     list). These don't fail the eval but do gate live deployment.
   - `[WARN]` for each Assessment Score wiring deviation (wrong
     threshold, missing tag, score path that Connect can't read).
   - `[INFO]` for each defensible Nova structural addition (e.g. the
     bonus final-cert module split).
   - `[BLOCKER]` for each fitness hard-gate that fired (no enforcement
     machinery on a PDD-specified readiness gate; label-only modules;
     missing required-language translations).
   - `[BLOCKER]` for each standing-instruction hard-gate that fired
     (`naming_convention`: display name lacks "Learn app"; `form_navigation`:
     a form's post-submit navigation is not "Previous Screen").
   - `[WARN]` for each module that names its topic without teaching it,
     and for an Assessment Score that Connect can read but the app never
     enforces internally.

## LLM-as-Judge Rubric

Calibration target on the smoke-20260428-1242 Learn build:

- **Detection rate:** ≥ 80% of catalogued Learn-build issues from
  `eval-calibration/known-issues.md § Learn app build`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Score reflects defects:** a build with placeholder content that
  blocks live deployment (every Learn app today, until the LLO
  populates) should NOT score in the 9+ band. Placeholder-WARN flags
  should bring overall into the 8.0–8.7 range.

**Fitness-axis ground truth (added 2026-05-29):** calibrated against the
malaria-itn-app pair — the human expert's `[Final]` Learn build
(pre-test + post-test, 80% threshold enforced via user properties,
sequential module unlock, pass/retry, bilingual) as the *deployable*
bar, and ACE run `20260528-1607`'s thin Learn build (4 label-only
modules + one 5-Q quiz, no gating, English-only) as the *negative
control*. The negative control MUST score: `assessment_gating ≤3`
(no enforcement machinery), `instructional_depth ≤4` (via the mid-tier
cap — the ITN build has real prose but no worked examples, no domain
citations in module bodies, and only 1 quiz item per module; the
label-only hard-gate does NOT apply), `localization_match ≤3 → fail`
(English-only vs French PDD). If the rubric scores the thin ITN Learn
build above `warn`, it is not yet calibrated. Validated 2026-05-29: the
revised rubric scores it `fail` (assessment_gating 2.0, localization
2.0, depth ≤4 via mid-tier cap). See
`docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades form-walkthrough + calibration + safety against PDD spec. |
| `focus-group` | Grades facilitation-craft training: probing techniques, neutral framing, group dynamics, question-guide walkthrough. The PDD's Facilitation Protocol is load-bearing here; cross-checks live in archetype_coherence dimension. |
| `multi-stage` | One Learn-app verdict per stage. Each verdict grades against the stage's own archetype branch. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus:
- Nova MCP: `get_app` (authoritative blueprint, recommended)

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: module_count_match (0.15), module_order_match (0.10), assessment_score_wiring (0.30 — most load-bearing), content_topic_coverage (0.25), archetype_coherence (0.20). Mirror of pdd-to-deliver-app-eval. Inflation guard at 8.5 when ≥2 WARN auto_surfaced. | ACE team (eval system buildout — 0.9.2) |
| 2026-04-29 | Added step-2 HITL-pending stub detection. If the learn app summary has no `nova_app_id`, has `TBD`/`null`, is explicitly marked HITL-pending, or lists only module titles without Connectify wiring or content-topic detail, emit `verdict: incomplete` immediately. Without this guard the rubric's most load-bearing dimension (assessment_score_wiring at 30%) graded a stub as "wiring entirely missing" → forced ≤3 → fail, on a build that wasn't actually a defect. Mirrors the deliver-app-eval HITL guard. | ACE team (0.10.8) |
| 2026-05-29 | **Fitness axis added (ITN post-mortem).** Reweighted the 5 conformance dims 100%→45% and split conformance from fitness: `assessment_score_wiring` 30%→12% (presence of a Connect-readable score tag only), `content_topic_coverage` 25%→12% (topic presence only). Added 3 out-of-chain fitness dims (55%): `assessment_gating` (0.22 — enforcement: pre/post, sequential unlock via user properties, pass/retry), `instructional_depth` (0.25 — item-granular teachable content + anti-guess items), `localization_match` (0.08, hard-fail). All graded vs an expert deployability bar with hard-gates. Was: a label-only, ungated, English-only Learn app that named every PDD topic scored 9.6 (ITN run `20260528-1607`). Calibrated against the malaria-itn-app `[Final]` (deployable bar) + thin ACE build (negative control). Per `_eval-template.md § out-of-chain fitness requirement`. | ACE team |
