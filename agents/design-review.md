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
  - { name: idea-to-pdd,         has_judge: true,  qa_skill: idea-to-pdd-qa, eval_skill: idea-to-pdd-eval }
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

### Step 1.4: Idea-to-PDD QA (structural pass/fail)

Invoke the `idea-to-pdd-qa` skill — runs 6 static structural checks against the produced PDD (sections present, archetype declared, stress-test appendix, success-metrics table populated, evidence-model layered, reviewer-comment table if referenced).

- Input: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
- Output: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd-qa_result.yaml`
- **QA gates eval:** if `verdict: fail`, attempt up to 2 auto-fix retries (regenerate PDD with `failures[].auto_fix_hint` instructions, re-run QA). After bounded retries, halt with `verdict: incomplete` for Phase 1 and surface failures to operator. NEVER silently proceed to eval when QA failed.
- **QA passing means the PDD is gradable, NOT that it's good** — eval (Step 1.5) grades quality.

### Step 1.5: Idea-to-PDD eval (independent quality re-grade)
Unless `--no-evals` was passed AND QA verdict is `pass`, invoke the `idea-to-pdd-eval` skill.
- Inputs: the same source material `idea-to-pdd` consumed
  (`inputs-manifest.yaml` + each manifest entry, plus run-root
  `idea.md` if present) + the produced PDD at
  `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
- Output: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd-eval_verdict.yaml` (machine-readable
  verdict in the shared shape — see `skills/README.md § QA vs Eval`)
- This is the independent QUALITY grader (post-0.13.88 the rubric is quality-only — structural correctness lives in QA above). A `verdict: fail` here does NOT halt the run on its own — the Phase 1→2 gate still uses the producing skill's `runs/<run-id>/1-design/idea-to-pdd_gate-brief.md`, and `[BLOCKER]` concerns from either source pause per the orchestrator's Per-Mode Pause Matrix.
- If QA verdict was `incomplete`, this step is **skipped** (eval emits `verdict: incomplete` mirroring QA's outcome).

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
Write phase summary to `ACE/<opp-name>/runs/<run-id>/1-design/design-review_summary.md`,
then write the `phases.design-review` block + flip `gates.idea-to-pdd`
per `agents/ace-orchestrator.md § Phase Write-Back Contract`. Required
top-level keys on the patch: `phases`, `gates`, `last_actor`, `last_actor_at`.
