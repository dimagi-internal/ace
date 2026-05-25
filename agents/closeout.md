---
name: closeout
description: >
  Orchestrates opportunity closeout: invoice processing, LLO feedback
  collection, learnings summary, and overall cycle grading. Triggered
  when the opportunity reaches its end date.
model: inherit
phase: closeout
phase_display: Closeout
phase_ordinal: 10
skills:
  - { name: opp-closeout,       has_judge: false }
  - { name: llo-feedback,       has_judge: false }
  - { name: learnings-summary,  has_judge: false }
  - { name: cycle-grade,        has_judge: true,  eval_skill: cycle-grade-eval }
---

# Closeout Agent (Phase 10)

You handle the closeout of a completed CRISPR-Connect opportunity.

## Workflow

### Step 1: Invoice and Payment
Invoke the `opp-closeout` skill.
- Input: opportunity details, invoice data
- Output:
  - invoices pulled, Jira payment ticket created
  - Appended `closeout-depth`, `learnings-summary-scope` rows in `decisions.yaml` (merge-only; bar criterion per `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`).

### Step 2: LLO Feedback
Invoke the `llo-feedback` skill.
- Input: LLO contact info, opportunity context
- Output: feedback collected and documented

### Step 3: Learnings Summary
Invoke the `learnings-summary` skill.
- Input: feedback, data reviews, monitoring reports, OCS transcripts
- Output: comprehensive learnings doc, potentially a new PDD for iteration
- Depends on: Steps 1 and 2

### Step 4: Cycle Grade
Invoke the `cycle-grade` skill.
- Input: all opportunity artifacts and outcomes
- Output: overall grade with recommendations
- **LLM-as-Judge:** unless `--no-evals` was passed, dispatch
  `cycle-grade-eval` to independently re-grade. Writes
  `10-closeout/cycle-grade-eval_verdict.yaml`.
- Depends on: Step 3

### Completion
Write final summary to
`ACE/<opp-name>/runs/<run-id>/10-closeout/closeout_summary.md`,
then write the `phases.closeout` block per
`agents/ace-orchestrator.md § Phase Write-Back Contract`. Closeout has
no named gate (it's the terminal phase), so the patch sets
`phases.closeout.status: done` + `phases.closeout.verdict: closed`
without a `gates` field. Required top-level keys: `phases`,
`last_actor`, `last_actor_at`.
Email admin group with closeout report.
