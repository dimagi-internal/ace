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
| Operator (optional) | `ACE/<opp-name>/runs/<run-id>/idea.md` | free-text seed via `--idea FILE\|-` |

## Outputs

- `1-design/idea-to-pdd.md` — the PDD
- `1-design/idea-to-pdd_gate-brief.md` — gate brief consumed at the Phase 1 → 2 review pause
- `ACE/<opp-name>/runs/<run-id>/decisions.yaml` — structured per-run decisions log (always emitted; see `## Decisions Log Convention` below)

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

   Additionally, if `ACE/<opp-name>/runs/<run-id>/idea.md` exists
   (operator-supplied free-text seed via `--idea FILE|-`), read it
   too and treat its body as the operator's primary intent — it
   stands alongside the manifest's evidence pack.

   If `inputs-manifest.yaml` is missing AND no `idea.md` exists at
   the run root, **stop and return an actionable error**:

   "Phase 1 has no source material — `inputs-manifest.yaml` (at the run-folder root)
   is missing and no operator-supplied `idea.md` was found at the
   run root. The orchestrator should have written the manifest at
   run-start. Re-run `/ace:run <opp-name>` so the manifest is
   captured from `ACE/<opp-name>/inputs/`. If you intentionally want
   a free-text-only seed, pass `--idea FILE|-`."

   Do not invent source material or proceed without source content.

1a. **Pre-flight Drive accessibility — halt on permission failures.**

    The reads in step 1 surface permission failures implicitly, but
    surface them ALL as a single actionable error before any
    synthesis work — a session-interrupting OAuth dance turns into a
    30-second share-with-the-SA fix.

    Track every entry from `inputs-manifest.yaml` whose
    `drive_read_file` returned a permission error. Additionally, if
    `idea.md` is present, scan its body for Drive URLs matching
    `https://(docs|drive)\.google\.com/(document|spreadsheets|presentation|file)/d/<file_id>/`
    and attempt to read each.

    If any read failed with a permission error, **stop and return an
    actionable error listing every inaccessible doc**:

    "The following files are not accessible to the ACE service
    account:
      - `<file_id>` (`<name>` from inputs/)
      - `<file_id>` (`<name>` referenced in idea.md)
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
    material for each `default` value; mark `status: open` for any
    default the AI flags for human attention while still proceeding.

    The skill MUST emit every anchor row from
    `## Decisions Log Convention § Anchor decisions` whenever the anchor
    applies to the opp (handle inapplicable cases by emitting the row with
    `status: applied` and a notes-line explanation). Beyond the anchor set,
    the skill emits whatever additional rows meet the bar criterion. The
    bar is the filter; the recommended-additional list is illustrative.

4. **Draft the PDD** with the **base sections** below, plus **archetype-specific additions** from `## Archetypes`. Use the values selected in step 3a's `decisions.yaml` as authoritative — every numeric or named-entity in the PDD body should match the corresponding row's `default`. If a re-run reads a `decisions.yaml` from a prior run with `status: overridden` rows (human edited via the renderer + sync skills landing in PRs #2–#4), use those overridden values instead.

   **Base sections (all archetypes):**
   - **Archetype** — declared in frontmatter, repeated as the first heading
   - **Problem Statement** — what problem this solves
   - **Intervention Design** — how the intervention works
   - **Learn App Specification** — what FLWs need to learn (data collection, facilitation, etc., depending on archetype)
   - **Deliver App Specification** — what FLWs deliver (forms, sessions, etc., depending on archetype)
   - **Target Population** — beneficiary criteria, expected reach
   - **FLW Requirements** — number of FLWs, skills needed, geographic distribution
   - **LLO Preference** — preferred or known LLOs to execute, from LLO Directory
   - **Solicitation** — Phase 7 publishes a solicitation to labs.connect.dimagi.com so LLOs respond. All three fields are optional; defaults apply if omitted. Always ask once: "do you want a custom solicitation type (EOI vs RFP), a non-default deadline (default 14 days), or a custom response template?" If not, leave the section with default placeholders (the `solicitation-create` skill reads them as defaults).
   - **Success Metrics** — how to measure if the intervention worked
   - **Evidence Model** — Layer A / B / C verification plan (see `## Evidence Model` in `templates/pdd-template.md`)
   - **Timeline** — expected duration of the opportunity

5. **Self-evaluate (LLM-as-Judge) — Stress-Test Rubric.** Run the rubric defined in `## LLM-as-Judge Rubric` below against the drafted PDD. If **two or more** checks grade other than `pass`, the PDD is **not approved** — iterate on the weak sections and re-run before proceeding.

6. **Write the PDD** to `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` via Google Drive MCP. Include the stress-test rubric results as a `## Stress Test Results` appendix at the bottom of the PDD, so downstream skills (and humans) can see what was caught and what was waived.

7. **Write the gate brief** to `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd_gate-brief.md` using the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`. See `## Gate Brief` below for the exact fields this skill populates.

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

## Gate Brief

The gate brief at `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd_gate-brief.md` translates the
PDD stress-test output into a shape the admin can act on in 60 seconds.
Follows the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`.

- **Artifact Under Review:** path `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`; summary is the
  PDD's archetype + problem-statement one-liner
- **What to Check** (emit these 4 items verbatim):
  - Archetype declared in frontmatter matches the idea (`atomic-visit` /
    `focus-group` / `multi-stage`)
  - `## Evidence Model` section exists with Layer A / B / C populated
    (downstream skills fail loudly if any is empty)
  - `LLO Preference` section names at least one candidate LLO or a
    defensible "any LLO in region X" scope
  - Any Stress Test categories graded `partial` or `fail` have a
    human-readable explanation in the appendix (not just a grade)
- **Auto-Surfaced Concerns:** one line per stress-test category graded
  `partial` (→ `[WARN]`) or `fail` (→ `[BLOCKER]`). For each, include the
  category name and the specific failure-mode hint from the rubric (e.g.,
  `[BLOCKER] Executability — recruitment criteria unspecified`). If all
  five categories graded `pass`, write "None — all auto-checks passed."
  - **Open-status decisions:** every row in `decisions.yaml` with
    `status: open` produces a `[WARN]` entry naming the row's `id` and
    one-line `notes`. Example: `[WARN] named-downstream-consumer — no
    consumer named in idea.md; flag for human edit before Phase 7.`
- **Recommended Disposition:** `Approve` if 0 `[BLOCKER]` and ≤1 `[WARN]`;
  `Iterate` if any `[BLOCKER]` appears; `Approve with caveats` otherwise
- **Decisions Log:** the skill always emits `decisions.yaml` and invokes
  `decisions-render` to produce a prose Google Doc rendering at one
  stable URL. Include the gdoc URL on its own line at the top of the
  gate brief, prefixed `Decisions Log: <gdoc-url>`. The YAML lives at
  `ACE/<opp-name>/runs/<run-id>/decisions.yaml`; the gdoc is its
  human-friendly rendering and is regenerated after every phase.

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

### Anchor decisions (rows the eval rubric depends on)

A small set of decisions are load-bearing for specific eval rubric dimensions
— their absence means the rubric grades a missing input and the verdict is
unreliable. The skill SHOULD emit these rows whenever they apply to the opp:

| ID | Question | Eval rubric anchor |
|---|---|---|
| `archetype-selection` | Which delivery archetype best fits? | `archetype_coherence` |
| `budget-plausibility` | Is the budget plausible for implied labor + AI infra? | `resource_realism` (PR #144) |
| `named-downstream-consumer` | Pre-committed downstream consumer? | `demand_reality` (PR #144) |
| `primary-metric-vs-goal` | Direct goal vs upstream proxy? | `mission_alignment` (PR #144) |
| `ai-fallback-design` | True validation harness or parallel sampling? | `fallback_validates_primary` (PR #144) |

If an anchor is genuinely irrelevant for the opp (rare — usually applies
only when the question is structurally inapplicable), emit it with
`status: applied` and a `notes` line explaining why the default is
structural rather than a real choice. Do not silently omit.

### Recommended additional rows (illustrative, non-binding)

These rows often qualify under the bar criterion. They are examples of
what the criterion typically catches, not requirements. Skip when not
applicable; add others not listed when they meet the bar.

| ID | Question | Map to surface |
|---|---|---|
| `flw-count` | How many FLWs? | PDD `FLW Requirements` numeric |
| `payment-rate` | Per-visit payment rate to FLW? | PDD `FLW Requirements` numeric |
| `pilot-sample-size` | Pilot sample size for AI calibration? | `verifiability` rubric |
| `ai-photo-threshold` | AI auto-accept confidence threshold? | `verifiability` rubric |
| `working-language` | Working language(s)? | PDD `Learn App Specification` |
| `verification-layers` | Which evidence-model layers in scope? | PDD `Evidence Model` section |
| `solicitation-type` | Solicitation type (EOI/RFP/custom)? | PDD `Solicitation` section |
| `solicitation-deadline` | Solicitation deadline? | PDD `Solicitation` section |
| `candidate-llo-roster` | Named candidates or public-only? | `LLO Preference` named entity |

The bar criterion alone determines what rows belong in the log. The
anchor list above is the only required surface; everything else is the
LLM's judgment per the criterion.

### Schema and write semantics

Schema is defined in `lib/decisions-schema.ts` (`DecisionsLogSchema`).
Required fields per row: `id`, `phase` (always `1-design` for this skill),
`skill` (always `idea-to-pdd`), `question`, `default`, `options_considered`,
`source`, `status`. Optional `notes`.

`status` values:
- `applied` — default in use; the AI's best inference from source material.
- `overridden` — human edited via renderer + sync skills (PRs #2–#4); not produced directly by this skill.
- `open` — load-bearing, the AI proceeded with a default but flags for human attention. Surfaces as `[WARN]` in the gate brief's `Auto-Surfaced Concerns`.

Write via `drive_create_file` (find-or-update semantics) at
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The Drive MCP's parent
folder is the run-folder file ID resolved at run start.

### Status: `open` policy

A row is marked `status: open` when a load-bearing default exists but the
AI judges it likely-wrong without human confirmation. Examples:

- `named-downstream-consumer` is `none-named-proceed-with-caveat` AND
  the opp will publish a public solicitation in Phase 7.
- `ai-fallback-design` is `parallel-sampling-N-percent` AND the program
  needs ground-truth per-decision accuracy.

The AI proceeds with the default in either mode; review-mode pauses for
edit, default-mode ships the gate brief with `[WARN]` entries.

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
The PDD describes FLW-facilitated group discussions producing qualitative content (audio + per-domain summaries + attendance). Examples: vaccine-hesitancy Stage 1.

**Additional questions to answer in step 3:**
- **Recruitment**: Who are the segments? How will participants be identified? What sample size per segment? Comparison groups and their justification?
- **Language**: Working language? Need translation? Facilitator language fluency?
- **Facilitation skill level**: Existing skill assumed, or training required? Probing/neutral framing/group dynamics covered in the Learn app?
- **Consent**: Verbal/written? Audio recording consent? Photo consent? Documented how?
- **Venue**: Neutral / facility / leader's compound? Each biases differently — which is acceptable?
- **Duration & compensation**: Expected session length? Participant opportunity cost compensated?
- **Question guide**: Sequencing (sensitive/program-specific questions last to avoid anchoring), prioritization (a 90-minute group covers 8–10 questions well, not 15+), warm-up questions, probing prompts.
- **Output spec**: What does a "good summary" look like? Format, length, template, required content per question domain. Without this, the qualitative outputs aren't AI-ingestable.

**Additional sections to include in the PDD draft:**
- **Recruitment Plan** — segments, sample sizes, identification mechanism, comparison groups
- **Facilitation Protocol** — skill level, training requirement, venue, language, consent, recording, compensation
- **Question Guide** — ordered questions per domain, with probes and warm-ups, and time allocation
- **Output Specification** — per-session summary format with concrete fields (themes, notable quotes, level of consensus, time spent, facilitator reflection)

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
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Replace weak self-eval with 5-question stress-test rubric (executability, verifiability, measurability, stage-gate clarity, resource realism); block at ≥2 non-pass; include grading anchors from vaccine-hesitancy and turmeric example PDDs; emit stress-test results as PDD appendix | ACE team (PM scout, focus-group framework lens) |
| 2026-04-15 | Fail fast with actionable error if `idea.md` is missing instead of improvising an idea | ACE team (PM scout, end-to-end UX lens) |
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd_gate-brief.md` so the review-mode gate presents a checklist + stress-test concerns instead of a bare "approve PDD?" prompt | ACE team (PM scout, internal-admin lens) |
| 2026-04-20 | Extract stress-test rubric from Process step 5 into standalone `## LLM-as-Judge Rubric` section per author contract; process step now references the section | ACE team (skills review) |
| 2026-05-05 | Replace single-`idea.md` input contract with multi-doc evidence-pack model: read `inputs-manifest.yaml` (at the run-folder root) (orchestrator-emitted) and synthesize the PDD from every file under `inputs/`. Optional `idea.md` at the run root is now a `--idea FILE\|-` operator seed only. The PDD is the formal output of Phase 1, never an input. | ACE team (LEEP run; user observation that PDD is an output not an input) |
| 2026-05-08 | Replace `## Open Questions Convention` with `## Decisions Log Convention`. Skill always emits `decisions.yaml` with the 14-row calibrated Phase 1 set covering archetype, FLW count, budget plausibility, payment rate, pilot size, AI threshold, AI fallback design, named consumer, primary-metric-vs-goal, language, evidence layers, solicitation defaults, candidate roster. Schema defined in `lib/decisions-schema.ts`; ground-truth fixture in `test/skills/idea-to-pdd/fixtures/turmeric-decisions.yaml`. Renderer + round-trip ship in PRs #2–#4. | ACE team |
| 2026-05-08 | Retrofit: replace `### Required Phase 1 row set` (14 hardcoded rows) with `### Anchor decisions` (5 rows tied to specific eval rubric dimensions) + `### Recommended additional rows` (illustrative, non-binding). Bar criterion is the sole filter; anchors are the only required surface. Process step adds renderer invocation; gate brief links the gdoc rendering instead of the YAML. | ACE team (decisions-log PR #2) |
