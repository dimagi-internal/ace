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
   | **Instructional depth** | 17% | Is each module actually *teachable*, at item granularity — not a label naming the topic? Check, independent of the PDD: (a) module bodies carry real instructional substance (steps, examples, do/don't, reference imagery placeholders correctly typed), not one-line labels; (b) *(moved 2026-07-27)* item quality is now scored by **`assessment_discrimination`** via an executed probe — do NOT also grade it here; this dimension keeps only the item-COUNT-per-module element in the mid-tier cap below; (c) citations / source references where the domain calls for them (WHO, PMI, etc.). **Hard-gate:** modules are label-only with no teachable substance → dimension **≤3**. **Mid-tier cap (added 2026-05-29 from ITN validation):** decent expository prose is necessary but NOT sufficient for a deployable training instrument. When modules carry teaching prose but lack pedagogical scaffolding — specifically ALL THREE of: (i) no worked examples or do/don't pairs, (ii) no domain citations where the source material cites them (WHO/PMI/GiveWell), AND (iii) fewer than 2 assessment items per taught module (the ITN build has 1 quiz item per module vs the expert `[Final]`'s 10-item pre-test + 10-item post-test) — cap this dimension at **4.0**. Each module that merely *names* its topic without teaching it = 1.5-point deduction. (This is the item-granular replacement for the old "topic present = covered" reading.) |
   | **Assessment discrimination** | 5% | **Can the assessment tell a trained worker from an untrained one?** Scored from an **executed two-reader contrast** — see § The discrimination probe below, which is MANDATORY and whose per-item table MUST appear in the verdict. **The statistic is the delta, never one reader's level:** `discrimination_delta = (trained_correct − untrained_correct) ÷ items_scored`, where both readers run the **PDD's own FLW persona** and differ ONLY in whether they were handed the module teaching text. **Bands: ≥0.40 → 9–10 · 0.30–0.39 → 7–8 · 0.20–0.29 → 5–6 · <0.20 → ≤3 → suite `fail`.** A bank that does not move when you teach the curriculum is not measuring the curriculum — and that is true at ANY absolute level: trained 95 / untrained 60 is an excellent instrument, trained 90 / untrained 88 is a broken one. **Why a contrast (2026-08-12, ace#1187).** This dimension scored the *absolute* cold score of a blind LLM reader until 2026-08-12, and hard-gated on it. Measured on `spark-facilitator/20260810-0737` (Learn app `34a66bf7-9b48-40ef-aa56-31ac357e8a72`, same 20-item bank, keys withheld, picks committed before reveal): trained field persona **19.0/20**, untrained field persona **8.0/20**, untrained M&E-domain-expert persona (*the reader the old rubric briefed*) **11/20**. The expert proxy sat **15pp above** the population the Deliver gate protects and made the bank look **27% less discriminating than it is** (A−C = 8.0 vs the true A−B = 11.0) — and its edge over the field reader was **stability, not knowledge** (it reliably nailed q2/q3/q11/q14, which the field reader got right about half the time, and *lost* q5 and q20 to it). So the old number measured consistency of exam technique on a reader who already knows the domain: an untrained-reader level cannot separate "bad test" from "test of things a knowledgeable reader already knows", and driving it down means writing items that are arbitrary rather than sensible. Two prior authoring passes (~500K subagent tokens) were spent chasing it on a bank that measures **2.38x** discrimination. **Deductions, each 1 point:** (a) any item whose distractors are all absurd (the "one virtuous option + N absurd options" shape), capped at 2 — this is a Gate-1 item defect, not a typography quibble; (b) a teaching example or practice item referencing a question **absent from the instrument** the Deliver app implements (`instrument-grounded-examples`); (c) items that test generic professional-ethics sentiment rather than program specifics. **Structural tells are REPORTED, not deducted (revised 2026-08-12, ace#1187):** `self-justifying-key`, `minimal-claim`, `odd-one-out-binary` must still be recorded per-item in the probe table and each surfaces a `[WARN]`, but they no longer carry a deduction — they are option-craft hygiene, and the measured evidence is that option-craft does not by itself create or destroy discrimination. The delta is the evidence; do not re-litigate it with adjectives. **Item independence:** if item N's answer is derivable from item N-1's, note it — a metric assuming N independent items overstates the bank's resolution. **Coverage:** run the probe on the pre-test bank as well as the post-test and report a block per instrument; a hardened post-test over an untouched pre-test makes the PDD's pre/post learning-gain metric overstate the gain, and both banks' deltas must be reported even though the post-test (the gating instrument) drives the score. **Hard-gate — the untrained FIELD reader clears the real gate:** `untrained_correct ÷ items_scored × 100 >= the PDD's Deliver-unlock threshold` → dimension **≤3 → suite `fail`**. This is a direct measurement of the protected population, NOT the retired expert-ceiling proxy: if the elected community member the 80% gate exists to stop passes it cold, the gate is decorative, and shipping it is worse than shipping no gate because it launders an unqualified worker into the field. Compute against the *actual* threshold in the PDD, not the 80% default. **Low-n rule (closes ace#1042):** when `items_scored < 5` the delta is degenerate (at n=1 it can only be −1.0, 0 or 1.0, so the outcome is fixed by the item count before the app is built) → score **`null`** and redistribute, surface a `[WARN]` naming the PDD-mandated item count, and **fire no hard-gate** — a builder cannot author its way out of an instrument the PDD dictates. **Scope (ace#1187):** the Learn assessment is a **readiness** check, not an anti-fraud device. Fraud is the Evidence Model's job — required live photo, GPS, the payment predicate, Partner Trainer observation on a sample. Do NOT deduct here for the bank failing to be adversarially robust against a motivated cheat; that is a property it was never designed to have. **N/A rule:** app has no scored assessment (PDD specifies no gate) → score `null` and redistribute. |
   | **Assessment operation coverage** | 3% | **Does the bank test the operations that actually cost something when they go wrong?** (Added 2026-08-12, ace#1187 — a bank covering every high-consequence operation is doing its job whether or not any reader could pass it cold, and this is the dimension that says so.) Enumerate the **high-consequence operations** from the Deliver app blueprint + the PDD: every instrument field or step whose mishandling causes (i) an **unpaid visit** (wrong `meeting_type`, missing required evidence, wrong payment predicate), (ii) a **blocked form** (a constraint the worker will hit in the field — participants > attendees, out-of-range threshold), or (iii) **corrupted data** (blank-vs-zero on a numeric, a free-text field where a coded one was meant, a date entered in the wrong convention). Then map **each scored item → the instrument field it governs and the failure it prevents**, and report the mapping in the probe block's `operation_coverage` table. Score = fraction of high-consequence operations carrying ≥1 keyed item: **≥0.90 → 9–10 · 0.70–0.89 → 7–8 · 0.50–0.69 → 5–6 · <0.50 → ≤3 → suite `fail`**. An item that maps to **no** operation is not a defect on its own (conceptual/consent items earn their place) but report it as `operation: none` — if more than half the bank maps to nothing, that IS the finding and it caps this dimension at **5**. **Hard-gate:** a majority of high-consequence operations carry **zero** items → dimension **≤3 → suite `fail`**. **N/A rule:** no scored assessment, or the PDD specifies no Deliver instrument to protect → score `null` and redistribute. |
   | **Localization match** | 8% | **HARD-FAIL dimension.** If the PDD names a working language other than English, every user-facing string (module names, form names, labels, choices, hints, assessment items and their option labels) must carry its named-language counterpart. **Grade COVERAGE, not MECHANISM (revised 2026-07-30, ace#968).** Nova exposes **no per-language / locale / itext channel on any tool** (re-confirmed 2026-07-31 across all 63 live tools; `update_app` now carries only `name`), so per-language itext is *unreachable* and its absence is NOT a defect. Three distinct states: (a) **complete coverage authored inline** (each string carries English + each named language in one label) → this is the **documented, sanctioned fallback** per `_app-component-library.md § localization-layer`; score it on coverage exactly as if it were itext, no mechanism deduction, and surface `[INFO]` recording that the inline mechanism was used; (b) **materially incomplete coverage** (some strings translated, others English-only) → **≤3 → suite `fail`**; (c) **English-only** → **≤3 → suite `fail`**. **Do not false-fail the two permitted degradations:** option labels identical across all named languages (district names, facility names, other proper nouns) correctly stay BARE, and short strings with no room for stacked paragraphs correctly use the compact `English / Lang2 / Lang3` slash form — neither counts as missing coverage. **`[WARN]` (not a deduction)** when the PDD carries a low-literacy / low-education design constraint AND the build stacks N languages inline: that multiplies every label's reading load for the cohort the PDD singles out, and it is a real product tension a human should see — but it is the sanctioned mechanism, so it does not reduce the score. **N/A rule:** PDD names no working language → score `null` and redistribute weight. (Resolves the 2026-05-29 localization decision: English core, hard-fail if named-language coverage wasn't also built. Supersedes the "via itext" mechanism wording, which instructed something unbuildable.) |

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
     `get_form({app_id, moduleUuid, formUuid})`. Any form not `previous`
     → `[BLOCKER]` → `fail`.

   **Addressing note (ace#1132).** Nova is uuid-addressed since
   2026-07-31 — no tool accepts `moduleIndex` / `formIndex` / `fieldId`.
   Get the uuids from the summary's `nova_uuids:` frontmatter block if
   the build wrote one, otherwise from ONE `get_app({app_id})` (its
   blueprint prints `[uuid …]` on every module, form, and field);
   `search_blueprint({query, app_id})` resolves a single semantic name.
   Do this once at the top of the run and reuse the map for every read
   below — including the § 5c probe harness.

   *Not enforced here (deferred to the post-build HQ step per
   `docs/superpowers/specs/2026-06-25-post-build-hq-settings-automation.md`):*
   `grid-menu-display` and the `assessment-display-lifecycle` Display
   Conditions are not representable in the Nova blueprint, so this rubric
   cannot read them yet.

5c. **The discrimination probe (MANDATORY — scores `assessment_discrimination`
   and `assessment_operation_coverage`).**

   **Why this is a probe and not a criterion.** Before 2026-07-27 this rubric
   already required assessment items to be "anti-guess (plausible distractors,
   not 'pick the obviously-correct option')" as sub-criterion (b) of
   `instructional_depth`. It scored `hh-poverty-targeting/20260722-1341` at
   **9.4/10** on a 10-item bank where EVERY item was one virtuous answer plus
   three absurd distractors, and a domain expert caught it on first read
   (ace#981). The criterion was true, well-worded, and inert: judging "are these
   anti-guess?" while looking at the answer key invites the judge to confirm the
   key is defensible. So the rubric no longer asks for a judgment — it asks for a
   **result you have to produce by doing the work**.

   **Why it is a CONTRAST and not a ceiling (ace#1187 — read this before
   running it).** From 2026-07-27 to 2026-08-12 the probe ran ONE reader, scored
   its absolute cold total, and hard-gated on it. That reader was briefed as a
   capable adult with strong exam technique, and in practice carried deep
   background in CommCare, M&E and programme design. The population the Deliver
   gate exists to protect is an **elected community member in rural Malawi** —
   limited formal schooling, working in a second or third language, first
   smartphone, no M&E background. Both errors ran the same direction: the expert
   proxy overstated the guess floor by **15pp** (55% vs the field reader's 40%)
   AND understated discrimination by **27%**. Discrimination is a contrast —
   trained minus untrained — and an untrained reader's LEVEL cannot distinguish
   "bad test" from "test of things a knowledgeable reader already knows".
   Chasing the level down means writing items that are arbitrary rather than
   sensible, which makes the instrument **worse**. So: run two readers, score
   the gap.

   **The harness note that makes this runnable (ace#1014).**
   `get_form({app_id, moduleUuid, formUuid})` returns stems, option labels
   **and** the `qN_score` calculates in ONE atomic payload — there is no call
   that fetches items without the key (`get_field` is uuid-addressed and
   per-field, so it cannot fetch a stem without you already knowing which
   field you want, and it returns that field's calculate too). So a single-agent
   self-probe is **contaminated by construction**: step 1's "do not read the
   calculates yet" is not enforceable by the reader who already has them on
   screen, and what gets measured is the author's intent rather than the item's
   difficulty. The workable shape, and the one this rubric requires:

   - **Dispatch SEPARATE agents** that receive ONLY the stems + option labels
     (plus, for the trained reader, the module teaching text). Never the
     calculates, never the answer key, never the build memo.
   - Give each agent an **independently permuted** option set under **neutral
     labels** (`A/B/C/D` reassigned per agent), so a shared position bias cannot
     masquerade as a shared read.
   - Require every pick to be **committed in writing** before any mapping back
     to the key. Two independent permutations producing *different* miss sets is
     weak evidence against permutation leakage; identical miss sets across
     permutations is the strong signal.
   - Verify the key against the live `qN_score` calculates, **not** against a
     stated correct-answer distribution in a build memo.

   **Derive the FLW persona from the PDD — do not improvise it, and do not use a
   domain expert (ace#1187).** Before dispatching anything, read out of the PDD:
   formal schooling level, the working language and whether it is the cohort's
   first, prior data-collection / M&E experience, and smartphone familiarity.
   Both readers get that SAME persona verbatim. A reader briefed as "a capable
   adult with strong exam technique" is the retired proxy that caused this
   rubric's two-cycle false failure — it measures an LLM domain-expert ceiling,
   not the field.

   Run this on the post-assessment (the gating instrument) **and** on any
   pre-assessment — report a block per instrument:

   1. **Extract the item bank.** For each scored item, pull the stem and the
      option labels. Do NOT read the `*_score` calculates yet — those are the
      answer key, and seeing them contaminates the probe. If you cannot separate
      them (see the harness note above), dispatch the blind agents rather than
      probing in-context.
   2. **Reader B — untrained, field persona.** Given the stems + options and the
      PDD-derived FLW persona, and **nothing else**: no teaching content, no
      module text, no PDD body. For each item, pick what that persona would pick
      and record WHY in ≤10 words ("only non-abusive option", "genuinely 50/50
      without training"). **Run B at least TWICE**, each run with an
      independently reshuffled option order, and use the **mean** — B is the
      noisy reader (the ace#1187 measurement saw 6 and 10 across two runs of the
      same bank; A was 19 and 19). Report every run, not just the mean.
   2a. **Reader A — trained, same field persona.** Identical persona, identical
      stems and options, **plus the five modules' teaching text**. Still blind to
      the key. One run suffices when the two B runs agree closely; run A twice
      whenever B's runs diverge by more than 2 items, so the delta isn't read off
      a single draw on either side.
   2b. **Audit the option SET for structural tells** — self-justifying key,
      minimal-claim key, odd-one-out on a binary, any option rejectable on
      sight. Record them per item, from the blind view, before the key is
      revealed, including on items neither reader missed. These are **reported,
      not deducted** (ace#1187) — except `absurdity-elimination`, which is a
      Gate-1 item defect and still deducts.
   3. **Now read the answer key** and mark, per item, `trained_correct` and
      `untrained_correct`.
   4. **Compute the statistic.**
      `discrimination_delta = (trained_correct − untrained_correct) ÷ items_scored`,
      using B's mean. Also record `untrained_ratio = untrained_correct ÷
      items_scored` — that is what the untrained-field-reader hard-gate is
      computed against, and it is worth knowing on its own (40% in ace#1187,
      against a 25% four-option chance floor).
   4b. **Report the effective bar — the free items.** Count the items **both**
      readers got right in every run (`free_items`): answerable from arithmetic
      or from the stem's own framing, carrying no signal about training.
      `signal_carrying_items = items_scored − free_items`, and the PDD's
      unlock threshold expressed over those is the **effective bar**. In
      ace#1187, 5 of 20 items were free, so a 16/20 gate is really **11 of 15
      signal-carrying items = 73%**, not 80%. This falls straight out of a
      contrast design and is invisible to an absolute-ceiling probe; it is
      genuinely useful for gate placement, so always report it.
   4c. **Build the operation-coverage map** (scores
      `assessment_operation_coverage`): enumerate the high-consequence
      operations from the Deliver blueprint + PDD, then map each item to the
      instrument field it governs and the failure it prevents.
   5. **Emit the per-item table into the verdict** (this is the auditable
      artifact — an `assessment_discrimination` score with no table is an
      incomplete eval, and a reviewer should reject it):

   ```yaml
   assessment_discrimination_probe:
     instrument: post_assessment          # repeat the block per assessment form
     harness:
       persona_source: pdd                # schooling, language, prior M&E experience
       persona_summary: "elected community member, primary schooling, Chichewa first language, first smartphone, no M&E background"
       trained_runs: 1                    # reader A — same persona + module teaching text
       untrained_runs: 2                  # reader B — same persona, no teaching content
       options_permuted: true             # independently permuted neutral labels per run
       picks_committed_before_reveal: true
       key_source: qN_score_calculates    # never a stated distribution in a memo
     items_scored: 20
     trained_correct: 19.0                # reader A, mean across runs
     untrained_correct: 8.0               # reader B, mean across runs [6, 10]
     untrained_ratio: 0.40                # vs a 0.25 four-option chance floor
     discrimination_delta: 0.55           # (19.0 - 8.0) / 20 → band >= 0.40
     unlock_threshold: 80                 # from the PDD; gate is on untrained_ratio
     free_items: 5                        # both readers correct in every run
     signal_carrying_items: 15
     effective_bar: "11 of 15 signal-carrying items = 73% (nominal gate 16/20 = 80%)"
     verdict: pass
     items:
       - id: q6
         untrained_pick: b
         untrained_reason: only option that isn't coercive
         trained_pick: b
         correct: b
         untrained_correct: true
         trained_correct: true
         free_item: true
         operation: "meeting_type"
         prevents: unpaid-meeting
         structural_tells: [absurdity-elimination]
       - id: q3
         untrained_pick: a
         untrained_reason: sounds like how a survey works
         trained_pick: b
         correct: b
         untrained_correct: false
         trained_correct: true
         free_item: false
         operation: "participants_count"
         prevents: blocked-form
         structural_tells: []
       - id: q7
         untrained_pick: c
         untrained_reason: key claims least, others add behavior
         trained_pick: c
         correct: c
         untrained_correct: true
         trained_correct: true
         free_item: true
         operation: none
         prevents: null
         structural_tells: [minimal-claim, self-justifying-key]
     operation_coverage:
       high_consequence_operations: 8     # from the Deliver blueprint + PDD
       covered: 7                         # carrying >= 1 keyed item
       ratio: 0.875
       uncovered: ["savings_amount blank-vs-zero"]
   ```

   Permitted `structural_tells` values: `self-justifying-key`,
   `minimal-claim`, `odd-one-out-binary`, `absurdity-elimination`. Record
   `derived_from: qN` on any item whose answer follows from an earlier item.

   **Calibration anchor (negative control).** The `hh-poverty-targeting`
   `20260722-1341` post-assessment is the canonical FAIL — a 10-item bank of one
   virtuous answer plus three absurd distractors. Any rubric revision must still
   score that bank ≤3 on this dimension, and under the contrast statistic it
   fails on **three** independent paths: the untrained field reader clears the
   80% unlock threshold cold (hard-gate), the trained reader has almost nothing
   left to add so the delta collapses below 0.20 (band → ≤3), and every item
   carries `absurdity-elimination` (deduction, capped at 2). If a future judge
   scores it above 3, the probe has been weakened — treat that as a rubric
   regression, not a judge disagreement.

   **Second anchor — option-craft is not the lever (ace#1014,
   `spark-facilitator/20260730-1718`, Learn app
   `38836b2d-0405-4e99-879a-53cd2344eff9`).** The same 12-item bank was
   re-authored twice and re-probed against the OLD single-expert-reader harness:
   as built 12/12; after full typography normalization 10/12; after deliberate
   virtue-inversion 9/12 and 10/12. q5's four options were exactly uniform at
   65/65/65/65 characters and were still answered correctly cold, and 7 of 10
   hits fell to general professional competence rather than any structural tell.
   Retained as a calibration fact about **authoring**, not about scoring: a judge
   that credits typography normalization or virtue-inversion as evidence of
   discrimination is miscalibrated, and so is one that *penalises* their absence.
   Note what ace#1187 later showed about these three passes — the reader was the
   confound, so the plateau is not evidence the banks failed to improve. Re-judge
   them on the delta before drawing any conclusion from those numbers.

   **Third anchor — the contrast (ace#1187, `spark-facilitator/20260810-0737`,
   Learn app `34a66bf7-9b48-40ef-aa56-31ac357e8a72`).** Same 20-item bank, keys
   withheld, picks committed before reveal, each untrained reader run twice with
   per-question shuffled option order:

   | Reader | Brief | Correct/20 | Ratio |
   |---|---|---|---|
   | **A — trained, field persona** | given the five modules' teaching text; CBF persona | **19.0** | 0.95 |
   | **B — untrained, field persona** | no teaching content; same CBF persona | **8.0** (6 and 10) | 0.40 |
   | **C — untrained, M&E domain expert** | the RETIRED reader | 11 | 0.55 |

   `discrimination_delta` = (19.0 − 8.0) ÷ 20 = **0.55** → top band, **pass**
   with named item-level residuals. The old rubric returned `2.0` on this bank
   and failed the phase. A judge that fails this bank has reintroduced the
   ceiling measurement. Note also that C's edge over B is **stability, not
   knowledge**: C reliably nailed q2/q3/q11/q14, which B got right about half the
   time, and C *lost* q5 and q20 to B.

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
     instructional_depth:       { weight: 0.17 }   # item-granular teachable content (item QUALITY moved to assessment_discrimination 2026-07-27)
     assessment_discrimination: { weight: 0.05 }   # MANDATORY two-reader contrast (trained - untrained, both on the PDD's FLW persona); null + redistribute when no scored assessment or items_scored < 5; HARD-FAIL delta < 0.20 OR untrained_ratio >= the PDD unlock threshold
     assessment_operation_coverage: { weight: 0.03 }   # items mapped to the high-consequence operations they protect; null + redistribute when no scored assessment
     localization_match:        { weight: 0.08 }   # null + redistribute when PDD names no working language; HARD-FAIL on English-only or incomplete coverage (inline coverage = the sanctioned mechanism, full credit)
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
     missing or materially-incomplete required-language coverage).
   - `[BLOCKER]` when `untrained_ratio × 100 >= the PDD's Deliver-unlock
     threshold` — the **untrained field reader** clears the real gate, so the
     gate is decorative (ace#1187). Never compute this against a domain-expert
     reader; that proxy is retired.
   - `[WARN]` for each structural tell recorded in the probe table
     (`self-justifying-key`, `minimal-claim`, `odd-one-out-binary`). These are
     option-craft hygiene worth a human's eye and are **not** deductions
     (ace#1187) — the delta is the evidence. `absurdity-elimination` still
     deducts, per the dimension row.
   - `[WARN]` when the pre-test bank's `discrimination_delta` is materially
     below the post-test's — the PDD's pre/post learning-gain metric will
     overstate the gain.
   - `[WARN]` reporting `free_items` and the resulting **effective bar** —
     items both readers answered correctly in every run carry no training
     signal, so the nominal unlock threshold overstates the real bar (16/20 =
     80% nominal was 11/15 = 73% effective in ace#1187). This is gate-placement
     information for a human, not a defect.
   - `[WARN]` when `items_scored < 5` — the delta is degenerate at that item
     count and the dimension scored `null`; name the PDD-mandated count, since
     no authoring choice available to the builder can change it (ace#1042).
   - `[BLOCKER]` when a majority of high-consequence operations carry zero
     scored items (`assessment_operation_coverage` hard-gate).
   - `[INFO]` recording the localization MECHANISM used (inline
     multilingual labels — the sanctioned fallback, since Nova exposes no
     per-language itext channel, ace#968). Mechanism is never a deduction;
     coverage is.
   - `[WARN]` when the PDD carries a low-literacy / low-education design
     constraint AND the build stacks N languages inline — reading load is
     multiplied for exactly that cohort, and assessment stems + option
     labels are read repeatedly. Surfaced for a human decision, not scored
     against the build.
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
| 2026-07-30 | **`assessment_discrimination` gains structural-tell deductions, a gate-margin hard-gate, and a non-contaminated probe harness (ace#1014); `localization_match` grades coverage, not mechanism (ace#968).** (1) Three measured authoring passes on one 12-item bank (`spark-facilitator/20260730-1718`) plateaued at 9–10/12 cold-guessable: typography normalization moved it 12→10 and deliberate virtue-inversion moved it ~1 more, inside noise. Added per-item deductions for the four structural tells that actually carry the signal (`self-justifying-key`, `minimal-claim`, `odd-one-out-binary`, `absurdity-elimination`), recorded in the probe table even on items that were NOT guessed; a **gate-margin hard-gate** (`guessable_ratio × 100 >= the PDD's Deliver-unlock threshold` → ≤3 → `fail`) because the `>80%` band was calibrated for an 80% gate and a 75% gate has zero margin (`9 * 100 div 12` = exactly 75.0); mandatory pre-test coverage so a hardened post-test over an untouched pre-test can't inflate the pre/post learning-gain metric; and an explicit harness contract — `get_form` returns stems, options AND the `qN_score` calculates in one payload, so a self-probe is contaminated by construction and the probe must run on separate agents given only stems+options under independently permuted neutral labels, with picks committed before reveal. Second calibration anchor added. Paired 1:1 with the two-gate authoring procedure in `_app-component-library.md § discriminating-assessment-items`. (2) `localization_match` stops requiring per-language itext, which Nova exposes on no tool (`update_app` carries only `name` and `connect_type`) — complete coverage authored INLINE is the sanctioned fallback and takes full credit with an `[INFO]`; English-only and materially-incomplete coverage both still hard-fail; the two permitted degradations (bare proper nouns, compact slash form in short strings) must not false-fail; and the low-literacy reading-load tension surfaces as a `[WARN]` for a human rather than a deduction. | ACE team |
| 2026-07-31 | **Migrated every `get_form` read to uuid addressing (ace#1132).** Nova's 2026-07-31 redeploy moved its whole surface from `moduleIndex`/`formIndex`/`fieldId` to `moduleUuid`/`formUuid`/`fieldUuid`, so `form_navigation` and the § 5c blind-probe harness both named uncallable operations. Added an addressing note at § 5b: resolve uuids ONCE per run — from the build summary's `nova_uuids:` frontmatter if present, else one `get_app({app_id})` (its blueprint prints `[uuid …]` on every module/form/field), with `search_blueprint({query, app_id})` for a single semantic name — and reuse the map for every read. The § 5c harness contract is unchanged and if anything reinforced: `get_form({app_id, moduleUuid, formUuid})` still returns stems, options AND the `qN_score` calculates atomically, and `get_field` is now per-field-uuid so it cannot fetch a stem without its key either — a self-probe stays contaminated by construction. Also corrected `localization_match`'s parenthetical (`update_app` now carries only `name`); the no-itext-channel claim itself was re-verified across all 63 live tools. | ACE team |
| 2026-08-12 | **`assessment_discrimination` becomes a CONTRAST, not a ceiling; `assessment_operation_coverage` added (ace#1187, closes ace#1042).** The dimension scored the *absolute* cold total of a single blind LLM reader briefed as a capable adult with strong exam technique, and hard-gated on it (band table + gate-margin gate). Measured on `spark-facilitator/20260810-0737` (Learn app `34a66bf7-9b48-40ef-aa56-31ac357e8a72`, one 20-item bank, keys withheld, picks committed before reveal): a trained field-persona reader scored **19.0/20**, an untrained field-persona reader **8.0/20**, and the rubric's own M&E-domain-expert reader **11/20** — so the retired proxy sat **15pp above** the population the Deliver gate protects and made the bank read **27% less discriminating** than it is (A−C = 8.0 vs the true A−B = 11.0). Its edge was stability of exam technique, not knowledge the training supplies (it reliably nailed q2/q3/q11/q14 that the field reader got right ~half the time, and *lost* q5 and q20 to it). The rubric returned `2.0` and failed the phase on a bank measuring **2.38x** discrimination, costing two authoring cycles (~500K subagent tokens); the correct verdict was a pass with named residuals. Changes: (1) the statistic is now `discrimination_delta = (trained − untrained) ÷ items_scored` with both readers on the **PDD-derived FLW persona**, differing only in whether they got the module teaching text — bands `>=0.40 → 9–10 · 0.30–0.39 → 7–8 · 0.20–0.29 → 5–6 · <0.20 → ≤3 → fail`; (2) the gate-margin hard-gate on the expert reader is **deleted**, replaced by a hard-gate on the **untrained field reader** clearing the PDD's actual unlock threshold — a direct measurement of the protected population rather than a ceiling proxy, and the path that keeps the `hh-poverty-targeting` negative control failing (it also fails on the collapsed delta and on `absurdity-elimination`); (3) `self-justifying-key` / `minimal-claim` / `odd-one-out-binary` stop deducting and become `[WARN]`s — option-craft is hygiene, the delta is the evidence — while `absurdity-elimination` still deducts as a Gate-1 item defect; (4) new **`assessment_operation_coverage`** dimension (0.03, taken from this dimension's 0.08 → 0.05, axis totals unchanged) maps each item to the instrument field it governs and the failure it prevents (unpaid visit / blocked form / corrupted data), with a hard-gate when a majority of high-consequence operations carry zero items; (5) **low-n rule** — `items_scored < 5` scores `null` + `[WARN]` and fires no hard-gate, since the delta is degenerate there and no authoring choice can change a PDD-mandated item count (**closes ace#1042**); (6) the probe reports `free_items` and the **effective bar** — 5 of the 20 items were answered correctly by both readers in every run, so a nominal 16/20 = 80% gate is really 11/15 = **73%** of signal-carrying items, which falls out of a contrast design and is invisible to a ceiling probe; (7) an explicit scope note — the Learn assessment is a **readiness** check, not an anti-fraud device (fraud is the Evidence Model's job: live photo, GPS, payment predicate, Partner Trainer observation), so adversarial robustness is no longer graded here. Paired 1:1 with the topic-selection + bank-independence rewrite in `_app-component-library.md § discriminating-assessment-items`. | ACE team |
