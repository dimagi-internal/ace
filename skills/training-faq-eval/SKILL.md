---
name: training-faq-eval
description: >
  Grade the Phase 6 FAQ artifact for comprehensiveness against anticipated
  FLW/LLO questions, accuracy against the PDD + deployed apps, and
  scannability for a worker thumbing through it mid-visit.
disable-model-invocation: true
---

# Training FAQ — Eval

Grades `6-qa-and-training/training-faq.md`. The FAQ is the highest-traffic
training artifact: an FLW interrupted in the field needs to find the answer
to "where do I tap to retake the photo?" in seconds, and an LLO triaging
their first cohort needs the escalation matrix in front of them. An
independent grader catches comprehension/accuracy gaps that the producing
skill's self-eval routinely under-counts.

**Fitness axis (out-of-chain anchor).** "Does the FAQ list the catalogued
questions?" is a topic tally — a faithful build of a thin PDD passes it by
echoing the headings. The fitness dimension is `answer_usefulness`: does
each answer *actually resolve* the question for a worker mid-visit (vs the
question merely *appearing* with a hand-wave answer), and is it written for
the field rather than for a developer at a desk? It anchors on whether the
reader could act on the answer in the real world, not on whether the
question is present, and hard-gates an FAQ whose answers are present but
non-resolving. The comprehensiveness tally is demoted below it. See
`skills/_eval-template.md § The out-of-chain fitness requirement`.

See `skills/_eval-template.md` for shared verdict / severity / stock-block
contracts and `skills/eval-calibration/SKILL.md` for the calibration
methodology. Provisional rubric — calibration TBD until 3+ shipped FAQs
produce ground truth.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 | `6-qa-and-training/training-faq.md` | artifact under judgment |
| Phase 1 | `1-design/idea-to-pdd.md` | anchors anticipated questions (Operational Caps, Evidence Model, Stage Gate triggers) and archetype |
| Phase 3 | `3-commcare/app-deploy_summary.md` | deliver-app field paths + form names; verifies "tap this button" prose matches reality |
| Phase 5 | `5-ocs/ocs-bot-config.md` (if present) | escalation routing — FAQ should match what the bot tells FLWs |

## Products

- `6-qa-and-training/training-faq-eval_verdict.yaml` — verdict YAML per
  `_eval-template.md § Verdict YAML contract`. Filename uses the producer
  stem.

## Process

1. Read inputs from Drive.
2. Build an "anticipated-questions catalogue" from the PDD: Operational
   Caps (daily visit limits, payment per visit), Evidence Model Layer A
   rules (what photo counts, what GPS accuracy is needed), Stage Gate
   triggers (when does a visit get rejected), payment timing, support
   contact. This is the rubric's expectation set.
3. For each catalogue entry, check whether the FAQ surfaces an answer
   (or documents why it doesn't apply for this archetype). **Distinguish
   "question appears" from "answer resolves the question"** — read each
   answer and judge whether a worker mid-visit could actually act on it,
   not just whether the Q/A pair exists. Answer non-resolution is the
   `answer_usefulness` signal.
4. Apply the rubric and write the verdict YAML.
5. Surface concerns by severity per `_eval-template.md § Auto-surfaced
   severity rules`.

## LLM-as-Judge Rubric

Score each dimension 0–10. Weights sum to 1.0.

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Answer usefulness** (fitness — out-of-chain) | 0.30 | For each Q/A pair, does the *answer actually resolve the question* for a worker mid-visit — and is it written for the field, not for a developer at a desk? This is distinct from comprehensiveness: a question can *appear* with an answer that doesn't resolve it ("How do I retake the photo?" → "Use the photo retake feature."). Anchor on whether the reader could act on the answer in the real world. 10 = answers are imperative, concrete (name the actual UI control / the actual number / the actual next step), and each genuinely resolves its question. 6 = mixed — some answers resolve, others hand-wave or stay abstract; voice drifts toward spec-prose. 3 = answers are present but non-resolving (restate the question, point at a feature without saying how, or read like a spec doc). **Hard-gate: if the load-bearing answers (payment, photo/GPS recovery, escalation) are present but non-resolving, score ≤ 3 → suite verdict `fail`.** PDD silence on how something actually works is a finding here, not a free pass. |
| **Comprehensiveness** (conformance) | 0.20 | Does the FAQ surface answers to the top-N anticipated FLW/LLO questions catalogued from the PDD? 10 = covers ≥ 80% of catalogued questions, including all Layer A verification edges (photo retakes, GPS retry, consent gate). 6 = covers 50–80%; visible gaps in payment or escalation. 3 = covers < 50%; user would need to ask the bot for basic flow. Hard-deduct -3 if any of {payment-per-visit, daily-cap, support-contact} is missing entirely. |
| **Accuracy** | 0.20 | Every concrete claim (button labels, field names, numeric caps, payment amounts, escalation contacts) matches the PDD + deploy summary. 10 = no factual drift detected. 6 = ≤ 2 minor drifts (e.g., outdated screenshot caption, off-by-one cap). 3 = ≥ 3 drifts or one load-bearing inaccuracy (wrong payment number, wrong support email). Hard-deduct -5 for any contradicted operational cap. |
| **Scannability** | 0.15 | Can an interrupted FLW find their answer in ≤ 15 seconds? 10 = question-first headings, indexed/grouped by task, short answers, bolded keywords. 6 = walls of prose under generic headings; user must read paragraphs. 3 = no headings or anchors; FAQ is unusable mid-task. |
| **Anticipated-question depth** | 0.15 | Beyond the catalogued surface, does the FAQ anticipate edge cases the PDD implies (e.g., "what if the market is closed today?" for a market-survey opp)? 10 = surfaces ≥ 3 archetype-specific edge cases with answers. 6 = 1–2 surfaced. 3 = none; FAQ is rote. |

Weights sum to 1.0: 0.30 + 0.20 + 0.20 + 0.15 + 0.15 = 1.00.

**Hard-deduct rules:**
- Load-bearing answers present but non-resolving (`answer_usefulness` ≤ 3) → BLOCKER; suite verdict `fail`. A faithful echo of the catalogued questions with hand-wave answers does not earn a pass.
- Screenshot reference exists in markdown but resolves to a dead Drive ID → BLOCKER (cap overall ≤ 5).
- FAQ contradicts a PDD operational cap (e.g., FAQ says "10 visits/day" when PDD says 8) → BLOCKER.
- Any single dimension ≤ 3 → suite verdict `fail`.

**Inflation guard.** If `training-faq` self-eval graded itself top-tier
and this rubric's overall ≤ 8.0, cap overall at 8.0 and surface a
`[WARN]`. Default no-op until the producer ships a self-eval.

**Calibration target** (per `_eval-template.md § Calibration target boilerplate`):
- Detection rate ≥ 80% of catalogued FAQ issues from
  `eval-calibration/known-issues.md § Training FAQ` (catalogue TBD).
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Agreement with self-eval within ±1.5 points.

Provisional — flagged until first real run produces ground truth.

## Archetypes

| Archetype | Rubric tweak |
|---|---|
| `atomic-visit` | Default. Anticipated-question catalogue centers on per-visit flow, photo/GPS retries, payment per visit. |
| `focus-group` | Catalogue shifts to attendance, per-session payment, facilitator vs participant Qs. Comprehensiveness dimension expects FGD-specific entries. |
| `multi-stage` | Catalogue expects per-stage FAQ blocks + Stage-Gate-trigger explanations ("what does it mean my visit is in `stage_2_pending`?"). |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial version. 5 dimensions: comprehensiveness (0.35), accuracy (0.25), scannability (0.20), field_realism (0.10), anticipated_question_depth (0.10). Provisional rubric — calibration TBD until first real run grades the artifact. | ACE team (qa-eval-registry initial buildout) |
| 2026-05-29 | Promoted the fitness axis above the comprehensiveness tally: renamed `field_realism` → `answer_usefulness` (0.10→0.30, out-of-chain, hard-gate) and folded in an "answer actually resolves the question" judgment distinct from "question appears". Demoted comprehensiveness 0.35→0.20 (it was a topic tally); accuracy 0.25→0.20, scannability 0.20→0.15, anticipated_question_depth 0.10→0.15. Sum = 1.00. Per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. | ACE team (eval-fitness-gap) |
