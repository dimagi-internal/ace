---
name: idea-to-pdd
description: >
  Develop a Program Design Doc (PDD) for a Connect intervention from
  source material. Iterates a 5-question stress-test rubric until approved.
disable-model-invocation: true
---

# Idea to PDD

Take an initial idea and iterate on it to produce a complete Program Design Doc (PDD) that specifies a Connect application.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator | `ACE/<opp-name>/runs/<run-id>/inputs-manifest.yaml` | frozen pointer-set to source material captured at run-start |
| Operator | each `file_id` in the manifest | source content (PDFs, docs, sheets, markdown) |

## Products

- `1-design/idea-to-pdd.md` — the PDD
<!-- 0.13.116: legacy `1-design/idea-to-pdd_gate-brief.md` removed.
Pause-time summary at the Phase 1→3 Pause Point is composed by the
orchestrator from the per-skill QA + eval verdicts on the fly. -->

- `ACE/<opp-name>/runs/<run-id>/decisions.yaml` — structured per-run decisions log (always emitted; see `## Decisions Log Convention` below)
- `run_state.yaml.phases.design.products.pdd` — `{title, description, file_id}` typed handoff for downstream readers (ace-web summary, future skills) so they don't need to parse the PDD body. This skill is the sole writer.

## Process

1. **Read source material** for the PDD.

   Phase 1 synthesizes a PDD from whatever the human curated into
   `ACE/<opp-name>/inputs/`. The orchestrator captures a frozen
   pointer-set at run-start as
   `runs/<run-id>/inputs-manifest.yaml`. There is no
   required filename inside `inputs/` — anything goes (PDFs, docx,
   sheets, markdown notes, prior-pass drafts).

   Read `ACE/<opp-name>/runs/<run-id>/inputs-manifest.yaml`
   first via `drive_read_file`. The manifest shape is:

   ```yaml
   opportunity: <opp>
   run_id: <runId>
   captured_at: <ISO>
   inputs:
     - file_id: <id>
       name: <name>
       mime_type: <mime>
   ```

   For each entry, read the file's content via
   `drive_read_file(file_id=<id>)` — Drive extracts text from Google
   Docs, PDFs, plain text/markdown, and most Word formats. Track each
   read's success/failure. For inherently non-text formats
   (spreadsheets, images, audio), `drive_read_file` will return
   limited or empty text; log the file by name in your synthesis as
   "supporting file present in `inputs/` — reference by name in the
   PDD where the content matters" and continue. **Do not halt on
   non-text files** — the human dropped them in for downstream skills
   (e.g. data spreadsheet templates for FLW reference).

   If `inputs-manifest.yaml` is missing, **stop and return an
   actionable error**:

   "Phase 1 has no source material — `inputs-manifest.yaml` (at the
   run-folder root) is missing. The orchestrator should have written
   the manifest at run-start. Re-run `/ace:run <opp-name>` so the
   manifest is captured from `ACE/<opp-name>/inputs/`."

   Do not invent source material or proceed without source content.

1a. **Pre-flight Drive accessibility — halt on permission failures.**

    The reads in step 1 surface permission failures implicitly, but
    surface them ALL as a single actionable error before any
    synthesis work — a session-interrupting OAuth dance turns into a
    30-second share-with-the-SA fix.

    Track every entry from `inputs-manifest.yaml` whose
    `drive_read_file` returned a permission error.

    If any read failed with a permission error, **stop and return an
    actionable error listing every inaccessible doc**:

    "The following files are not accessible to the ACE service
    account:
      - `<file_id>` (`<name>` from inputs/)
      - …
    Share each with
    `ace-service-account@connect-labs.iam.gserviceaccount.com`
    (Viewer is sufficient) and re-run `/ace:step idea-to-pdd
    <opp>/<run-id>`. If a doc is shared only with your personal
    account and cannot be re-shared with the service account, use
    `read_personal_drive_doc` (when available) as a fallback."

    Why: a recent design-review session was cancelled mid-run
    because the LEEP data sheet wasn't shared with the SA.

2. **Determine the delivery archetype** (see `## Archetypes` below). The archetype shapes the section list and the questions you ask in step 3. If the idea spans multiple delivery patterns (e.g., focus groups in Stage 1, atomic visits in Stage 2), pick `multi-stage` and assign an archetype to each stage.

3. **Research and expand** the idea:
   - What health/development problem does this address?
   - What is the intervention mechanism?
   - Who are the target beneficiaries?
   - What data needs to be collected (Learn app)?
   - What services need to be delivered (Deliver app)?
   - For non–`atomic-visit` archetypes, also work through the archetype-specific questions in `## Archetypes`.

3a. **Author the decisions log.** Before drafting the PDD, populate
    `ACE/<opp-name>/runs/<run-id>/decisions.yaml` with rows that meet the
    bar criterion in `## Decisions Log Convention` below. Each row
    records a load-bearing default the skill is about to apply when
    drafting the PDD. Use the AI's best inference from the source
    material for each `ai-default` value; status is `ai-default` (the AI
    proceeded with its default).

    See `## Decisions Log Convention § Common load-bearing decisions for
    Phase 1` for a working template of decisions that often qualify under
    the bar. Use it to guide judgment, not as a checklist — emit what
    meets the bar, skip what doesn't, add others when warranted.

4. **Draft the PDD** with the **base sections** below, plus **archetype-specific additions** from `## Archetypes`. Use the values selected in step 3a's `decisions.yaml` as authoritative — every numeric or named-entity in the PDD body should match the corresponding row's effective value (`override` if present else `ai-default`). If a re-run reads a `decisions.yaml` from a prior run with `status: overridden` rows (human edited via the renderer + sync skills), use the `override` value instead of the `ai-default`.

   **Base sections (all archetypes):**
   - **Archetype** — declared in frontmatter, repeated as the first heading
   - **Problem Statement** — what problem this solves
   - **Intervention Design** — how the intervention works
   - **Learn App Specification** — what FLWs need to learn (data collection, facilitation, etc., depending on archetype)
   - **Deliver App Specification** — what FLWs deliver (forms, sessions, etc., depending on archetype)
   - **Target Population** — beneficiary criteria, expected reach
   - **FLW Requirements** — number of FLWs, skills needed, geographic distribution
   - **LLO Preference** — preferred or known LLOs to execute, from LLO Directory
   - **Solicitation** — Phase 8 publishes a solicitation to labs.connect.dimagi.com so LLOs respond. All three fields are optional; defaults apply if omitted. Always ask once: "do you want a custom solicitation type (EOI vs RFP), a non-default deadline (default 14 days), or a custom response template?" If not, leave the section with default placeholders (the `solicitation-create` skill reads them as defaults).
   - **Success Metrics** — how to measure if the intervention worked
   - **Evidence Model** — Layer A / B / C verification plan (see `## Evidence Model` in `templates/pdd-template.md`)
   - **Timeline** — expected duration of the opportunity

5. **Self-evaluate (LLM-as-Judge) — Stress-Test Rubric.** Run the rubric defined in `## LLM-as-Judge Rubric` below against the drafted PDD. If **two or more** checks grade other than `pass`, the PDD is **not approved** — iterate on the weak sections and re-run before proceeding.

6. **Write the PDD** to `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` via Google Drive MCP. Include the stress-test rubric results as a `## Stress Test Results` appendix at the bottom of the PDD, so downstream skills (and humans) can see what was caught and what was waived.

<!-- 0.13.116: gate-brief write step removed. The orchestrator composes a
pause-time summary from this skill's QA verdict (idea-to-pdd-qa) +
eval verdict (idea-to-pdd-eval) at the Phase 1→3 Pause Point. -->

7.5. **Write the `products.pdd` block to `run_state.yaml`** so
   downstream readers (ace-web's summary page in particular) don't
   have to fetch and regex the PDD body.

   - `title`: the friendly intervention name from the PDD's H1 / opening
     line (e.g. "Turmeric Market Survey"). Strip trailing punctuation
     and any Google Docs comment markers (`[a][b]`).
   - `description`: a one-paragraph plain-prose overview, ~1–3
     sentences, lifted from the PDD's `## Overview` (or `## Summary` /
     `## Abstract`) section. Strip markdown bold/italic wrappers; keep
     content as a single line.
   - `file_id`: the Drive `fileId` returned by Step 6's
     `drive_create_file`.

   ```yaml
   phases:
     design:
       products:
         pdd:
           title: "Turmeric Market Survey"
           description: "FLWs visit markets to photograph turmeric vendors..."
           file_id: <fileId>
   ```

   Apply via `mcp__plugin_ace_ace-gdrive__update_yaml_file` with
   `merge: 'two-level'` on the current run's `run_state.yaml`. This
   skill is the sole writer of `products.pdd`.

8. **Render the decisions log to a human-readable Google Doc** by
   invoking the `decisions-render` skill against the run-id. The
   renderer produces `ACE/<opp-name>/runs/<run-id>/decisions.gdoc`
   at one stable URL; humans review and iterate on this doc, not the
   YAML. The orchestrator also invokes the renderer at end of every
   subsequent phase, so the gdoc stays current as later phases append
   rows.

## LLM-as-Judge Rubric

Run this 5-question stress test against the drafted PDD. Each check is **pass / partial / fail**. If **two or more** checks are anything other than `pass`, the PDD is **not approved** — iterate on the weak sections and re-run the stress test before outputting.

Background and worked examples live in `docs/examples/pdd-stress-test-observations.md`. Quote specific evidence from the PDD when grading; do not grade in the abstract.

1. **Executability** — *Could an LLO read this PDD on day one and start work without asking clarifying questions?*
   Common failure modes: recruitment criteria unspecified (how is "under-vaccinated" determined? self-report vs. card vs. records), language and translation not addressed, facilitator/FLW skill level not stated, consent process missing, venue selection unspecified, participant compensation not mentioned.

2. **Verifiability** — *For every claimed output, is there a concrete artifact we can collect and check?*
   Common failure modes: "summary of key themes" with no format/length/template, photo capture without standardization protocol (lighting, angle, distance, color reference), self-reported education delivery with no audit mechanism, qualitative outputs with no path from raw data to AI-ingestable form.

3. **Measurability** — *Are success criteria defined for this stage, with units and targets?*
   Common failure modes: success described as "improved understanding" with no metric, sampling cap stated but no target, no per-segment or per-region targets, primary vs. secondary metrics not separated.

4. **Stage-gate clarity** — *For multi-stage PDDs, what must be true at the end of this stage to proceed to the next?*
   Common failure modes: Stage 1 → Stage 2 transition undefined, no explicit "go / no-go / iterate" criteria, downstream stage references findings the upstream stage isn't required to produce.

5. **Resource realism** — *Are the LLO's capabilities matched to what's being asked?*
   Common failure modes: focus-group facilitation skill assumed without training, ~50 participants to recruit across 6 segments with no recruitment plan, FLW asked to make subjective research judgments (Q12/Q13-style) the artifact should answer instead, photo/data quality dependencies on equipment LLOs may not have.

**Grading anchors (worked examples):**

The vaccine-hesitancy PDD at `docs/examples/pdd-vaccine-hesitancy.md` is the canonical "fail" case. Expected grades:
- Executability: **fail** — recruitment, language, facilitation, consent, venue all underspecified
- Verifiability: **fail** — "summary of key themes" output spec is too thin to verify
- Measurability: **partial** — Stage 2 has metrics, Stage 1 does not
- Stage-gate clarity: **fail** — Stage 1 → Stage 2 transition undefined
- Resource realism: **partial** — facilitation skill assumed; ~48-person recruit unscoped

The turmeric-market-survey PDD at `docs/examples/pdd-turmeric-market-survey.md` is the canonical "near-pass" case. Expected grades:
- Executability: **partial** — "market" is free text but the cap depends on market identity
- Verifiability: **partial** — photo standardization protocol missing; vendor education self-report unverifiable
- Measurability: **partial** — caps stated, sampling targets missing
- Stage-gate clarity: **pass** — single stage
- Resource realism: **pass** — atomic-visit pattern is well-matched to FLW capability

Both PDDs fail the rubric in their current form. Surface specific failures and either (a) iterate on the PDD to fix them, or (b) in review mode, hand off to a human with the failure list attached.

<!-- 0.13.116: ## Gate Brief section removed. The orchestrator composes
a pause-time summary at the Phase 1→3 Pause Point from this skill's
QA verdict + eval verdict directly (per `agents/ace-orchestrator.md §
Pause Points`). The producer no longer authors a separate gate-brief
artifact. -->

## Decisions Log (rendered)

The skill always emits `decisions.yaml` and invokes `decisions-render`
to produce a prose Google Doc rendering at one stable URL
(`ACE/<opp-name>/runs/<run-id>/decisions.gdoc`). The YAML lives at
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`; the gdoc is its
human-friendly rendering and is regenerated after every phase. The
orchestrator's pause-time summary at the Phase 1→3 Pause Point
includes a `Decisions Log: <gdoc-url>` line.

## Decisions Log Convention

Every Phase 1 run emits `ACE/<opp-name>/runs/<run-id>/decisions.yaml`
with a calibrated set of load-bearing default-decisions the skill applied
while drafting the PDD. The log is the per-run audit trail and the
human-iteration surface — humans edit it (via the renderer + sync skills
landing in PRs #2–#4) to redirect a subsequent run's PDD draft.

### Bar criterion — what counts as a row

Two filters, both must be true:

1. **Load-bearing.** A reasonable person could pick differently AND it
   materially shapes downstream phases or eval scores.
2. **Maps to a known surface.** The default ties to one of: an
   `*-eval` rubric dimension, an `*-qa` structural check, a Phase
   Write-Back field that downstream phases read, or a numeric / named
   entity surfaced in the PDD body.

Form-field-level choices, Connect program slugs, email copy, font sizes
— below the bar.

### Common load-bearing decisions for Phase 1

These rows commonly qualify under the bar criterion for Phase 1 — a
working template, not a required set. The skill applies the bar
criterion and emits whatever rows meet it; this catalog is a teaching
device that improves over time as we learn from runs. Five rows are
marked `(eval input)` because `idea-to-pdd-eval`'s viability axis
(PR #144) grades on those specific decisions — when they're present in
the log, the rubric has structured input instead of grading on PDD
prose.

The catalog branches on archetype. The **base table** rows fit every
archetype; the per-archetype tables below it add rows that are
load-bearing for that archetype and meaningless for others (e.g.
`ai-photo-threshold` doesn't apply to FGDs; `submission-window`
doesn't apply to atomic visits). Emit base rows on every run, plus
the matching archetype's rows; skip a row when it's not applicable
to the opp; add others not listed when they meet the bar.

**Base (all archetypes):**

| ID | Question | Map to surface |
|---|---|---|
| `archetype-selection` | Which delivery archetype best fits? | `archetype_coherence` (eval input) |
| `budget-plausibility` | Is the budget plausible for implied labor + AI infra? | `resource_realism` (eval input, PR #144) |
| `named-downstream-consumer` | Pre-committed downstream consumer? | `demand_reality` (eval input, PR #144) |
| `primary-metric-vs-goal` | Direct goal vs upstream proxy? | `mission_alignment` (eval input, PR #144) |
| `ai-fallback-design` | True validation harness or parallel sampling? | `fallback_validates_primary` (eval input, PR #144) |
| `flw-count` | How many FLWs? | PDD `FLW Requirements` numeric |
| `working-language` | Working language(s)? | PDD `Learn App Specification` |
| `verification-layers` | Which evidence-model layers in scope? | PDD `Evidence Model` section |
| `solicitation-type` | Solicitation type (EOI/RFP/custom)? | PDD `Solicitation` section |
| `solicitation-deadline` | Solicitation deadline? | PDD `Solicitation` section |
| `candidate-llo-roster` | Named candidates or public-only? | `LLO Preference` named entity |

**`atomic-visit` (additive):**

| ID | Question | Map to surface |
|---|---|---|
| `payment-rate` | Per-visit payment rate band (range, not fixed) to propose to the LLO. The PDD captures a target range or anchor + rationale; the actual rate is **negotiated via the solicitation response** where the LLO proposes a number with justification. | PDD `FLW Requirements` numeric (range or band) |
| `pilot-sample-size` | Pilot sample size for AI calibration? | `verifiability` rubric |
| `ai-photo-threshold` | AI auto-accept confidence threshold? | `verifiability` rubric |
| `gps-verification-radius` | Acceptable GPS radius (meters) for visit-at-location? | `verifiability` rubric |
| `duplicate-detection-key` | What constitutes a duplicate? (vendor id, GPS bucket, household id) | PDD `Evidence Model` Layer A |
| `per-visit-daily-cap` | Daily / weekly cap per FLW? | PDD `FLW Requirements` numeric |

**`focus-group` (additive):**

| ID | Question | Map to surface |
|---|---|---|
| `payment-unit-model` | Per-session attestation-form payment via Connect deliver_unit (default) vs per-month invoice via Connect web (rare)? | PDD `Budget` + `connect-opp-setup` payment unit |
| `per-session-rate` | Per-verified-session rate band (range, not fixed) for facilitator + notetaker. Same negotiation principle as `payment-rate` — PDD captures a range with rationale; LLO proposes a number in their solicitation response and explains why. The awarded LLO's proposed rate becomes the actual `connect.deliver_unit` payment_unit amount at Phase 4 setup time. | PDD `FLW Requirements` numeric (range or band) |
| `facilitator-training-stipend` | Flat training stipend on **practice-session-pass** (coordinator-graded audio review). Note: not Learn-app completion — focus-group archetype has no Learn app. | PDD `FLW Requirements` numeric |
| `gdoc-content-template` | What sections / fields should the facilitator's gdoc contain? Default: the PDD's Output Specification verbatim. Where does the gdoc template live (a template URL the facilitator copies, or a free-text starting point)? | PDD `Output Specification` |
| `participant-compensation-cap-usd` | Per-participant compensation USD-equivalent cap? | PDD `Budget` numeric |
| `submission-window` | Hours between session end and **attestation form** submission. Gdoc submission window may differ — default: same. | PDD `Evidence Model` Layer A |
| `audio-min-duration` | Minimum audio duration for a session, captured out-of-band (audio is not in the CommCare form). Tracked for coordinator gdoc review, not for Layer A. | PDD `Facilitation Protocol` |
| `audio-consent-fallback` | What happens when one participant declines audio recording? (Audio is out-of-band — this is a facilitator protocol decision, not a CommCare form behavior.) | PDD `Facilitation Protocol` |
| `gps-verification-radius` | Acceptable GPS radius (meters) for the attestation form's `gps` field to clear Layer A as "at the planned venue"? | PDD `Evidence Model` Layer A + `connect-opp-setup` verification flags |
| `gdoc-submission-window` | Hours allowed between attestation submission and gdoc receipt (coordinator follow-up trigger). Default: same as `submission-window`. | PDD `Evidence Model` Layer B + coordinator workflow |
| `notetaker-required` | Is a separate notetaker required? Always / when audio recording / never? | PDD `Facilitation Protocol` |
| `venue-acceptable-list` | Which venue types are acceptable / disallowed? | PDD `Facilitation Protocol` |
| `site-selection` | Sites pre-named in PDD, or deferred to solicitation review? | PDD `Target Population` + `solicitation-review` |
| `payment-unit-entity-id` | Default `entity_id` (`concat(username, today())`) or override to `#case/case_id`? Affects payment collapse when one FLW runs ≥2 sessions/day | `connect-opp-setup` Connect form |
| `saturation-early-stop` | Threshold + sign-off for stopping the pilot before the planned session count? | PDD `Success Metrics` |

**`multi-stage` (additive):**

| ID | Question | Map to surface |
|---|---|---|
| `stage-gate-criteria` | What must be true at the end of stage N to proceed to N+1? | PDD `Stage Gate` per stage |
| `per-stage-archetype` | Which archetype for each stage? | Per-stage Archetype declaration |
| `stage-launch-policy` | Does stage N+1 launch before stage N is fully reviewed, or after? | PDD `Timeline` |

The bar criterion alone determines what rows belong in the log — the
tables above are teaching templates that improve over time.

### Schema and write semantics

Schema is defined in `lib/decisions-schema.ts` (`DecisionRowSchema` /
`DecisionsLogSchema`, v3). Do not hand-construct YAML — call the
`decisions_append_rows` MCP atom (ace-decisions server). The atom's
input schema is `DecisionRowSchema` directly, so unknown / misspelled
field names are rejected at the call boundary before they touch Drive.

Tool call (idiomatic shape for this skill):

```
decisions_append_rows({
  runFolderId: <run-folder file_id resolved at run start>,
  opportunity: <opp-slug>,
  run_id: <run-id>,
  rows: [
    {
      id: "archetype-selection",
      phase: "1-design",
      skill: "idea-to-pdd",
      question: "Which delivery archetype best fits the intervention?",
      "ai-default": "atomic-visit",
      options: ["atomic-visit", "focus-group", "multi-stage"],
      source: "idea.md §1; one-FLW-one-delivery pattern",
      status: "ai-default",
      reasoning: "Single per-FLW visit producing one structured delivery."
    },
    ...
  ]
})
```

The atom seeds a fresh v3 log header (`schema_version`, `opportunity`,
`run_id`, `generated_at`) on the first call and is idempotent: rows
whose `id` is already in the log are silently skipped and returned in
`skipped[]`, so a retry never duplicates rows.

This skill writes only `status: "ai-default"` rows. `overridden` rows
appear when a prior run's human edits carry forward via the fork
endpoint's `keep-all` or `keep-overrides-only` mode. The canonical
worked fixture is `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`
— useful as a reference shape, not as something to copy into Drive.

## Archetypes

ACE skills branch on the PDD's declared `archetype:` field. This skill generates archetype-appropriate sections during step 4 (Draft).

### `atomic-visit` (default)
The PDD describes one FLW visit producing one structured delivery (photo + GPS + form). Use the base sections as-is. Examples: turmeric market survey, household-level data collection.

**Additional questions to answer in step 3:**
- What is the exact form structure (every field, every type)?
- What's the standardization protocol for any photo/measurement (lighting, angle, distance, color reference)?
- What's the per-FLW and per-location daily cap?
- How is duplicate detection handled (vendor ID, stall number, GPS resolution)?

### `focus-group`

The PDD describes FLW-facilitated group discussions producing qualitative
content. **The FGD operational model is attestation-form-only on
CommCare; all qualitative content (themes, quotes, post-section
summaries, post-FGD report, facilitator reflection) is captured
out-of-band in a Google Doc.** Facilitator training is correspondingly
out-of-band — OCS chatbot + handbook gdoc + coordinator-graded
practice-session audio review. No Learn app is produced. See
`docs/superpowers/specs/2026-05-15-focus-group-archetype-redefinition.md`.

**Additional questions to answer in step 3:**

- **Recruitment**: Who are the segments? How will participants be identified? What sample size per segment? Comparison groups and their justification?
- **Language**: Working language? Need translation? Facilitator language fluency?
- **Facilitation skill level**: Existing skill assumed, or training required? Training surface is the per-opp **OCS chatbot** (loaded with the FGD Guide + Output Specification + handbook gdoc) plus a coordinator-graded practice-session audio review. The Learn app produced for focus-group is a **minimal sentinel** (one-form readiness gate, not a training curriculum) — it exists to satisfy Connect's API + gate attestation submissions on coordinator-confirmed practice-session-pass, NOT to carry training content. See `pdd-to-learn-app/SKILL.md § Archetypes § focus-group` for the sentinel spec.
- **Consent**: Verbal/written? Audio recording consent? Photo consent? Documented how?
- **Venue**: Neutral / facility / leader's compound? Each biases differently — which is acceptable?
- **Duration & compensation**: Expected session length? Participant opportunity cost compensated? Per-session facilitator + notetaker rate? Facilitator training stipend tied to practice-session-pass?
- **Question guide**: Sequencing (sensitive/program-specific questions last to avoid anchoring), prioritization (a 90-minute group covers 8–10 questions well, not 15+), warm-up questions, probing prompts.
- **Output spec — the gdoc structure**: What does a "good gdoc" look like? Per-section themes (3–6 bullets, with specifics), notable verbatim quotes (2–4 per section, role attribution like "mother" / "father" / "grandmother" not by name), level of consensus (strong / mixed / disagreement + justification), time spent per section, post-FGD report (top 5 things we heard, most-cited barriers, per-option reactions, surprises, recommendations), facilitator reflection (150–300 words). This structure goes in the **PDD's Output Specification** section and seeds both the gdoc template the facilitator fills out and the OCS chatbot's RAG content for post-session writing guidance.
- **Attestation form fields**: What does the per-session CommCare attestation form capture? Default: 5 fields — consent attestation (single yes/no, must be yes to submit), session date, venue (free text), GPS (geopoint), one evidence photo. Audio is NOT captured through CommCare (out-of-band, lives in Drive). The gdoc link is NOT captured (gdoc is written after submission). Everything else (participant count, segment, start/end times, per-section summaries, facilitator reflection) goes in the gdoc, not in the form. See `pdd-to-deliver-app/SKILL.md § Archetypes § focus-group` for the canonical 5-field list.

**Additional sections to include in the PDD draft:**

- **Recruitment Plan** — segments, sample sizes, identification mechanism, comparison groups.
- **Facilitation Protocol** — skill level, training surface (OCS chatbot + handbook gdoc + practice-session audio review), venue, language, consent, recording, compensation.
- **Question Guide** — ordered questions per section, with probes and warm-ups, and time allocation.
- **Output Specification** — **the gdoc structure** the facilitator fills in. Per-section format with concrete fields (themes, notable quotes, level of consensus, time spent, facilitator reflection). The Deliver app's attestation form captures *metadata and artifacts*, not this content — but the OCS chatbot's RAG content is seeded from this section so facilitators can ask "what should I put in section 3?" during write-up.

### `multi-stage`
The PDD has two or more sequenced stages with different archetypes. Treat the base sections as describing the overall intervention and create one **Stage X** subsection per stage, each declaring its own archetype and following that archetype's additional sections.

**Required for multi-stage PDDs:** an explicit **Stage Gate** subsection between every pair of stages, stating exactly what must be true at the end of stage N to proceed to stage N+1 (with go / no-go / iterate criteria).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_update_file`

## Mode Behavior

- **Default (auto):** Author `decisions.yaml` (step 3a), draft PDD using
  those defaults, write PDD + gate brief, email summary to admin group,
  proceed. The decisions.yaml ships with the run; humans review post-hoc
  and re-run via `/ace:step idea-to-pdd <opp>/<run-id>` after editing if
  they want a different PDD.
- **Review:** Author `decisions.yaml` (step 3a), then **pause** before
  drafting the PDD. Emit an interim gate brief stating "Decisions log
  written; edit any defaults you want changed, then resume." On resume,
  re-read `decisions.yaml` and draft the PDD using the (possibly edited)
  values. Continue to PDD-final gate brief as today.

## Dry-Run Behavior
When `--dry-run` is active:
- Write the PDD to `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` as normal
- Write the admin email summary (recipients, subject, body) to `comms-log/dry-run-idea-to-pdd.md`
- Do not send emails to the admin group
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-15 | Pare attestation-form-fields question + Decisions Log to match the 5-field form: consent / date / venue / GPS / photo. Audio is out-of-band; gdoc_link is removed (gdoc is written after submission). Add `gps-verification-radius` and `gdoc-submission-window` decisions; recharacterize `audio-min-duration` and `audio-consent-fallback` as facilitator-protocol concerns (out-of-band, not in the form). | ACE team |
| 2026-05-15 | Recharacterize `payment-rate` and `per-session-rate` Decisions Log rows: PDD captures a **range** (not a fixed number), and the actual rate is **negotiated via the solicitation response** where the LLO proposes a number with rationale. The awarded LLO's proposed rate becomes the `connect.deliver_unit` payment_unit amount at Phase 4 setup. Pairs with `solicitation-create/SKILL.md § Process`'s "per-unit payment is negotiated, not declared" design principle. | ACE team |
| 2026-05-22 | **Retire the optional `idea.md` operator-seed input.** The 2026-05-05 refactor reduced `idea.md` to an optional `--idea FILE\|-` seed alongside the `inputs/` evidence pack; the dual-path persisted but was rarely used in practice and added cognitive load (eval rubric branches, manifest-vs-idea precedence, permission-scan URL extraction). Operators now put any free-text seed directly into `inputs/` as a regular source file. Removed: optional table row, idea.md read paragraph, idea.md-URL permission scan, "or no idea.md" branch of the missing-source error. The `--idea` flag and run-root `idea.md` artifact are gone. | ACE team |
