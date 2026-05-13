---
description: Run the umbrella opp-eval aggregator on an opportunity, or fan per-step `-eval` skills out across an existing opp's artifacts
argument-hint: [<opp-name> --mode quick|deep|monitor | --all]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:eval

Run the `opp-eval` umbrella judge on an opportunity, or — with
`--all` — fan every applicable per-step `-eval` skill out across the
opp's existing artifacts.

The umbrella mode aggregates every per-skill `-eval` verdict found in
the opp's Drive folder into a single run-level scorecard across 6
skill-category dimensions and emits improvement recommendations.

`/ace:eval --all` is the **retroactive backstop** for the per-step
eval wiring in `/ace:run` (which dispatches `-eval` skills automatically
after each producing skill — see `agents/ace-orchestrator.md §
Per-Step Eval Hook`). Use it to score older opps that ran before the
wiring shipped, or to re-grade after a rubric is improved.

`/ace:eval` (no `--all`) is **ad-hoc** and **opt-in**. It is not part
of the `--mode review` auto-pause-at-gate flow. Run it anytime during or
after an opportunity to answer "how well did this run go overall,
and what should I improve?"

## Arguments

- `<opp-name>` — name of the opportunity (the `ACE/<opp-name>/`
  GDrive folder).
- `--mode quick|deep|monitor` — umbrella mode (default: `quick`).
  - `--quick` — structural artifact check only. Confirms every
    required, non-dated artifact for the opp's current phase exists
    in Drive. No LLM cost. Stdout summary + scorecard.
  - `--deep` — structural check **plus** aggregation: walk every phase
    folder under `runs/<run-id>/` collecting `*_verdict*.yaml`, compute
    category-level + run-level scores, draft improvement
    recommendations. Writes scorecard, verdict YAML, and an advisory
    gate brief into `8-closeout/opp-eval/`.
  - `--monitor` — same as `--deep` plus append a one-liner to
    `8-closeout/opp-eval/opp-eval_trend.md` so drift is visible
    run-over-run.
- `--all` — fan-out mode. Walks every phase-agent's
  `skills:` block, finds entries with an `eval_skill: <name>` (i.e.
  the producer has a registered `-eval` pair), confirms the producer's
  primary artifact exists in Drive, and dispatches the matching
  `-eval` skill. Skips entries where the producer artifact is
  missing or the eval skill is `inline-self-eval`. Mutually exclusive
  with `--mode`. After fan-out, runs the umbrella aggregator at
  `--mode deep` so the resulting verdicts roll up immediately.

## Process

1. Parse arguments. Default mode is `quick` if neither `--mode` nor
   `--all` is specified. If `--all` is set, ignore `--mode`.

2. Verify the opportunity folder exists in GDrive
   (`ACE/<opp-name>/`).

3. **Per-step fan-out (`--all` only).** Read each phase agent's
   frontmatter. For every `skills:` entry with `eval_skill: <name>`
   where `<name>` is not `inline-self-eval`:

   a. Read the producer's primary artifact path from Drive (e.g.
      `1-design/idea-to-pdd.md` for `idea-to-pdd`,
      `4-connect/connect-program-setup.md` for
      `connect-program-setup`). If absent, skip with an `[INFO]` log
      line; do not error.
   b. Dispatch the eval skill via `/ace:step <eval-skill> <opp-name>`.
      Each eval writes its verdict YAML to
      `runs/<run-id>/<phase>/<producer>-eval_verdict[-<mode>].yaml`
      per the naming convention.
   c. Continue on individual eval failures — log them, do not abort
      the fan-out. The umbrella step at the end will surface coverage
      gaps via `[INFO]` notes.

4. **Umbrella aggregation.** Dispatch the **opp-eval** skill with
   the opportunity context. Mode is the parsed `--mode` (default
   `quick`), or `deep` when `--all` was used.

The skill handles the structural check, verdict discovery,
aggregation, recommendations, and all file writes. See
`skills/opp-eval/SKILL.md` for the full process.

## Output

All under `ACE/<opp-name>/runs/<run-id>/8-closeout/opp-eval/`:

- `opp-eval_scorecard-<mode>.md` (human-readable)
- `opp-eval_verdict-<mode>.yaml` (machine-readable; `--deep` /
  `--monitor` only)
- `opp-eval_gate-brief-deep.md` (advisory; `--deep` / `--monitor`
  only — does not gate a phase)
- `opp-eval_trend.md` (append; `--monitor` only)

## Examples

```text
/ace:eval my-opp
  → --quick (default). Structural check only. Prints a one-line
    summary and writes 8-closeout/opp-eval/opp-eval_scorecard-quick.md.

/ace:eval my-opp --mode deep
  → Walk runs/<run-id>/<phase>/*_verdict*.yaml, compute run-level
    score across 7 categories, draft recommendations. Writes
    scorecard + verdict + gate brief under 8-closeout/opp-eval/.

/ace:eval my-opp --mode monitor
  → Same as --deep plus append a trend row to
    8-closeout/opp-eval/opp-eval_trend.md.

/ace:eval my-opp --all
  → Fan every applicable per-step `-eval` skill out across my-opp's
    existing artifacts (skipping any whose producer artifact is
    missing), then run the umbrella at --mode deep. Use this on opps
    that ran before per-step eval wiring shipped, or after improving
    a rubric.
```

Useful for:
- Post-opportunity review ("how did this one go?").
- Mid-run health check during an active opp.
- Recurring monitor to catch cross-skill drift.
- Retroactively scoring an older opp's per-step rubrics (`--all`).
