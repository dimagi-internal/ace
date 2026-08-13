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
   | **Instructional depth** | 17% | Is each module actually *teachable*, at item granularity — not a label naming the topic? Check, independent of the PDD: (a) module bodies carry real instructional substance (steps, examples, do/don't, reference imagery placeholders correctly typed), not one-line labels; (b) item quality is scored by **`assessment_rule_coverage`** — do NOT also grade it here; this dimension keeps only the item-COUNT-per-module element in the mid-tier cap below; (c) citations / source references where the domain calls for them (WHO, PMI, etc.). **Hard-gate:** modules are label-only with no teachable substance → dimension **≤3**. **Mid-tier cap (added 2026-05-29 from ITN validation):** decent expository prose is necessary but NOT sufficient for a deployable training instrument. When modules carry teaching prose but lack pedagogical scaffolding — specifically ALL THREE of: (i) no worked examples or do/don't pairs, (ii) no domain citations where the source material cites them (WHO/PMI/GiveWell), AND (iii) fewer than 2 assessment items per taught module (the ITN build has 1 quiz item per module vs the expert `[Final]`'s 10-item pre-test + 10-item post-test) — cap this dimension at **4.0**. Each module that merely *names* its topic without teaching it = 1.5-point deduction. (This is the item-granular replacement for the old "topic present = covered" reading.) |
   | **Assessment rule coverage** | 8% | **Does the bank test the rules that cost something when a worker gets them wrong?** Structural — judged from the artifact, with no persona, no blind readers, and no run-to-run noise (see § 5c, and § Why the blind probe was retired before reinstating anything like it). **Build the denominator from named artifacts, one entry per RULE (not per field), and record the enumeration in the verdict** — an unrecorded denominator makes this score unreproducible (measured: the same bank scored 1, 3 and 6 under three defensible enumerations). Two sets: **(i) counter-intuitive rules** — taught rules where ordinary common sense produces the WRONG answer (leave the amount BLANK rather than 0; a committee meeting is recorded and deliberately NOT paid; members with disability sit INSIDE total attendance rather than added to it; any named number the worker cannot derive — an appeal window, a daily cap, a minimum subject count, a recency limit); and **(ii) high-consequence operations** — instrument fields or steps whose mishandling causes an unpaid visit, a blocked form, or corrupted data. Group related fields under the operation they serve; do not inflate the denominator with one entry per question. **An item counts toward coverage only if answering it REQUIRES the rule.** An item whose distractors are ALL rejectable on sight is **excluded from the numerator** — it names a rule without testing it, and a reader can solve it without reading the stem. This is the mechanism that catches a hollow bank, and it scales: ten hollow items cost ten times what one does. **Do NOT confuse this with content that is merely sensible.** *Solvable by elimination* is an option-set defect and excludes the item; *answerable cold because the taught rule is itself common sense* is NOT a defect and the item still counts — for a CHW curriculum most correct answers ARE sensible, and a bank engineered to defeat a clever guesser is a bank of arbitrary trivia, which is worse training for a low-literacy cohort, not better. Score = fraction of (i) ∪ (ii) carrying ≥1 **qualifying** item, **counter-intuitive rules weighted double**: **≥0.90 → 9–10 · 0.70–0.89 → 7–8 · 0.50–0.69 → 5–6 · <0.50 → ≤3**. A bank covering zero counter-intuitive rules is a comprehension check, not a gate → cap at **5**. Uncovered rules — and rules covered only by excluded items — are emitted as `repairs[]` for the PRODUCER to fix (§ 5c), not as a verdict. **N/A rule:** no scored assessment → score `null` and redistribute.
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
   - **`single_gating_assessment`** (added 2026-08-13, ace#1205) — count the
     forms carrying a `connect.assessment` block. If the PDD declares ONE
     readiness gate and more than one form carries the marker → `[BLOCKER]` →
     `fail`. Connect stores one `passing_score` per learn app and every "has
     this worker passed?" surface uses **any-passed** semantics (ace#1131), so a
     *diagnostic* pre-test carrying the marker silently becomes a Deliver-unlock
     gate — and since a pre-test is by construction the easiest instrument in
     the app, it is the one that unlocks. Live case:
     `spark-facilitator/20260812-1635` shipped a pre-test whose own screen read
     "This check does not open anything" while carrying `m0_pretest` as an
     assessment. The fix is one `configure_connect` call (REPLACE-ALL — resend
     the complete participant set). Pure blueprint read, no LLM judgment.

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

5c. **Rule-coverage audit and repair work order (scores
   `assessment_rule_coverage`).**

   This replaced a two-reader blind-probe harness on 2026-08-13. Read
   § Why the blind probe was retired before reinstating anything like it.

   **The audit — four steps, no dispatched readers, no persona.**

   1. **Enumerate the counter-intuitive rules.** Walk the module teaching text.
      For each rule it teaches ask: *if a worker had never read this module,
      would ordinary common sense give them the RIGHT answer or the WRONG one?*
      Keep the ones where common sense misleads — they are the only items that
      can carry training signal. Recurring shapes: a value convention that reads
      backwards (leave the amount BLANK, never 0, because 0 means "tried and
      saved nothing"), a deliberate non-payment (a committee meeting is recorded
      and correctly not paid), an inclusion rule (members with disability are
      already INSIDE total attendance), and any named number the worker cannot
      derive (an appeal window, a minimum subject count, a recency limit).
   2. **Enumerate the high-consequence operations** from the Deliver blueprint
      and the PDD: every instrument field or step whose mishandling causes an
      unpaid visit, a blocked form, or corrupted data.
   3. **Map each scored item to the rule it keys on**, across BOTH the pre-test
      and the post-test. An item mapping to nothing is not a defect by itself
      (consent and safety items earn their place) — report it as `rule: none`.
      Also note any item derivable from another; two items on one rule are one
      item's worth of resolution reported as two.
   4. **Mark each item QUALIFYING or EXCLUDED.** An item qualifies only if
      answering it REQUIRES the rule. Count, per item, how many distractors a
      competent worker would reject **without reading the stem** ("fabricate the
      photo", "fill in the answers yourself", "keep asking until they agree"). If
      ALL distractors are rejectable that way, the item is **EXCLUDED** — it
      names a rule without testing it. Record the count for every item, not just
      the excluded ones.

      **Counting discipline — write the sentence.** For every item you mark as
      QUALIFYING, **name the surviving distractor and state, in one sentence, why
      a reader who had not learned the rule would plausibly pick it.** If you
      cannot write that sentence, the item is all-rejectable after all and is
      EXCLUDED. This is what stops "rejectable on sight" drifting between judges;
      it is the only judgment in the dimension and it is forced into the open.

      **Do not confuse this with content that is merely sensible.** *Solvable by
      elimination* is a property of the OPTION SET and excludes the item;
      *answerable cold because the taught rule is itself common sense* is a
      property of the CONTENT and does not. The second is expected and fine for
      a CHW curriculum — see the retirement note below.

      **The threshold is ALL distractors rejectable — do not soften it to
      "most".** Two reasons, both measured. (a) A 2-of-3 threshold would exclude
      the single best item in the negative-control bank (an item on the flagship
      counter-intuitive rule whose surviving distractor is the *default*
      expectation) — a false negative on exactly the shape the rubric should
      reward. (b) A bright line is reproducible; "is the surviving distractor
      good enough?" is a graded judgment, and graded judgment inside the
      measurement is what invalidated the persona probe in the first place.
      There is also a structural reason it holds: **an item on a genuinely
      counter-intuitive rule cannot easily have all-rejectable distractors** —
      try writing one for a named cap ("max payable visits per day: 10 / 25 /
      50 / 100") and none of the options are rejectable, because the number
      cannot be derived. Hollow option sets are only constructible for rules
      that were obvious anyway, so the exclusion rule and the counter-intuitive
      definition reinforce each other.
   5. **Compute coverage** over the union, counting a rule as covered only when
      a QUALIFYING item keys on it, counter-intuitive rules weighted double.
      Emit every uncovered rule — **including rules covered only by excluded
      items** — as a `repairs[]` entry, and say which of the two it is: a rule
      with no item at all needs a new item; a rule whose only item was excluded
      needs that item's OPTIONS rewritten, not its subject changed.

   **The repair work order — this is the point of the dimension.** An uncovered
   rule is not a verdict, it is a task with a known fix: re-key a scenario item
   whose answer decency already supplies onto a rule that must be taught to be
   known. Emit one entry per uncovered rule:

   ```yaml
   rule_coverage:
     enumeration_source: "module teaching text (m1-m7) + PDD Deliver App Specification"
     counter_intuitive_rules:                 # the enumeration itself, not just a count
       - {id: CI-1, rule: "leave amount_saved blank when not saving, never 0", taught_in: m5_savings, covered_by: q6}
       - {id: CI-2, rule: "the appeal window is 7 days from the decision", taught_in: m7_payment, covered_by: null}
     counter_intuitive_covered: 7             # by QUALIFYING items only
     operations: 12
     operations_covered: 11                   # by QUALIFYING items only
     weighted_ratio: 0.85
     items_excluded: 0                        # all distractors rejectable on sight
     items_mapping_to_nothing: []
   items:
     - {id: q6, rule: CI-1, rejectable_distractors: 0, qualifies: true}
     - {id: q2, rule: none, rejectable_distractors: 3, qualifies: false}
   repairs:
     - uncovered_rule: "the appeal window is 7 days from the decision"
       kind: no-item                          # no-item | item-excluded
       taught_in: m7_payment
       failure_prevented: forfeited-payment
       suggested_target: q12
       note: >-
         q12 currently keys on the ACT of appealing, which any sensible worker
         picks unprompted. Re-key it on the WINDOW, which is taught and cannot
         be guessed. Keep the stem; change what the options differ on.
   ```

   **Who applies the repairs: `pdd-to-learn-app`, never this skill.** The judge
   must not author the bank it grades — a grader that repairs its own items and
   re-scores them converges on passing itself. The orchestrator dispatches the
   producer with the `repairs[]` list, exactly as the phase boundary fence
   dispatches `producedBy` for a missing artifact, then re-runs this eval ONCE.
   **Cap at one repair round.** If coverage is still short after it, report and
   stop — do not loop to green. Roughly 500K subagent tokens were spent across
   two prior authoring cycles looping against a number that could not move
   (ace#1014).

   ### Why the blind probe was retired (2026-08-13, ace#1206)

   The dimension used to dispatch blind readers and hard-gate on
   `discrimination_delta = (trained − untrained) ÷ items_scored`. Two
   independent reasons, either sufficient on its own.

   **1. The gate was arithmetically the statistic the same revision had just
   declared too noisy to gate on.** Because `trained ≤ n`, the delta is bounded
   by `delta ≤ 1 − untrained_ratio`; when the trained reader scores 100% — which
   it did on every well-built bank ever measured here — the bound is TIGHT and
   the delta simply IS `1 − untrained_ratio`. The 2026-08-12 revision demoted
   the `untrained_ratio` floor to a `[WARN]` because four runs of one bank
   spread 0.30–0.55 and "hard-gating a statistic with ±12pp run-to-run noise is
   the same class of error this dimension was filed for" — and then kept
   hard-gating the delta, which inherits that noise one-for-one. It derived the
   coupling itself and drew the opposite conclusion from it.

   **2. An LLM cannot proxy an untrained human's difficulty floor.** The
   "untrained field persona" reader is a fiction. An LLM told to be a
   low-literacy CBF still reads English fluently, still does the arithmetic,
   still has strong multiple-choice elimination; its floor is its own competence,
   not the persona's. For a CHW curriculum — where the taught rules are largely
   "record what happened, honestly" — a HIGH untrained score is the EXPECTED
   result for a well-designed bank, so it cannot be a failure signal. Driving it
   down means writing items that are arbitrary rather than sensible, which makes
   the instrument worse for exactly the cohort the gate protects. No ACE bank has
   ever been put in front of an actual CHW, so the LLM→CHW inference was never
   validated — and it was load-bearing for a hard gate.

   Live case: `spark-facilitator/20260812-1635`, Learn app
   `036c2c60-be0e-447d-862f-fe14d1dbcbb1`. Untrained persona scored 11/12 in
   both independent runs with identical miss sets, trained scored 12/12 → delta
   0.083 → `fail` — on a build scoring **8.45** overall, with complete trilingual
   coverage, worked examples drawn from the real instrument, correct conditional
   pass/fail wiring, and 11 of 12 high-consequence operations covered. A
   5%-weight dimension failed an 8.45 build on an unvalidated proxy.

   ### The negative control, MEASURED (do not skip this)

   `hh-poverty-targeting/20260722-1341`, Learn app
   `644a7ee2-a02c-4a1b-81e5-90a3ff926ab3` — 15 scored items across both banks,
   9 of them one-virtuous-answer-plus-three-rejectable-distractors.
   **Any revision of this dimension must still score that bank ≤3.**

   The first draft of this dimension **did not**, and it was caught by running
   the control rather than reasoning about it. Both numbers are recorded here
   because the gap between them is the whole lesson:

   | Draft | Mechanism for hollow items | Score |
   |---|---|---|
   | first | absurd distractors = a deduction, **capped at 2** | **5–6 — FAILS the requirement** |
   | shipped | absurd distractors **exclude the item from the numerator** | 5/20 = 0.25 → **≤3** |

   Why the first draft missed it: coverage asked whether an item *names* a rule,
   and the hollow items name rules perfectly well — they just don't require
   knowing them. Routing the entire defect through a capped deduction meant nine
   hollow items and two hollow items scored identically. Excluding a
   non-qualifying item from the numerator makes the penalty scale with how
   hollow the bank actually is, which is the property the control tests for.

   Two further facts from that measurement, worth carrying:

   - **Enumeration discipline is load-bearing.** Under three defensible readings
     of the denominator the same bank scored 1, 3 and 6. That is why the
     dimension now requires the enumeration to be built one-entry-per-RULE from
     named artifacts and recorded in the verdict.
   - **The ace#981 finding is slightly overstated for the app as it stands.**
     Two of the ten post-test items (q1, q3) do carry genuine common-sense traps.
     A naive reader picking the most professional-sounding option every time
     scores **8/10 — exactly the 80% pass mark**. So the gate is still
     decorative and the control is still valid, but the mechanism is "two real
     discriminators landing a know-nothing precisely at the boundary", not
     "every item is free".

   ### The positive control

   `spark-facilitator/20260812-1635`, Learn app
   `036c2c60-be0e-447d-862f-fe14d1dbcbb1` — 20 scored items across both banks,
   **zero excluded** (every distractor is behaviourally plausible; the
   structural-tell audit found no all-rejectable option set). 7 of ~10
   counter-intuitive rules covered, 11 of 12 operations covered →
   `(7×2 + 11) / (10×2 + 12)` = **25/32 = 0.78 → band 7–8 → `warn`**, with the
   uncovered rules (the appeal window, the 8-person photo minimum,
   one-photo-exactly) returned as `repairs[]`.

   That is the intended behaviour and the reason this dimension was rewritten:
   the same build scored **`fail`** under the retired probe. A revision that
   moves this bank to `fail`, or the `hh-poverty-targeting` bank above to
   `pass`, has broken the calibration.

   **Known residual — the band EDGES are untested.** The two anchors sit at 0.25
   and 0.78; the 0.70 and 0.90 boundaries have never been exercised by a real
   bank, and the negative control's spread stayed narrow partly *because* its
   numerator is nearly empty (3 of 15 items qualifying leaves denominator wobble
   little leverage). A mid-quality bank sitting near a boundary with a ±30%
   denominator swing could still cross it. Treat 7–8 vs 9–10 as soft until a
   third anchor lands near an edge, and prefer reporting the ratio itself over
   arguing the band.
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
     instructional_depth:       { weight: 0.17 }   # item-granular teachable content (item QUALITY is scored by assessment_rule_coverage)
     assessment_rule_coverage:  { weight: 0.08 }   # counter-intuitive rules + high-consequence operations carrying >=1 keyed item; emits repairs[] for the producer; null + redistribute when no scored assessment
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
   - `[WARN]` for each uncovered rule emitted in `repairs[]`. These are a work
     order for `pdd-to-learn-app`, not a verdict against it — name the rule, the
     module that teaches it, and the item best re-keyed onto it.
   - `[WARN]` for each item EXCLUDED from coverage because all its distractors
     are rejectable on sight, naming the rule it was supposed to test. These are
     the cheapest repairs available — the item's subject is already right, only
     its options need rewriting.
   - `[BLOCKER]` when the bank covers **zero** counter-intuitive rules with a
     QUALIFYING item. A bank of only common-sense items, or one whose
     counter-intuitive items are all solvable by elimination, is a comprehension
     check rather than a readiness gate.
   - `[BLOCKER]` when more than one form carries `connect.assessment` while the
     PDD declares a single gate — Connect stores one `passing_score` per learn
     app and every "has this worker passed?" surface is **any-passed**
     (ace#1131), so a diagnostic pre-test carrying the marker silently becomes a
     Deliver-unlock gate whatever its own copy says. Mechanically checkable from
     the blueprint; see § 5b (ace#1205).
   - `[WARN]` when more than half the scored items map to no rule at all —
     the bank is testing sentiment rather than the work.
   - `[WARN]` for each item derivable from another (two items on one rule are
     one item's worth of resolution reported as two).
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
| 2026-08-12 | **Re-validated the contrast statistic against BOTH calibration anchors; demoted the absolute-floor gate to a `[WARN]` (ace#1187, ace#1131).** Ran the new statistic end-to-end before shipping, two independently-permuted untrained runs per bank, picks committed before reveal, keys from the live `qN_score` calculates. **Positive control** `spark-facilitator` post-test (20 items, gate 16/20): trained **20/20**, untrained 11 and 10 → 10.5, `delta` **0.475** → top band → **pass** (the old rubric returned 2.0 and failed the phase). **Negative control** `hh-poverty-targeting/20260722-1341` post-assessment (10 items, gate 8/10): untrained 9 and 10 → 9.5 (0.95), and since `delta ≤ 1.0 − untrained_ratio` its delta ceiling is **0.05** → **fail**, with both runs independently reporting 9 of 10 items carrying two-or-more options eliminable on sight. Three changes follow from the measurement. (1) The untrained-clears-the-gate **hard-gate is demoted to a `[WARN]`**, as ace#1187 originally proposed: at any threshold ≥ 80 it is mathematically redundant (the delta band already fails such a bank), and `untrained_ratio` proved too noisy to gate on — four runs of the SAME spark bank scored 6, 10, 10, 11 (0.30–0.55), because a persona brief only partly suppresses an LLM's domain knowledge. (2) That noise is now a first-class calibration fact: at least two untrained runs (already required), a `[WARN]` when the two runs differ by more than 2 items, and a mandatory third run when the delta lands within 0.05 of a band boundary. (3) The `untrained_ratio` WARN now fires for **every instrument carrying `connect.assessment`, pre-test included** — Connect stores one `passing_score` per learn app and every 'has this worker passed?' surface uses any-passed semantics, so a pre-test carrying the marker gates Deliver whatever its intro copy says; the prior wording ('the post-test, the gating instrument, drives the score') was the blind spot ace#1131 named. Also recorded: the trained reader scored 20/20 on the spark bank, i.e. every item is answerable from taught content — the Step-1 property the build-side procedure asks for, and what makes the delta large. | ACE team |
| 2026-08-13 | **Retired the blind two-reader probe; replaced `assessment_discrimination` (0.05) + `assessment_operation_coverage` (0.03) with one structural dimension `assessment_rule_coverage` (0.08), which emits `repairs[]` instead of a verdict (ace#1206).** Two independent defects, either sufficient. (1) **The hard gate was arithmetically the statistic the same revision had just declared too noisy to gate on.** `delta ≤ 1 − untrained_ratio`, and when the trained reader scores 100% (as it did on every well-built bank measured) the bound is TIGHT — the delta simply IS `1 − untrained_ratio`. The 2026-08-12 entry below demoted the `untrained_ratio` floor to a WARN citing 0.30–0.55 run-to-run spread and "hard-gating a statistic with ±12pp run-to-run noise is the same class of error this dimension was filed for", then kept hard-gating the delta, which inherits that noise 1:1. The coupling is derived in that entry's own text; the opposite conclusion was drawn from it. (2) **An LLM cannot proxy an untrained human's difficulty floor.** The untrained-field-persona reader is a fiction — an LLM told to be a low-literacy CBF still reads English fluently, does the arithmetic, and eliminates options; its floor is its own competence. For a CHW curriculum whose taught rules are largely "record what happened, honestly", a HIGH untrained score is the EXPECTED result for a good bank, so it cannot be a failure signal, and driving it down means authoring arbitrary trivia — worse training for the cohort the gate protects. No ACE bank has ever been put in front of a real CHW, so the LLM→CHW inference was never validated while being load-bearing for a hard gate. Trigger: `spark-facilitator/20260812-1635` (Learn app `036c2c60-be0e-447d-862f-fe14d1dbcbb1`) — untrained 11/12 twice with identical miss sets, trained 12/12, delta 0.083 → `fail` on a build scoring **8.45** with complete trilingual coverage, worked examples from the real instrument, correct conditional pass/fail wiring and 11/12 operations covered. A 5%-weight dimension failed an 8.45 build on an unvalidated proxy. **The replacement** is judged from the artifact with no persona and no dispatched readers: enumerate the **counter-intuitive rules** (taught rules where common sense gives the WRONG answer — blank-not-zero, committee-recorded-but-not-paid, disability-inside-not-added, any named window or threshold) plus the **high-consequence operations**, map each scored item across BOTH banks to the rule it keys on, and score coverage with counter-intuitive rules weighted double. Zero counter-intuitive rules caps at 5. An item whose distractors are ALL rejectable on sight is EXCLUDED from the numerator rather than merely deducted for — a first draft routed that defect through a deduction capped at 2, which scored the `hh-poverty-targeting` negative control 5-6 and FAILED the regression requirement; the control was run rather than reasoned about, and the exclusion mechanism (which scales with how hollow the bank is) restores it to 0.25 -> <=3. Crucially this is NOT a difficulty penalty: *solvable by elimination* is an option-set defect and excludes the item, while *answerable cold because the taught rule is itself common sense* is expected for a CHW curriculum and still counts. The measurement also showed the denominator spans three bands under defensible enumerations, so the enumeration must now be built one-entry-per-RULE from named artifacts and recorded in the verdict. Uncovered rules become `repairs[]` — a typed work order the ORCHESTRATOR hands to `pdd-to-learn-app`, never applied by this skill (a grader that repairs its own bank and re-scores it converges on passing itself), capped at ONE repair round because ~500K subagent tokens were already spent looping against an immovable number (ace#1014). Also added **`single_gating_assessment`** to § 5b: more than one form carrying `connect.assessment` against a single PDD-declared gate is a `[BLOCKER]`, because Connect's any-passed semantics turn a diagnostic pre-test into the app's easiest unlock path (ace#1205, ace#1131). Negative control unchanged: `hh-poverty-targeting/20260722-1341` covers ~0 counter-intuitive rules and takes the absurd-distractor deduction on every item → still ≤3. | ACE team |
