---
name: training-onboarding-email-eval
description: >
  Grade the Phase 6 LLO onboarding email draft for warmth, clarity, and
  call-to-action effectiveness — the email Phase 9 sends to kick off
  LLO onboarding.
disable-model-invocation: false
---

# Training Onboarding Email — Eval

Grades `6-qa-and-training/training-onboarding-email.md`. Low-priority but
non-zero: this is the first contact ace makes with the LLO, and a cold,
ambiguous, or buried-CTA email correlates with slow Phase 9 response
rates. An independent grader catches the failure modes a producer's
self-eval typically rationalizes ("it's professional").

See `skills/_eval-template.md` for shared contracts. Provisional rubric —
calibration TBD; future signal expected from Phase 9 `llo-onboarding`
response-rate telemetry.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 6 | `6-qa-and-training/training-onboarding-email.md` | artifact under judgment |
| Phase 1 | `1-design/idea-to-pdd.md` | anchors LLO context (org name, region, intervention) and archetype |
| Templates | `templates/onboarding-email-template.md` | reference voice/structure baseline |

## Products

- `6-qa-and-training/training-onboarding-email-eval_verdict.yaml` — verdict
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
| **Clarity** | 0.30 | Can the LLO explain — in one sentence after reading — what this opportunity is, what's expected of them, and what the next step is? **Judge structure, not length — length is `length_discipline`'s job and must not be double-counted here (ace#1673).** 10 = single-paragraph context block, one named ask, one named CTA, follow-on steps visibly subordinate to it. 6 = readable but the ask or CTA is buried — it competes with follow-ons, or the reader has to hunt past a wall of context to find it. 3 = the ask is unclear; LLO would need to ask follow-up questions. Hard-deduct -3 if no concrete next step is named. |
| **Call-to-action effectiveness** | 0.25 | Is there exactly one primary CTA, with a deadline (or "by next week" relative phrasing), a named link/contact, and an estimated time commitment? 10 = all four present, CTA is unambiguous. 6 = CTA present but missing deadline OR time estimate. 3 = no CTA OR multiple competing CTAs. Hard-deduct -5 if no CTA at all. |
| **Context fidelity** | 0.15 | Org name, region, intervention domain match the PDD verbatim. 10 = no drift. 6 = 1 minor drift. 3 = any contradicted detail (wrong org name, wrong intervention domain). Hard-deduct -5 for any contradicted org-identifying detail. |
| **Length discipline** | 0.05 | Email is between 80 and 350 words, **counted excluding URLs**. 10 = within band. 6 = ≤ 500 words. 3 = > 500 words OR < 50 words (too thin). This is the ONLY dimension that scores length; `training-onboarding-email`'s producer band (200–350) sits inside it, so an email written to spec scores 10 here (ace#1673). |

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
- Future external signal: Phase 9 `llo-onboarding` response rates per
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
| 2026-08-26 | **Length is scored in exactly one dimension.** `clarity` carried `10 = ≤ 200 words` / `6 = ≥ 350 words` at weight 0.30 while `length_discipline` (0.05) carried an 80–350 band — so length was double-counted at 6× its own weight, and the producer's 200-word FLOOR was clarity's 10-anchor CEILING: no compliant email could score 10 on clarity. Re-anchored `clarity` on structure; length now lives only in `length_discipline`. The producer band was tightened 200-400 → 200-350 to match (the eval stays authoritative, per ace#1654). Enforced by `test/skills/onboarding-email-word-band.test.ts`. ace#1673. | ACE team |
| 2026-05-09 | Initial version. 5 dimensions: warmth (0.25), clarity (0.30), call_to_action_effectiveness (0.25), context_fidelity (0.15), length_discipline (0.05). Provisional rubric — calibration TBD until first real run grades the artifact; future external signal from Phase 9 `llo-onboarding` response rates. | ACE team (qa-eval-registry initial buildout) |
