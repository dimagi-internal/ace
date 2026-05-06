# `*-eval` skill template

Shared boilerplate for ACE's `*-eval` skills. The 12 LLM-as-Judge eval
skills are all structurally identical from a skeleton perspective —
only the rubric content differs. This file documents the shared
contract so each `*-eval` skill body can reference it instead of
duplicating ~30-50 lines of setup.

This is a **reference document**, not a skill. It is not invoked. It
is excluded from the skill catalog because the filename starts with `_`.

## Skeleton

Every `*-eval` skill follows this body skeleton:

```markdown
# <Skill Name>

(1-3 sentence framing — what this skill grades, why an independent
grader exists, who consumes the verdict.)

## Process

1. Read inputs from Drive.
2. Apply the rubric (per-skill specifics).
3. Write the verdict YAML — see "Verdict YAML contract" below.
4. Surface auto-concerns — see "Auto-surfaced severity rules" below.

## LLM-as-Judge Rubric

(Per-skill rubric. Dimensions, weights, deduction rules,
inflation guard if applicable.)

## Archetypes

(Per-archetype branches. See `skills/idea-to-pdd-eval/SKILL.md` for the
canonical 3-row table.)

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used`.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior`.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior`.

## Change Log

| Date | Change | Author |
|---|---|---|
```

## Verdict YAML contract

The verdict file is the unit `opp-eval` aggregates. Schema in
`lib/verdict-schema.ts`. **Filename uses the producer skill's name**,
not this eval skill's name (the Workbench attributes verdicts by
filename stem to the producer row). For example, `idea-to-pdd-eval`
writes `idea-to-pdd_verdict.yaml`, not `idea-to-pdd-eval_verdict.yaml`.

```yaml
skill: <eval-skill-name>          # this skill's name
target: <opp-name>
mode: quick | deep | monitor
ran_at: <ISO timestamp>
capture_path: <relative path to artifact under review>

overall_score: 8.4                # post-cap, weighted mean
overall_score_pre_cap: 8.6        # raw weighted mean (auditability)
verdict: pass | warn | fail | incomplete

dimensions:
  <dimension_name>: { score: 9.0, weight: 0.25 }
  # ... one entry per rubric dimension; weights sum to 1.0

per_item:
  - ref: "<dimension or check identifier>"
    score: 9.0
    verdict: pass | warn | fail
    note: "<one-line reasoning>"

auto_surfaced:
  - severity: BLOCKER | WARN | INFO
    message: "<surface text>"

gate:
  threshold: 7.5
  disposition: approve | reject | iterate
```

## Auto-surfaced severity rules

Every eval emits auto-surfaced concerns into the gate brief using
shared semantics:

- **`BLOCKER`** — gate fails. Surfaced when:
  - Any dimension scores ≤ 3.0
  - Overall score is below the gate threshold (default 7.0)
  - Hard-deduction rule triggered (rubric-specific; e.g. inflation cap)

- **`WARN`** — surfaced for human review but does not block:
  - Any dimension scoring 4.0–6.9
  - Inflation-guard cap binds (overall capped because self-eval was 5/5)
  - Cross-section inconsistency detected
  - False-disposition claim caught (when applicable)

- **`INFO`** — auditability surface, no action required:
  - Branch-swap notes (e.g. clean-source branch active)
  - Self-eval ↔ this-eval gap ≥ 1.5 points (calibration signal)
  - Out-of-scope items recorded with rationale

## Inflation guard pattern

Most evals run *after* a self-evaluation by the producing skill. To
catch over-confident self-grading, every eval includes an inflation
guard:

> If the producing skill's self-eval is `5/5` (or equivalent
> top-grade) and this rubric's overall is ≤ 8.0, cap overall at 8.0
> and surface a `WARN` recommending tightening of the producing
> skill's self-eval rubric.

Calibrate the threshold per rubric — see
`skills/eval-calibration/SKILL.md` for the methodology.

## MCP Tools Used (stock)

```markdown
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`
- No OCS calls
```

If a specific eval needs OCS, Connect, or Mobile atoms, list them
in addition to (not instead of) the stock block.

## Mode Behavior (stock)

```markdown
- **Auto:** Grade, write verdict + report, return overall score and
  disposition.
- **Review:** Pause after grading to let a human eyeball the verdict
  before the gate brief propagates.
```

## Dry-Run Behavior (stock)

```markdown
When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Write the verdict + report to Drive (human-facing artifacts).
- State tracks as `dry-run-success`.
```

## Calibration target boilerplate

Every eval skill includes a calibration block under `## LLM-as-Judge
Rubric`. The standard targets are:

```markdown
- **Detection rate:** ≥ 80% of catalogued issues from
  `eval-calibration/known-issues.md § <category>`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Agreement with self-eval:** within ±1.5 points of the producer's
  own grade. Larger gap is itself a calibration signal.
```

Override only when calibration is provisional (rubric flagged with
`provisional: true` in body) or when a specific eval has a tighter
or looser target documented in its rubric.

## Why this lives in `_eval-template.md`

Each `*-eval` skill body previously inlined ~30-50 lines of identical
boilerplate (verdict shape, severity rules, dry-run block, MCP tools,
mode behavior). 12 eval skills × 40 lines = ~500 lines of duplicated
content, and updating any contract required 12 edits with high drift
risk. Single source of truth here; per-skill bodies cite this file
instead.

When you add a new `*-eval` skill, copy the **Skeleton** above and
fill in only the per-skill rubric + framing.

When you change a shared contract (verdict shape, severity rules,
calibration target), edit this file once and the change propagates
to every eval automatically.
