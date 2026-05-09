---
name: training-onboarding-email-eval
description: >
  Grade the Phase 5 LLO onboarding email draft for warmth, clarity, and
  call-to-action effectiveness — the email Phase 8 sends to kick off
  LLO onboarding.
disable-model-invocation: true
---

# Training Onboarding Email — Eval

Grades `5-qa-and-training/training-onboarding-email.md`. Low-priority but
non-zero: this is the first contact ace makes with the LLO, and a cold,
ambiguous, or buried-CTA email correlates with slow Phase 8 response
rates. An independent grader catches the failure modes a producer's
self-eval typically rationalizes ("it's professional").

See `skills/_eval-template.md` for shared contracts. Provisional rubric —
calibration TBD; future signal expected from Phase 8 `llo-onboarding`
response-rate telemetry.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 5 | `5-qa-and-training/training-onboarding-email.md` | artifact under judgment |
| Phase 1 | `1-design/idea-to-pdd.md` | anchors LLO context (org name, region, intervention) and archetype |
| Templates | `templates/onboarding-email-template.md` | reference voice/structure baseline |

## Outputs

- `5-qa-and-training/training-onboarding-email-eval_verdict.yaml` — verdict
  YAML per `_eval-template.md § Verdict YAML contract`.

## Process

1. Read inputs from Drive.
2. Extract the email's structural beats (greeting, context, what-we're-asking,
   what-we-provide, CTA, sign-off).
3. Apply the rubric and write the verdict YAML.
4. Surface concerns per `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

Score each dimension 0–10. Weights sum to 1.0.

| Dimension | Weight | Anchored criteria |
|---|---|---|
| **Warmth** | 0.25 | Does the email sound like a person inviting a partner, not a system dispatching a notification? 10 = personal greeting using the LLO contact's name, acknowledgment of their organization's domain expertise, conversational register. 6 = polite but generic; could be a templated mass-mail. 3 = transactional, no acknowledgment of recipient as a partner. |
| **Clarity** | 0.30 | Can the LLO explain — in one sentence after reading — what this opportunity is, what's expected of them, and what the next step is? 10 = ≤ 200 words, single-paragraph context, named ask, named CTA. 6 = readable but ≥ 350 words OR ask/CTA buried. 3 = the ask is unclear; LLO would need to ask follow-up questions. Hard-deduct -3 if no concrete next step is named. |
| **Call-to-action effectiveness** | 0.25 | Is there exactly one primary CTA, with a deadline (or "by next week" relative phrasing), a named link/contact, and an estimated time commitment? 10 = all four present, CTA is unambiguous. 6 = CTA present but missing deadline OR time estimate. 3 = no CTA OR multiple competing CTAs. Hard-deduct -5 if no CTA at all. |
| **Context fidelity** | 0.15 | Org name, region, intervention domain match the PDD verbatim. 10 = no drift. 6 = 1 minor drift. 3 = any contradicted detail (wrong org name, wrong intervention domain). Hard-deduct -5 for any contradicted org-identifying detail. |
| **Length discipline** | 0.05 | Email is between 80 and 350 words. 10 = within band. 6 = ≤ 500 words. 3 = > 500 words OR < 50 words (too thin). |

**Hard-deduct rules:**
- No CTA → BLOCKER (cap overall ≤ 5; see CTA dimension).
- Wrong org name or contact name → BLOCKER (this is the email the LLO actually receives; getting their name wrong is fatal).
- Any single dimension ≤ 3 → suite verdict `fail`.

**Inflation guard.** If `training-onboarding-email` self-eval graded
itself top-tier and this rubric's overall ≤ 8.0, cap overall at 8.0 and
surface a `[WARN]`. Default no-op until the producer ships a self-eval.

**Calibration target** (per `_eval-template.md § Calibration target boilerplate`):
- Detection rate ≥ 80% of catalogued onboarding-email issues from
  `eval-calibration/known-issues.md § Training onboarding email` (catalogue TBD).
- Inter-run variance ≤ 0.5 across 3 same-model runs.
- Future external signal: Phase 8 `llo-onboarding` response rates per
  email — if response < 50%, recall the verdict and recalibrate.

Provisional until first real run produces ground truth.

## Archetypes

Onboarding emails are largely archetype-agnostic in v1; the cast +
intervention domain change but the structural rubric does not.
Placeholder for future per-archetype tweaks (e.g., a focus-group email
might need to mention session-scheduling cadence in the context block).

| Archetype | Rubric tweak |
|---|---|
| `atomic-visit` | Default; no rubric tweak. |
| `focus-group` | Context block expected to mention session cadence; clarity dimension's "what's expected" check looks for it. |
| `multi-stage` | Context block expected to mention multi-stage handoff; otherwise unchanged. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial version. 5 dimensions: warmth (0.25), clarity (0.30), call_to_action_effectiveness (0.25), context_fidelity (0.15), length_discipline (0.05). Provisional rubric — calibration TBD until first real run grades the artifact; future external signal from Phase 8 `llo-onboarding` response rates. | ACE team (qa-eval-registry initial buildout) |
