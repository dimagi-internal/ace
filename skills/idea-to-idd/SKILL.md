---
name: idea-to-idd
description: >
  Iterate on an idea to produce a well-specified Intervention Design Doc (IDD)
  for a Connect application. Defines the intervention, target FLWs, visit
  structure, and preferred LLOs.
---

# Idea to IDD

Take an initial idea and iterate on it to produce a complete Intervention Design
Doc (IDD) that specifies a Connect application.

## Process

1. **Read the initial idea** from the opportunity folder in GDrive
   (`ACE/<opp-name>/idea.md` or provided as input).

2. **Determine the delivery archetype** (see `## Archetypes` below). The archetype shapes the section list and the questions you ask in step 3. If the idea spans multiple delivery patterns (e.g., focus groups in Stage 1, atomic visits in Stage 2), pick `multi-stage` and assign an archetype to each stage.

3. **Research and expand** the idea:
   - What health/development problem does this address?
   - What is the intervention mechanism?
   - Who are the target beneficiaries?
   - What data needs to be collected (Learn app)?
   - What services need to be delivered (Deliver app)?
   - For non–`atomic-visit` archetypes, also work through the archetype-specific questions in `## Archetypes`.

4. **Draft the IDD** with the **base sections** below, plus **archetype-specific additions** from `## Archetypes`:

   **Base sections (all archetypes):**
   - **Archetype** — declared in frontmatter, repeated as the first heading
   - **Problem Statement** — what problem this solves
   - **Intervention Design** — how the intervention works
   - **Learn App Specification** — what FLWs need to learn (data collection, facilitation, etc., depending on archetype)
   - **Deliver App Specification** — what FLWs deliver (forms, sessions, etc., depending on archetype)
   - **Target Population** — beneficiary criteria, expected reach
   - **FLW Requirements** — number of FLWs, skills needed, geographic distribution
   - **LLO Preference** — preferred or known LLOs to execute, from LLO Directory
   - **Success Metrics** — how to measure if the intervention worked
   - **Evidence Model** — Layer A / B / C verification plan (see `## Evidence Model` in `templates/idd-template.md`)
   - **Timeline** — expected duration of the opportunity

5. **Self-evaluate (LLM-as-Judge) — Stress-Test Rubric.**

   Run this 5-question stress test against the drafted IDD. Each check is **pass / partial / fail**. If **two or more** checks are anything other than `pass`, the IDD is **not approved** — iterate on the weak sections and re-run the stress test before outputting.

   Background and worked examples for this rubric live in `docs/examples/idd-stress-test-observations.md`. Quote specific evidence from the IDD when grading; do not grade in the abstract.

   1. **Executability** — *Could an LLO read this IDD on day one and start work without asking clarifying questions?*
      Common failure modes: recruitment criteria unspecified (how is "under-vaccinated" determined? self-report vs. card vs. records), language and translation not addressed, facilitator/FLW skill level not stated, consent process missing, venue selection unspecified, participant compensation not mentioned.

   2. **Verifiability** — *For every claimed output, is there a concrete artifact we can collect and check?*
      Common failure modes: "summary of key themes" with no format/length/template, photo capture without standardization protocol (lighting, angle, distance, color reference), self-reported education delivery with no audit mechanism, qualitative outputs with no path from raw data to AI-ingestable form.

   3. **Measurability** — *Are success criteria defined for this stage, with units and targets?*
      Common failure modes: success described as "improved understanding" with no metric, sampling cap stated but no target, no per-segment or per-region targets, primary vs. secondary metrics not separated.

   4. **Stage-gate clarity** — *For multi-stage IDDs, what must be true at the end of this stage to proceed to the next?*
      Common failure modes: Stage 1 → Stage 2 transition undefined, no explicit "go / no-go / iterate" criteria, downstream stage references findings the upstream stage isn't required to produce.

   5. **Resource realism** — *Are the LLO's capabilities matched to what's being asked?*
      Common failure modes: focus-group facilitation skill assumed without training, ~50 participants to recruit across 6 segments with no recruitment plan, FLW asked to make subjective research judgments (Q12/Q13-style) the artifact should answer instead, photo/data quality dependencies on equipment LLOs may not have.

   **Grading anchors (worked examples):**

   The vaccine-hesitancy IDD at `docs/examples/idd-vaccine-hesitancy.md` is the canonical "fail" case. Expected grades:
   - Executability: **fail** — recruitment, language, facilitation, consent, venue all underspecified
   - Verifiability: **fail** — "summary of key themes" output spec is too thin to verify
   - Measurability: **partial** — Stage 2 has metrics, Stage 1 does not
   - Stage-gate clarity: **fail** — Stage 1 → Stage 2 transition undefined
   - Resource realism: **partial** — facilitation skill assumed; ~48-person recruit unscoped

   The turmeric-market-survey IDD at `docs/examples/idd-turmeric-market-survey.md` is the canonical "near-pass" case. Expected grades:
   - Executability: **partial** — "market" is free text but the cap depends on market identity
   - Verifiability: **partial** — photo standardization protocol missing; vendor education self-report unverifiable
   - Measurability: **partial** — caps stated, sampling targets missing
   - Stage-gate clarity: **pass** — single stage
   - Resource realism: **pass** — atomic-visit pattern is well-matched to FLW capability

   Both IDDs fail the rubric in their current form. The skill should surface those specific failures and either (a) iterate on the IDD to fix them, or (b) in review mode, hand off to a human with the failure list attached.

6. **Write the IDD** to `ACE/<opp-name>/idd.md` via Google Drive MCP. Include the stress-test rubric results as a `## Stress Test Results` appendix at the bottom of the IDD, so downstream skills (and humans) can see what was caught and what was waived.

## Archetypes

ACE skills branch on the IDD's declared `archetype:` field. This skill generates archetype-appropriate sections during step 4 (Draft).

### `atomic-visit` (default)
The IDD describes one FLW visit producing one structured delivery (photo + GPS + form). Use the base sections as-is. Examples: turmeric market survey, household-level data collection.

**Additional questions to answer in step 3:**
- What is the exact form structure (every field, every type)?
- What's the standardization protocol for any photo/measurement (lighting, angle, distance, color reference)?
- What's the per-FLW and per-location daily cap?
- How is duplicate detection handled (vendor ID, stall number, GPS resolution)?

### `focus-group`
The IDD describes FLW-facilitated group discussions producing qualitative content (audio + per-domain summaries + attendance). Examples: vaccine-hesitancy Stage 1.

**Additional questions to answer in step 3:**
- **Recruitment**: Who are the segments? How will participants be identified? What sample size per segment? Comparison groups and their justification?
- **Language**: Working language? Need translation? Facilitator language fluency?
- **Facilitation skill level**: Existing skill assumed, or training required? Probing/neutral framing/group dynamics covered in the Learn app?
- **Consent**: Verbal/written? Audio recording consent? Photo consent? Documented how?
- **Venue**: Neutral / facility / leader's compound? Each biases differently — which is acceptable?
- **Duration & compensation**: Expected session length? Participant opportunity cost compensated?
- **Question guide**: Sequencing (sensitive/program-specific questions last to avoid anchoring), prioritization (a 90-minute group covers 8–10 questions well, not 15+), warm-up questions, probing prompts.
- **Output spec**: What does a "good summary" look like? Format, length, template, required content per question domain. Without this, the qualitative outputs aren't AI-ingestable.

**Additional sections to include in the IDD draft:**
- **Recruitment Plan** — segments, sample sizes, identification mechanism, comparison groups
- **Facilitation Protocol** — skill level, training requirement, venue, language, consent, recording, compensation
- **Question Guide** — ordered questions per domain, with probes and warm-ups, and time allocation
- **Output Specification** — per-session summary format with concrete fields (themes, notable quotes, level of consensus, time spent, facilitator reflection)

### `multi-stage`
The IDD has two or more sequenced stages with different archetypes. Treat the base sections as describing the overall intervention and create one **Stage X** subsection per stage, each declaring its own archetype and following that archetype's additional sections.

**Required for multi-stage IDDs:** an explicit **Stage Gate** subsection between every pair of stages, stating exactly what must be true at the end of stage N to proceed to stage N+1 (with go / no-go / iterate criteria).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_update_file`

## Mode Behavior
- **Auto:** Write IDD, email summary to admin group, proceed
- **Review:** Write IDD, present for human review, wait for approval

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version | ACE team |
| 2026-04-08 | Replace weak self-eval with 5-question stress-test rubric (executability, verifiability, measurability, stage-gate clarity, resource realism); block at ≥2 non-pass; include grading anchors from vaccine-hesitancy and turmeric example IDDs; emit stress-test results as IDD appendix | ACE team (PM scout, focus-group framework lens) |
