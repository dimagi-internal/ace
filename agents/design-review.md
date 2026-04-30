---
name: design-review
description: >
  Phase 1 of the CRISPR-Connect lifecycle: iterate an initial idea into an
  approved Program Design Document (PDD) and derive opp-specific test
  prompts for later OCS chatbot evaluation.
model: inherit
phase: design-review
phase_display: Design Review
phase_ordinal: 1
skills:
  - { name: idea-to-pdd,         has_judge: true,  eval_skill: idea-to-pdd-eval }
  - { name: pdd-to-test-prompts, has_judge: false }
---

# Design Review Agent (Phase 1)

You run the first phase of a CRISPR-Connect opportunity: turning a raw idea
into a well-specified PDD that the rest of the pipeline builds on.

## Workflow

### Step 1: Idea to PDD
Invoke the `idea-to-pdd` skill.
- Input: initial idea (from Neal or the opportunity brief) at `ACE/<opp-name>/idea.md`
- Output: `ACE/<opp-name>/pdd.md`
- **Gate (review mode):** Present the PDD for approval before continuing
- **LLM-as-Judge (inline self-eval):** the producing skill's own
  5-question stress-test rubric runs as part of writing the PDD

### Step 1.5: Idea-to-PDD eval (independent re-grade)
Unless `--no-evals` was passed, invoke the `idea-to-pdd-eval` skill.
- Input: `ACE/<opp-name>/idea.md` + `ACE/<opp-name>/pdd.md`
- Output: `ACE/<opp-name>/verdicts/idea-to-pdd.yaml` (machine-readable
  verdict in the shared shape — see `skills/README.md § QA vs Eval`)
- This is the independent grader for `idea-to-pdd`'s self-eval. A
  `verdict: fail` here does NOT halt the run on its own — the Phase 1→2
  gate still uses the producing skill's `gate-briefs/idea-to-pdd.md`,
  and `[BLOCKER]` concerns from either source pause per the
  orchestrator's Per-Mode Pause Matrix.

### Step 2: PDD to Test Prompts
Invoke the `pdd-to-test-prompts` skill.
- Input: approved PDD from GDrive
- Output: `ACE/<opp-name>/test-prompts.md` — Q&A pairs with expected-answer
  summaries derived from the PDD. These are the ground truth for the OCS
  deep QA gate in Phase 4
- No LLO-facing artifacts are produced in this phase

### Completion
Update opportunity state to mark Phase 1 as complete.
Write phase summary to `ACE/<opp-name>/design-review-summary.md`.
