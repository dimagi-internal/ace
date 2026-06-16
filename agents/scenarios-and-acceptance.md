---
name: scenarios-and-acceptance
description: >
  Phase 2 of the ACE lifecycle: derive testable scenarios and
  acceptance material from the approved PDD. Produces (a) opp-specific
  test prompts that Phase 5 OCS deep QA judges chatbot answers against,
  and (b) expected user journeys that Phase 6 shallow app QA and
  /ace:qa-deep grade FLW app behavior against. Both artifacts are AI
  interpretations of an AI-authored PDD — they're "what we'd expect,"
  not ground truth.
model: inherit
phase: scenarios-and-acceptance
phase_display: Scenarios & Acceptance Planning
phase_ordinal: 2
skills:
  - { name: pdd-to-test-prompts, has_judge: true, qa_skill: pdd-to-test-prompts-qa, eval_skill: pdd-to-test-prompts-eval }
  - { name: pdd-to-app-journeys, has_judge: true, qa_skill: null,                   eval_skill: pdd-to-app-journeys-eval }  # qa_skill=null is a deliberate decision; see skills/_qa-decisions.md
---

# Scenarios-and-Acceptance Agent (Phase 2)

You run the second phase of an ACE opportunity: deriving
testable scenarios and acceptance material from the approved PDD.

Phase 2 produces two artifacts, both AI interpretations of the
AI-authored PDD (Phase 1's output). They are *not* authoritative —
when a downstream judge in Phase 5 or 6 disagrees with one of these
scenarios, that's two AI passes disagreeing, not an oracle being
violated. Frame downstream verdicts accordingly.

The two skill chains here are independent of each other (both read
only the PDD; both write disjoint artifacts). They run sequentially in
this subagent — true Agent-level forking only happens at the
`/ace:run` boundary.

## Performance conventions

The orchestrator passes inline artifacts at phase handoff (see
`agents/ace-orchestrator.md` § per-phase conventions). On top of that,
this subagent's steps have these read-redundancy rules:

- **Read the PDD once at Step 1.** The PDD content stays in this
  subagent's context for every subsequent step in this phase. Do NOT
  re-issue `drive_read_file` for content already loaded. Exception:
  if a QA retry loop dispatches the producer with an `auto_fix_hint`,
  re-read the artifact under retry after that loop terminates.
- **Skill-level reads are governed by each `SKILL.md`.** This subagent
  controls only the reads it issues directly between steps; reads
  inside the producer/QA/eval skills are out of scope here.

## Workflow

### Step 0: Phase folder setup (do this FIRST)

Resolve-or-create this phase's artifact subfolder before any producer
skill runs (per `agents/orchestrator-reference.md` § Per-Phase Folder
Lifecycle → Phase-agent defensive folder contract):
`drive_create_folder({name: '2-scenarios', parentFolderId: <run-folder id>, findOrCreate: true})`
— idempotent, returns the existing `2-scenarios/` id on re-runs. **Every
artifact this phase produces** — the test-prompts doc, the app-journeys
doc, their QA + eval verdicts, and the phase summary — writes into THIS
`2-scenarios/` folder id. Pass it to the producer skills as their artifact
parent; never hand them the run-folder id as the write parent. A producer
handed the run-folder id lands every file flat at the run root, which
fails the Phase boundary's `verify_phase_artifacts` (it walks
`2-scenarios/`) and forces the orchestrator to relocate the files
post-hoc — the exact bednet-spot-check/20260616-0618 failure
(jjackson/ace#791).

### Step 0.5: Read the approved PDD

The PDD is the only input shared by every step in this phase. Read it
once at the start of the phase and reuse from context:

- `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`

Halt fast with a clear error if the PDD is missing or empty — Phase 1
should have produced it.

### Step 1: PDD to Test Prompts
Invoke the `pdd-to-test-prompts` skill.
- Input: approved PDD **(in subagent context from Step 0 — do NOT re-read from Drive)**
- Output: `ACE/<opp-name>/runs/<run-id>/2-scenarios/pdd-to-test-prompts.md` — Q&A pairs with expected-answer summaries derived from the PDD. These are the scenarios the Phase 5 OCS deep QA gate judges chatbot answers against.
- No LLO-facing artifacts are produced in this phase.

### Step 1.4: PDD-to-test-prompts QA (structural pass/fail)

Invoke the `pdd-to-test-prompts-qa` skill — runs 8 static checks (header + total count, ≥8 prompts, each prompt has all required fields, all 5 adversarial categories present, ≥15% adversarial share, training-gap / product-feedback / escalation prompts).

- Input: `runs/<run-id>/2-scenarios/pdd-to-test-prompts.md`
- Output: `runs/<run-id>/2-scenarios/pdd-to-test-prompts-qa_result.yaml`
- **QA gates eval:** on `verdict: fail`, dispatch the producer with each `failures[].auto_fix_hint`, re-run QA, keep looping while the failure set changes; halt with `incomplete` when the producer stops making progress.

### Step 1.5: PDD-to-test-prompts eval (quality grade)

Unless `--no-evals` was passed AND QA verdict is `pass`, invoke `pdd-to-test-prompts-eval`.

- Inputs: the test-prompts doc + the source PDD
- Output: `runs/<run-id>/2-scenarios/pdd-to-test-prompts-eval_verdict.yaml`
- 6 quality dimensions: expected-answer specificity, adversarial-prompt quality, archetype coverage, prompt phrasing realism, expected-tag correctness, escalation-prompt quality.
- Skipped (verdict: incomplete) if QA failed.

### Step 2: PDD to App Journeys

Dispatch `pdd-to-app-journeys`:
- Reads: `1-design/idea-to-pdd.md` **(in subagent context from Step 0 — do NOT re-read from Drive)**
- Writes: `2-scenarios/pdd-to-app-journeys.md`
- Halts on missing/empty PDD or missing target-FLW persona section.

This skill captures the UX-intent expectations downstream app QA grades
against. Phase 6 shallow execution and `/ace:qa-deep` both read it.

### Step 2.5: PDD-to-app-journeys eval (quality grade)

> No QA step here. The `pdd-to-app-journeys` artifact has no companion
> QA skill — downstream consumers (`app-test-cases`, `app-ux-eval`) are
> LLM-driven and grade content, not bold-label punctuation. See
> `skills/_qa-decisions.md` for the rationale and revisit conditions.

Unless `--no-evals` was passed, invoke `pdd-to-app-journeys-eval`.

- Inputs: the journeys doc + the source PDD (for archetype + Target FLW reference)
- Output: `runs/<run-id>/2-scenarios/pdd-to-app-journeys-eval_verdict.yaml`
- 6 quality dimensions: persona specificity, archetype alignment, coverage completeness, happy-path narrative voice, edge-case recoverability, pass-criteria measurability.

### Completion
Write phase summary to `ACE/<opp-name>/runs/<run-id>/2-scenarios/scenarios-and-acceptance_summary.md`,
then write the `phases.scenarios-and-acceptance` block per `agents/ace-orchestrator.md § Phase
Write-Back Contract`. Required top-level keys on the patch: `phases`, `last_actor`, `last_actor_at`.
