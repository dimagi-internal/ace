---
name: training-llo-guide-eval
description: >
  Grade the Phase 5 LLO guide for operational completeness (morning
  check-ins, daily caps, escalation triggers), action-orientation (the
  LLO knows what to do next), and screenshot grounding.
disable-model-invocation: true
---

# Training LLO Guide — Eval

Grades `5-qa-and-training/training-llo-guide.md`. The LLO guide is the
operating manual the local-leadership organization uses every day to run
the cohort. If it's a wall of theory rather than an action playbook,
Phase 8 onboarding stalls.

See `skills/_eval-template.md` for shared contracts. Provisional rubric —
calibration TBD until 3+ shipped LLO guides produce ground truth (see
`skills/eval-calibration/SKILL.md`).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 5 | `5-qa-and-training/training-llo-guide.md` | artifact under judgment |
| Phase 1 | `1-design/idea-to-pdd.md` | anchors operational caps, escalation matrix, archetype |
| Phase 3 | `3-connect/connect-program-setup.md` | LLO-facing Connect controls (program/opportunity status, payment approval flow) |
| Phase 4 | `4-ocs/ocs-bot-config.md` (if present) | bot escalation routing — guide must match how triage actually works |

## Products

- `5-qa-and-training/training-llo-guide-eval_verdict.yaml` — verdict YAML per
  `_eval-template.md § Verdict YAML contract`.

## Process

1. Read inputs from Drive.
2. Build an operational-coverage checklist from the PDD: morning
   check-in cadence, daily-cap enforcement, payment-approval workflow,
   escalation triggers (rejected visits, FLW absence, anomaly alerts),
   end-of-week reporting.
3. For each checklist entry, check (a) presence in the guide, (b)
   action-orientation ("if X, do Y"), (c) screenshot grounding when the
   action involves a UI step.
4. Apply the rubric and write the verdict YAML.
5. Surface concerns per `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

Score each dimension 0–10. Weights sum to 1.0.

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Operational completeness** | 0.35 | Does the guide cover the full daily/weekly LLO loop catalogued from the PDD (morning check-in, daily caps, escalations, payment approval, end-of-week report)? 10 = ≥ 80% of catalogued ops covered with concrete cadence. 6 = 50–80%; gaps in either escalation or payment. 3 = < 50%; LLO doesn't know what their day looks like. Hard-deduct -3 if escalation triggers are missing entirely. |
| **Action-orientation** | 0.25 | Each section reads "if X happens, do Y" rather than "the system supports X." 10 = imperative voice with named buttons/screens; LLO can act without re-reading. 6 = mixed; some sections are descriptive. 3 = mostly descriptive prose; LLO would need a synchronous walkthrough. |
| **Screenshot grounding** | 0.20 | Every UI-bound action references a screenshot (or has a clear "Screen: <X>" anchor). 10 = full grounding, all referenced Drive IDs resolve. 6 = ≥ 70% grounded, no dead links. 3 = < 50% grounded OR ≥ 1 dead screenshot reference. Hard-deduct -3 per dead Drive-ID reference. |
| **Cap & threshold accuracy** | 0.10 | Numeric caps (daily visits, payment amounts, escalation thresholds) match the PDD verbatim. 10 = no drift. 6 = 1 minor drift. 3 = any contradicted cap. Hard-deduct -5 for any contradicted operational cap. |
| **Escalation pathway clarity** | 0.10 | When something goes wrong (rejected visit, anomaly, FLW absence), does the LLO know exactly who/where to go? 10 = named contact, channel, expected response time. 6 = named contact only. 3 = vague ("contact support"). |

**Hard-deduct rules:**
- Dead screenshot Drive ID → BLOCKER (cap overall ≤ 5; see screenshot dimension).
- LLO guide contradicts a PDD operational cap → BLOCKER.
- Any single dimension ≤ 3 → suite verdict `fail`.

**Inflation guard.** If `training-llo-guide` self-eval graded itself
top-tier and this rubric's overall ≤ 8.0, cap overall at 8.0 and surface
a `[WARN]`. Default no-op until the producer ships a self-eval.

**Calibration target** (per `_eval-template.md § Calibration target boilerplate`):
- Detection rate ≥ 80% of catalogued LLO-guide issues from
  `eval-calibration/known-issues.md § Training LLO guide` (catalogue TBD).
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Agreement with self-eval within ±1.5 points.

Provisional until first real run produces ground truth.

## Archetypes

| Archetype | Rubric tweak |
|---|---|
| `atomic-visit` | Default. Coverage checklist centers on per-visit approval flow, daily cap enforcement, single escalation tier. |
| `focus-group` | Checklist adds session-scheduling, attendance verification, facilitator-stipend approval. Operational completeness dimension expects FGD-specific entries. |
| `multi-stage` | Checklist expects per-stage handoff procedures + Stage-Gate-trigger LLO actions. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`. Plus an
optional `drive_read_file` per referenced screenshot Drive ID — the
rubric resolves screenshot links to detect dead references.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial version. 5 dimensions: operational_completeness (0.35), action_orientation (0.25), screenshot_grounding (0.20), cap_threshold_accuracy (0.10), escalation_pathway_clarity (0.10). Provisional rubric — calibration TBD until first real run grades the artifact. | ACE team (qa-eval-registry initial buildout) |
