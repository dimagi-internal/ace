---
description: Run the umbrella opp-eval aggregator on an opportunity
argument-hint: [<opp-name> --mode quick|deep|monitor]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:eval

Run the `opp-eval` umbrella judge on an opportunity. Aggregates every
per-skill `-eval` verdict found in the opp's Drive folder into a
single run-level scorecard across 6 skill-category dimensions and
emits improvement recommendations.

opp-eval is **ad-hoc** and **opt-in**. It is not part of the
`--mode review` auto-pause-at-gate flow. Run it anytime during or
after an opportunity to answer "how well did this run go overall,
and what should I improve?"

## Arguments

- `<opp-name>` — name of the opportunity (the `ACE/<opp-name>/`
  GDrive folder).
- `--mode quick|deep|monitor` — execution mode (default: `quick`).
  - `--quick` — structural artifact check only. Confirms every
    required, non-dated artifact for the opp's current phase exists
    in Drive. No LLM cost. Stdout summary + scorecard.
  - `--deep` — structural check **plus** aggregation: walk
    `verdicts/*.yaml`, compute category-level + run-level scores,
    draft improvement recommendations. Writes scorecard, verdict
    YAML, and an advisory gate brief.
  - `--monitor` — same as `--deep` plus append a one-liner to
    `scorecards/trend.md` so drift is visible run-over-run.

## Process

1. Parse arguments. Default mode is `quick` if not specified.

2. Verify the opportunity folder exists in GDrive
   (`ACE/<opp-name>/`).

3. Dispatch to the **opp-eval** skill with the opportunity context
   and the selected mode.

The skill handles the structural check, verdict discovery,
aggregation, recommendations, and all file writes. See
`skills/opp-eval/SKILL.md` for the full process.

## Output

- `scorecards/YYYY-MM-DD-opp-eval-<mode>.md` (human-readable)
- `verdicts/opp-eval-<mode>.yaml` (machine-readable; `--deep` /
  `--monitor` only)
- `gate-briefs/opp-eval-deep.md` (advisory; `--deep` / `--monitor`
  only — does not gate a phase)
- `scorecards/trend.md` (append; `--monitor` only)

## Examples

```text
/ace:eval my-opp
  → --quick (default). Structural check only. Prints a one-line
    summary and writes scorecards/YYYY-MM-DD-opp-eval-quick.md.

/ace:eval my-opp --mode deep
  → Walk verdicts/*.yaml, compute run-level score across 6 categories,
    draft recommendations. Writes scorecard + verdict + gate brief.

/ace:eval my-opp --mode monitor
  → Same as --deep plus append a trend row to scorecards/trend.md.
```

Useful for:
- Post-opportunity review ("how did this one go?").
- Mid-run health check during an active opp.
- Recurring monitor to catch cross-skill drift.
