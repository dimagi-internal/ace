---
name: idea-to-pdd
description: >
  Iterate on an idea to produce a well-specified Program Design Doc (PDD)
  for a Connect application. Defines the intervention, target FLWs, visit
  structure, and preferred LLOs.
---

# Idea to PDD

Take an initial idea and iterate on it to produce a complete Program Design Doc (PDD) that specifies a Connect application.

## Process

1. **Read the initial idea** from `ACE/<opp-name>/idea.md` in GDrive.

   If the file is missing, **stop and return an actionable error**:
   "`ACE/<opp-name>/idea.md` not found — this is the human-supplied brief
   that seeds the PDD. If you're running `/ace:step idea-to-pdd`, create the
   file first. If you're running `/ace:run`, the orchestrator should have
   prompted for it; re-run `/ace:run <opp-name>` so it captures the idea."
   Do not invent an idea or proceed without this file.

1a. **Pre-flight Drive accessibility for any referenced source documents.**
    Before doing any analysis work, scan the just-read `idea.md` content for
    Google Drive references — URLs matching
    `https://(docs|drive)\.google\.com/(document|spreadsheets|presentation|file)/d/<file_id>/`
    or bare file IDs explicitly tagged as Drive. For each one, attempt
    `drive_read_file(file_id=<id>, mime_type="text/plain")` (metadata-only
    where supported) to verify the ACE service account has read access.

    If any read fails with a permission error, **stop and return an
    actionable error listing every inaccessible doc**:
    "`<file_id>` is not accessible to the ACE service account. Share it
    with `ace-service-account@connect-labs.iam.gserviceaccount.com`
    (Viewer is sufficient) and re-run /ace:step idea-to-pdd. If the doc
    is shared only with your personal account and cannot be re-shared
    with the service account, use `read_personal_drive_doc` (when
    available) as a fallback."

    Why: a recent design-review session was cancelled mid-run because the
    LEEP data sheet wasn't shared with the SA. Surfacing the permission
    issue upfront turns a session-interrupting OAuth dance into a
    30-second share-with-the-SA fix.

    If `idea.md` references no external Drive docs, skip this step
    silently.

2. **Determine the delivery archetype** (see `## Archetypes` below). The archetype shapes the section list and the questions you ask in step 3. If the idea spans multiple delivery patterns (e.g., focus groups in Stage 1, atomic visits in Stage 2), pick `multi-stage` and assign an archetype to each stage.

3. **Research and expand** the idea:
   - What health/development problem does this address?
   - What is the intervention mechanism?
   - Who are the target beneficiaries?
   - What data needs to be collected (Learn app)?
   - What services need to be delivered (Deliver app)?
   - For non–`atomic-visit` archetypes, also work through the archetype-specific questions in `## Archetypes`.

4. **Draft the PDD** with the **base sections** below, plus **archetype-specific additions** from `## Archetypes`:

   **Base sections (all archetypes):**
   - **Archetype** — declared in frontmatter, repeated as the first heading
   - **Problem Statement** — what problem this solves
   - **Intervention Design** — how the intervention works
   - **Learn App Specification** — what FLWs need to learn (data collection, facilitation, etc., depending on archetype)
   - **Deliver App Specification** — what FLWs deliver (forms, sessions, etc., depending on archetype)
   - **Target Population** — beneficiary criteria, expected reach
   - **FLW Requirements** — number of FLWs, skills needed, geographic distribution
   - **LLO Preference** — preferred or known LLOs to execute, from LLO Directory
   - **Solicitation** — Phase 6 publishes a solicitation to labs.connect.dimagi.com so LLOs respond. All three fields are optional; defaults apply if omitted. Always ask once: "do you want a custom solicitation type (EOI vs RFP), a non-default deadline (default 14 days), or a custom response template?" If not, leave the section with default placeholders (the `solicitation-create` skill reads them as defaults).
   - **Success Metrics** — how to measure if the intervention worked
   - **Evidence Model** — Layer A / B / C verification plan (see `## Evidence Model` in `templates/pdd-template.md`)
   - **Timeline** — expected duration of the opportunity

5. **Self-evaluate (LLM-as-Judge) — Stress-Test Rubric.** Run the rubric defined in `## LLM-as-Judge Rubric` below against the drafted PDD. If **two or more** checks grade other than `pass`, the PDD is **not approved** — iterate on the weak sections and re-run before proceeding.

6. **Write the PDD** to `ACE/<opp-name>/pdd.md` via Google Drive MCP. Include the stress-test rubric results as a `## Stress Test Results` appendix at the bottom of the PDD, so downstream skills (and humans) can see what was caught and what was waived.

7. **Write the gate brief** to `ACE/<opp-name>/gate-briefs/idea-to-pdd.md` using the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`. See `## Gate Brief` below for the exact fields this skill populates.

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

The gate brief at `ACE/<opp-name>/gate-briefs/idea-to-pdd.md` translates the
PDD stress-test output into a shape the admin can act on in 60 seconds.
Follows the shape defined in `agents/ace-orchestrator.md § Gate Brief Contract`.

- **Artifact Under Review:** path `ACE/<opp-name>/pdd.md`; summary is the
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
- **Recommended Disposition:** `Approve` if 0 `[BLOCKER]` and ≤1 `[WARN]`;
  `Iterate` if any `[BLOCKER]` appears; `Approve with caveats` otherwise
- **Open Questions Doc:** if the skill produced an Open Questions doc
  (see `## Open Questions Convention` below), include its full Drive
  URL on its own line at the top of the gate brief, prefixed
  `Open Questions: <url>`. If no Open Questions doc was needed, omit
  this line entirely.

## Open Questions Convention

When step 3 (Research and expand) or step 5 (Self-evaluate) surfaces a
question the skill cannot resolve from `idea.md` alone, do **not** bury
the question in PDD prose. Instead, create a structured Open Questions
doc so (a) the e2e orchestrator can find sensible defaults to proceed
unblocked, and (b) the human reviewer can scan the questions in 30
seconds.

### When to create

- Stress-test rubric grades `partial` or `fail` on any dimension AND
  the underlying gap requires information that isn't in `idea.md`
- Step 3 surfaces a missing parameter (e.g. recruitment cap, language,
  consent process) where reasonable defaults exist but the call is the
  human's to make

If every question has a `pass`-quality answer in `idea.md`, **do not
create an Open Questions doc**. The doc has overhead — only spend it
when you'd otherwise force the orchestrator to halt or guess silently.

### File location and shape

Create `ACE/<opp-name>/open-questions.md` via `drive_create_file` as a
**Google Doc** (not plain text — the structured table renders properly
in Docs and reviewers actually read it). The body must be a table with
exactly four columns:

| # | Question | Default | Source |
|---|----------|---------|--------|
| 1 | What is the upper bound on visits per FLW per day? | 8 visits/day | idea.md §2; archetype default for `atomic-visit` |
| 2 | What language(s) should the Learn app support? | English only (single-LLO scope) | idea.md does not specify; LLO directory shows English speakers |

**Required for every row:**

- **#:** monotonically increasing, stable across iterations
- **Question:** one specific question per row, no compounds
- **Default:** the value the e2e orchestrator should use if no human
  responds before the next phase. Tagged `[Default]` inline in any
  prose elsewhere referencing this question. **Required, even if the
  default is "halt — human must answer."** That last value is fine for
  load-bearing decisions; the point is to make the default explicit so
  the orchestrator knows whether to proceed.
- **Source:** specific citation (e.g. `idea.md §2.1`, `archetype
  default`, `stress-test executability dimension`). No vague
  "research" or "common practice."

### Linking from the PDD and gate brief

- In the PDD body, cite the doc once near the top:
  `> **Open questions:** <drive-url>` (kept short — full content lives
  in the linked doc, not duplicated in PDD prose).
- In the gate brief, emit the `Open Questions: <url>` line per the
  contract above.

### Why `[Default]`

The e2e orchestrator (`/ace:run`) drives the full pipeline without
human pauses. Without a Default convention it has no signal for
"proceed with X" vs "halt for input." The `[Default]` tag is a
machine-readable contract: orchestrator picks the default in `--auto`
mode and surfaces the question + default in the run summary so the
human can correct after the fact if the default was wrong.

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
- **Auto:** Write PDD, email summary to admin group, proceed
- **Review:** Write PDD, present for human review, wait for approval

## Dry-Run Behavior
When `--dry-run` is active:
- Write the PDD to `ACE/<opp-name>/pdd.md` as normal
- Write the admin email summary (recipients, subject, body) to `comms-log/dry-run-idea-to-pdd.md`
- Do not send emails to the admin group
- State tracks as `dry-run-success`

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Replace weak self-eval with 5-question stress-test rubric (executability, verifiability, measurability, stage-gate clarity, resource realism); block at ≥2 non-pass; include grading anchors from vaccine-hesitancy and turmeric example PDDs; emit stress-test results as PDD appendix | ACE team (PM scout, focus-group framework lens) |
| 2026-04-15 | Fail fast with actionable error if `idea.md` is missing instead of improvising an idea | ACE team (PM scout, end-to-end UX lens) |
| 2026-04-17 | Emit gate brief at `ACE/<opp-name>/gate-briefs/idea-to-pdd.md` so the review-mode gate presents a checklist + stress-test concerns instead of a bare "approve PDD?" prompt | ACE team (PM scout, internal-admin lens) |
| 2026-04-20 | Extract stress-test rubric from Process step 5 into standalone `## LLM-as-Judge Rubric` section per author contract; process step now references the section | ACE team (skills review) |
