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

2. **Extract question-worthy material from the PDD.** The PDD's
   structure — intervention summary, FLW visit flow, escalation triggers,
   compliance notes — is rich with questions an LLO might ask the ACE bot.
   For each section, generate 3–8 Q&A pairs covering:

   - **Intervention basics.** "What is this opportunity about?" — answer
     from the intervention summary
   - **FLW visit flow.** "What does an FLW do on a first visit?" /
     "How long should a home visit take?" — answers from the visit protocol
   - **Eligibility and edge cases.** "What do I do if a beneficiary is
     ineligible?" / "Can a single beneficiary be visited by two FLWs?" —
     answers from inclusion/exclusion rules
   - **Data quality and GPS.** "Why is GPS required for each delivery?" /
     "What counts as a valid photo?" — answers from verification rules
   - **Escalation.** "What do I do if an FLW reports a safety concern?" —
     answers from the PDD's escalation triggers
   - **Training gaps.** "How do I restart the app if it crashes?" —
     answers that the bot should tag [training-gap] if missing from KB
   - **Known product limitations.** "The app crashes on my phone when I
     take a photo" — answers that the bot should tag [product-feedback]
   - **Out-of-scope.** 1–2 questions that are unrelated to the opportunity
     so the judge can check the bot declines gracefully

3. **Write the test prompt file** to
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

4. **Self-evaluate coverage.** Before finishing, check:
   - At least one prompt per PDD section
   - At least one out-of-scope prompt
   - At least one that should trigger `[product-feedback]`
   - At least one that should trigger `[training-gap]`
   - At least one escalation prompt

   If any category is missing, go back to step 2 and add.

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
