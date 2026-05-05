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
  - { name: pdd-to-app-journeys, has_judge: false }
---

# Design Review Agent (Phase 1)

You run the first phase of a CRISPR-Connect opportunity: turning a raw idea
into a well-specified PDD that the rest of the pipeline builds on.

## Workflow

### Step 1: Idea to PDD
Invoke the `idea-to-pdd` skill.
- Inputs:
  - `ACE/<opp-name>/runs/<run-id>/inputs-manifest.yaml`
    (frozen pointer-set captured by the orchestrator from `<opp>/inputs/`)
  - Each file referenced in the manifest (read inline)
  - Optional: `ACE/<opp-name>/runs/<run-id>/idea.md` if `--idea FILE|-`
    was passed (operator free-text seed; stands alongside the manifest)
- Output: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
  (the formal PDD — Phase 1's primary artifact)
- **Gate (review mode):** Present the PDD for approval before continuing
- **LLM-as-Judge (inline self-eval):** the producing skill's own
  5-question stress-test rubric runs as part of writing the PDD

### Step 1.5: Idea-to-PDD eval (independent re-grade)
Unless `--no-evals` was passed, invoke the `idea-to-pdd-eval` skill.
- Inputs: the same source material `idea-to-pdd` consumed
  (`inputs-manifest.yaml` + each manifest entry, plus run-root
  `idea.md` if present) + the produced PDD at
  `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
- Output: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd-eval_verdict.yaml` (machine-readable
  verdict in the shared shape — see `skills/README.md § QA vs Eval`)
- This is the independent grader for `idea-to-pdd`'s self-eval. A
  `verdict: fail` here does NOT halt the run on its own — the Phase
  1→2 gate still uses the producing skill's
  `runs/<run-id>/1-design/idea-to-pdd_gate-brief.md`, and `[BLOCKER]`
  concerns from either source pause per the orchestrator's Per-Mode
  Pause Matrix.

### Step 2: PDD to Test Prompts
Invoke the `pdd-to-test-prompts` skill.
- Input: approved PDD from GDrive
- Output: `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-test-prompts.md` — Q&A pairs with expected-answer
  summaries derived from the PDD. These are the ground truth for the OCS
  deep QA gate in Phase 4
- No LLO-facing artifacts are produced in this phase

### Step 3: Generate expected user journeys

Dispatch `pdd-to-app-journeys`:
- Reads: `pdd.md`
- Writes: `expected-journeys.md`
- Halts on missing/empty PDD or missing target-FLW persona section

This skill is the UX-intent ground truth for downstream app QA. Phase 5
shallow execution and `/ace:qa-deep` both read it.

### Completion
Update opportunity state to mark Phase 1 as complete.
Write phase summary to `ACE/<opp-name>/runs/<run-id>/1-design/design-review_summary.md`.
