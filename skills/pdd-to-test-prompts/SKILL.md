---
name: pdd-to-test-prompts
description: >
  Derive opp-specific Q&A test prompts from an approved PDD. The output
  feeds the OCS deep gate in Phase 4: `ocs-chatbot-qa --deep` sends the
  prompts and embeds each `expected_answer_summary` in the transcript;
  `ocs-chatbot-eval --deep` uses those summaries as ground truth for
  LLM-as-Judge grading.
---

# PDD to Test Prompts

Generate the opp-specific test suite that the Phase 4 qa→eval pair uses as
its ground truth. Runs in Phase 1 (Design Review & Iteration) as Step 2,
right after `idea-to-pdd`.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md`

2. **Read the PDD's `Archetype:` field.** This skill branches on archetype
   — `atomic-visit` uses visit-centric categories, `focus-group` uses
   session-centric ones, `multi-stage` mixes both. See `## Archetypes`
   below for the full per-archetype category list. If the PDD has no
   Archetype field, default to `atomic-visit` but flag it as a `[WARN]`
   in the coverage self-check.

3. **Extract question-worthy material from the PDD.** Use the category
   list from the matching archetype branch in `## Archetypes`. For each
   category, generate 3–8 Q&A pairs drawing on the PDD content.

   Cross-archetype categories (always include regardless of archetype):
   - **Intervention basics** — "What is this opportunity about?" — answer
     from the intervention summary
   - **Escalation** — "What do I do if someone reports a safety concern?" —
     answers from the PDD's escalation triggers
   - **Training gaps** — questions the bot should tag `[training-gap]` if
     the answer is in the KB but the LLO didn't know
   - **Known product limitations** — questions the bot should tag
     `[product-feedback]`
   - **Out-of-scope** — 1–2 questions unrelated to the opportunity so the
     judge can check the bot declines gracefully

4. **Write the test prompt file** to
   `ACE/<opp-name>/test-prompts.md`:

   ```markdown
   # OCS Test Prompts — <opp-name>
   Derived from: pdd.md (rev YYYY-MM-DD)
   Total prompts: N

   ## Prompt 1
   **Category:** intervention-basics
   **Question:** What is this opportunity about?
   **Expected answer summary:** Brief mention of the intervention's goal
   (e.g., "turmeric market survey across 500 farmers in Karnataka over 8
   weeks"). Should cite the PDD.
   **Expected tags:** none
   **Expected escalation:** none

   ## Prompt 2
   ...
   ```

   Each prompt MUST include:
   - `Category` — groups by PDD section for the deep report breakdown
   - `Question` — the exact prompt to send
   - `Expected answer summary` — ground truth for the judge (1–3 sentences,
     the judge compares actual response against this)
   - `Expected tags` — which of `[training-gap]` / `[product-feedback]` (if any)
     the response should carry
   - `Expected escalation` — whether the response should mention
     `ace@dimagi-ai.com` / the admin group

5. **Self-evaluate coverage.** Before finishing, check:
   - At least one prompt per category in the PDD's archetype branch
   - At least one out-of-scope prompt
   - At least one that should trigger `[product-feedback]`
   - At least one that should trigger `[training-gap]`
   - At least one escalation prompt

   If any category is missing, go back to step 3 and add.

## Archetypes

ACE skills branch on the PDD's declared `archetype:` field. The category
lists here are what `ocs-chatbot-eval` will later grade responses
against, so getting them right for the archetype matters: FGD prompts
against an atomic-visit-worded category set will produce false-positive
failures in the deep eval gate.

### `atomic-visit` (default)

The PDD describes one FLW visit producing one structured delivery
(photo + GPS + form). Examples: turmeric market survey, household data
collection.

**Archetype-specific categories** (add to the cross-archetype categories
from step 3):

- **FLW visit flow** — "What does an FLW do on a first visit?" / "How
  long should a home visit take?" — answers from the visit protocol
- **Eligibility and edge cases** — "What do I do if a beneficiary is
  ineligible?" / "Can a single beneficiary be visited by two FLWs?" —
  answers from inclusion/exclusion rules
- **Data quality and GPS** — "Why is GPS required for each delivery?" /
  "What counts as a valid photo?" — answers from verification rules
- **Duplicate handling** — "What happens if I visit the same household
  twice?" — answers from duplicate-detection rules

### `focus-group`

The PDD describes FLW-facilitated group discussions producing qualitative
content (audio + per-section summaries + attendance). Examples:
vaccine-hesitancy Stage 1, lead-cosmetics formative FGDs.

**Archetype-specific categories** (add to the cross-archetype categories
from step 3):

- **Session flow** — "How long should a focus group session take?" /
  "What do I do between sessions on the same day?" / "When do I start
  recording?" — answers from the facilitation protocol
- **Recruitment and venue** — "How many participants should I have in a
  group?" / "Is it okay to hold the session in a health facility?" /
  "Should I separate mothers from grandmothers?" — answers from the
  recruitment plan and venue choice
- **Consent and recording** — "What do I do if someone doesn't want to
  be recorded?" / "Do I need written consent from every participant?" —
  answers from the consent protocol
- **Question-guide sequencing** — "Should I follow the guide in order?"
  / "When do I introduce the lead-exposure risk?" / "What if a
  participant brings up the risk topic before Section 5?" — answers
  from the question guide
- **Facilitation technique** — "What do I do if one participant is
  dominating?" / "How do I probe without leading?" / "Is silence okay?"
  — answers from the facilitator training and Learn app content
- **Output spec** — "How detailed does the per-section summary need to
  be?" / "What counts as a 'representative quote'?" — answers from the
  output specification in the PDD
- **Audio and evidence** — "How long does the audio recording need to
  be?" / "What if the audio quality is poor?" / "Can I skip the
  attendance photo if participants don't consent?" — answers from
  Layer A of the Evidence Model

### `multi-stage`

The PDD has two or more sequenced stages with different archetypes.
Generate prompts from the appropriate archetype branch for each stage,
prefixed with the stage name in the `Category` field (e.g.
`stage-1-session-flow`, `stage-2-data-quality`). Also add:

- **Stage-gate transition** — "When does Stage 1 end?" / "What has to
  be true before we start Stage 2?" — answers from the Stage Gate
  subsection of the PDD

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`

## Mode Behavior

- **Auto:** Generate the full prompt file, self-evaluate coverage, write it
- **Review:** Pause before writing to present the generated Q&A list for
  operator approval (this is the ground truth for Phase 4's deep gate, so
  getting it wrong causes cascading false failures downstream)

## Dry-Run Behavior

When `--dry-run` is active:
- Generate the prompt file content as normal
- Write to `comms-log/dry-run-test-prompts.md` instead of `test-prompts.md`
- State tracks as `dry-run-success`

## Failure Modes

- **PDD missing or empty** — blocker; Phase 1 Step 1 hasn't completed.
  Don't synthesize; escalate
- **PDD has no escalation/eligibility content** — the resulting test suite
  will be weak. Flag to operator that the PDD should be strengthened before
  proceeding; don't write a half-useful prompt file

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-14 | Initial version — introduced as Phase 1 Step 2 so Phase 4's `ocs-chatbot-qa --deep` has ground-truth opp-specific prompts to grade against. Previously `test-prompts.md` was referenced by `ocs-chatbot-qa` but had no producer | ACE team |
| 2026-04-19 | Added `## Archetypes` section branching on PDD archetype. `focus-group` gets session/recruitment/consent/question-guide/facilitation/output/audio categories; atomic-visit retains visit-flow/eligibility/GPS/duplicate categories; multi-stage mixes per-stage with an added stage-gate category. Motivated by cosmetics-fgd-pilot recon (2026-04-19) where the atomic-visit-only category list forced manual remapping | ACE team (qa/eval iteration loop) |
