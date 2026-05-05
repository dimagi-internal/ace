# Opportunity Eval — deep
Opportunity: CRISPR-Test-003-Turmeric
Generated: 2026-04-19T16:50:00Z
Overall Score: 8.4 / 10 · Verdict: pass

## Category Breakdown

| Category | Score | Weight | Verdicts counted |
|---|---|---|---|
| design    | —   | 0.20 | 0 (inline self-eval; no verdict YAML) |
| commcare  | —   | 0.20 | 0 (inline self-eval; no verdict YAML) |
| connect   | —   | 0.15 | 0 (inline self-eval; no verdict YAML) |
| ocs       | 8.4 | 0.20 | 1 |
| operate   | —   | 0.15 | 0 |
| closeout  | —   | 0.10 | 0 |

Overall = 8.4 (only the `ocs` category has a verdict; weights
renormalized across non-null categories).

## Per-Skill Results

| Skill | Score | Verdict | Weakest Dimension | Note |
|---|---|---|---|---|
| ocs-chatbot-eval-deep | 8.4 | PASS | tagging (6.8) | Overall 8.4; weakest dim: tagging |

## Recommendations

- **[ocs-chatbot-eval · info]** Tagging dimension scored 6.8 — tighten `[training-gap]` application rules in the golden template system prompt

## Structural check

- Present: 24 / 24 required artifacts for phase `closeout`
- Missing: none

## Notes

- [INFO] 5 of 6 skill categories have zero verdict YAMLs — most per-skill
  judges still self-evaluate inline. This is expected in 0.4.0; as
  per-skill rubrics land, opp-eval will pick them up automatically.
- [INFO] Skills without a `## LLM-as-Judge Rubric` section are queued
  for rubric work before the next opp.
