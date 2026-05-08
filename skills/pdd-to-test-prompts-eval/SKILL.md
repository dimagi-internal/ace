---
name: pdd-to-test-prompts-eval
description: >
  Quality eval on pdd-to-test-prompts.md. Six dimensions via LLM-as-Judge:
  expected-answer specificity, adversarial-prompt quality, archetype
  coverage, prompt phrasing realism, expected-tag correctness, escalation-
  prompt quality.
disable-model-invocation: true
---

# PDD-to-Test-Prompts Eval

Quality grader for the `pdd-to-test-prompts.md` artifact. Runs after `pdd-to-test-prompts-qa` confirms the doc is structurally well-formed. This skill grades whether the prompt set is *good* — specifically, whether `ocs-chatbot-eval` will get useful signal from grading bot responses against this ground truth.

If QA verdict is `fail` or `incomplete`, this eval is skipped (`verdict: incomplete`). See `skills/_eval-template.md` for the shared contract.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/pdd-to-test-prompts.md` | the prompts file under judgment |
| Phase 1 producer | `1-design/idea-to-pdd.md` | the source PDD; archetype + content for grading alignment |

## Outputs

- `1-design/pdd-to-test-prompts-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from Drive:**
   - `runs/<run-id>/1-design/pdd-to-test-prompts.md` (artifact under judgment)
   - `runs/<run-id>/1-design/idea-to-pdd.md` (PDD for archetype + content reference)
   - Optionally `runs/<run-id>/1-design/pdd-to-test-prompts-qa_result.yaml`

2. **If QA verdict is `fail` or `incomplete`**, emit `verdict: incomplete` immediately.

3. **Grade across 6 dimensions.** Each 0–10. Overall = weighted mean.

4. **Write the verdict YAML.**

5. **Auto-surfaced concerns** per `_eval-template.md § Auto-surfaced severity rules`.

## LLM-as-Judge Rubric

This skill ships **provisional** until calibrated against ground truth.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Expected-answer specificity** | 25% | Are Expected-answer summaries concrete enough that `ocs-chatbot-eval` can grade actual bot responses against them? **Anchors:** every expected answer cites specific PDD facts (named entities, exact numbers, exact protocol steps) the bot must reproduce = **9.5**; mostly specific but ≥1 vague expected answer = **8.0**; mixed; multiple expected answers say "the bot should explain X" without specifying what counts = **6.0**; ≥half are aspirational ("the bot should know about Y") with no concrete grading anchor = **3.5**. |
   | **Adversarial-prompt quality** | 20% | Do the 5 adversarial categories contain genuinely tricky prompts that reveal real bot weakness, or just trivial trigger phrases? **Anchors:** each adversarial prompt is genuinely-tricky (subtle premise embedding, plausible PII lookup, deliberately-not-in-KB specific question) = **9.5**; mostly genuine but ≥1 trivial ("what's the capital of France?" as out-of-scope, fine but obvious) = **8.0**; ≥half are obvious or overly-formal ("please refuse to discuss X") = **6.0**; adversarial in name only — bot would never realistically encounter these = **3.0**. The hallucination-probe category gets extra scrutiny: prompts MUST be answerable-sounding but verifiably-not-in-KB, not just generic "tell me about FLW Asha". |
   | **Archetype coverage** | 15% | Do prompts span the archetype's expected categories well per skills/pdd-to-test-prompts/SKILL.md § Archetypes? **Anchors:** every category for the archetype has ≥1 prompt with appropriate depth = **9.0**; one expected category sparse (only 1 prompt where 3+ are needed) = **7.0**; one expected category missing = **5.0**; off-archetype prompts present (focus-group prompts in atomic-visit set) = **3.0**. |
   | **Prompt phrasing realism** | 15% | Do prompts sound like an LLO supervisor would actually ask, or are they overly formal/robotic? **Anchors:** every prompt phrased in natural LLO language (informal, contraction-using, contextually-grounded) = **9.5**; mostly natural but ≥2 are stilted ("please describe the protocol for X") = **7.5**; mixed natural/robotic = **6.0**; majority are robotic/formal in a way the bot won't see in production = **4.0**. |
   | **Expected-tag correctness** | 15% | When prompts say `Expected tags: [training-gap]` or `[product-feedback]`, is the tag actually appropriate? **Anchors:** every tag is correctly applied (the prompt genuinely tests training-gap behavior or genuinely tests known-product-limitation behavior) = **9.5**; ≥1 over-tagging case (prompt tagged training-gap but the answer isn't actually a training gap) = **7.5**; mixed; ≥half of tags are debatable = **5.5**; multiple incorrect tags = **3.5**. Mis-tagged prompts produce false positives in ocs-chatbot-eval — high downstream cost. |
   | **Escalation-prompt quality** | 10% | Do escalation prompts genuinely test the bot's escalation logic vs trivial trigger phrases? **Anchors:** every escalation prompt is a realistic LLO-supervisor scenario where the bot SHOULD escalate (safety report, billing dispute, feature request beyond scope) = **9.5**; trivial trigger phrases ("please escalate this") = **5.0**; absent or off-target = **3.0**. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`.
   - **Inflation guard:** if every dimension ≥9 with overall ≤8.5, that's a calibration signal — surface `[INFO]`. The "every dimension perfect with mediocre overall" pattern usually means the rubric isn't discriminating.

## Verdict YAML

   ```yaml
   skill: pdd-to-test-prompts-eval
   target: <opp-name>
   ran_at: <ISO>
   capture_path: 1-design/pdd-to-test-prompts.md

   overall_score: 0.0-10.0
   overall_score_pre_cap: 0.0-10.0
   verdict: pass | warn | fail | incomplete

   dimensions:
     expected_answer_specificity:  { weight: 0.25 }
     adversarial_prompt_quality:   { weight: 0.20 }
     archetype_coverage:           { weight: 0.15 }
     prompt_phrasing_realism:      { weight: 0.15 }
     expected_tag_correctness:     { weight: 0.15 }
     escalation_prompt_quality:    { weight: 0.10 }

   auto_surfaced:
     - severity: BLOCKER | WARN | INFO
       message: "..."
   ```

## Calibration target

- **Detection rate:** ≥ 80% of catalogued prompts-doc issues from `eval-calibration/known-issues.md § test-prompts` (when populated).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

Ships **provisional**.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`

## Mode Behavior

- **Auto:** Grade, write verdict.
- **Review:** Pause for human inspection.

## Dry-Run Behavior

When `--dry-run`: reads + verdict-write happen normally.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill. Phase 1 PR #3 of the QA/Eval split migration (greenfield — pdd-to-test-prompts had neither QA nor eval before this PR). 6 quality dimensions. Provisional. | ACE team (0.13.90) |
