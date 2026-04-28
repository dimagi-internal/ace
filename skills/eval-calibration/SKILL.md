---
name: eval-calibration
description: >
  Calibrate ACE's per-skill `-eval` rubrics so their scores are
  trustworthy. Defines the ground-truth catalogue per opp, the multi-run
  variance protocol, the detection-rate metric, and the iteration loop
  that turns a noisy rubric into a calibrated one. Read this before
  trusting any LLM-as-Judge score in production.
---

# Eval Calibration

ACE's evaluation system has a known generosity bias: LLM-as-Judge
scores cluster in the 8–9 range even when the artifact has real flaws.
The first OCS smoke run scored 8.92/10 despite a contact-email typo in
3/26 responses and an empty `cited_files` array on every entry. That
score isn't wrong arithmetic — it's wrong rubric.

This skill is the **calibration methodology** for fixing rubrics. It
doesn't grade artifacts; it grades rubrics. The output is a calibrated
rubric (revised `## LLM-as-Judge Rubric` section in some other skill's
`SKILL.md`) plus an audit trail showing the rubric got better, not
just different.

## The three properties a calibrated rubric must have

1. **Ground-truth detection** — given a transcript with known issues,
   the rubric flags the issues and deducts meaningfully (≥1 point on
   the relevant dimension).
2. **Inter-run stability** — running the rubric N times against the
   same input produces scores within ±0.5 of each other. Higher
   variance means the rubric prompt is under-specified.
3. **Inflation discipline** — the rubric is willing to score below 7.
   If scores cluster in 8–10 across all artifacts, the rubric isn't
   distinguishing quality.

## Process

### Step 1 — Build the ground-truth catalogue

Per opp folder: `ACE/<opp-name>/eval-calibration/known-issues.md`. One
section per artifact being evaluated. Each entry is a concrete,
human-confirmed flaw the rubric must detect:

```markdown
# Known Issues — <opp-name>

## OCS chatbot deep transcript (qa-captures/2026-04-28-ocs-chat-deep.md)

- **[factual]** Bot wrote `ace@dimagi.com` (missing `-ai`) in entries
  19, 22, 25. Detection target: ≥1-point Correctness deduction per
  occurrence; ≥1 `[WARN]` at suite level.
- **[structural]** API `cited_files` field is empty in all 26 entries
  despite `generate_citations: true` on the chatbot pipeline.
  Detection target: Source usage capped at ≤5.
- **[adversarial gap]** Suite contains 0 `should-refuse` and 0
  `hallucination-probe` prompts. The bot's refusal discipline is
  literally unmeasured. Detection target: `[INFO] thin adversarial
  coverage` in the gate brief.

## Deliver app build (app-summaries/deliver-app-summary.md)

- **[spec deviation]** Q8 split into Q8 + Q8b in the build (not in
  PDD). Detection target: `[WARN]` in pdd-to-deliver-app-eval.
- **[deferred enforcement]** Operational caps (≤20/FLW/day,
  ≤5/market/day, 25m duplicate detection) are server-side per the
  build summary, not in-form. Detection target: `[INFO]` not
  `[WARN]` (this is a documented platform limitation, not a build
  defect).
```

The catalogue is **manually authored** by the operator after a real
run. It's the "human-graded ground truth" — without it, all scores
are vibes.

### Step 2 — Run the current rubric, record the verdict

Invoke the eval skill (`ocs-chatbot-eval`, `pdd-to-deliver-app-eval`,
etc.) against the captured artifacts. Record the resulting verdict
YAML to `eval-calibration/<rubric-name>-runs.md` as run 1:

```markdown
# Calibration Runs — <rubric-name>

## Run 1 — <ISO timestamp>
Rubric version: <git SHA or VERSION>
Inputs: <capture path>
Verdict: <pass | warn | fail | incomplete>
Overall: <score>/10
Dimensions: { correctness: 9.7, source_usage: 7.3, ... }
Detection rate: <fraction of known issues flagged>/<total known>
Variance window: N/A (single run)
Notes: <what the rubric got right / missed>
```

### Step 3 — Score the rubric on detection rate

For each known issue in the catalogue, check whether the rubric's
verdict YAML surfaced it (deduction, `auto_surfaced` entry, gate-brief
flag, dimension cap). Compute:

```
detection_rate = issues_flagged / total_known_issues
```

Calibration target: **≥80% detection rate** on the ground-truth set.

### Step 4 — Run the rubric N times for variance

Sequentially invoke the same rubric against the same input ≥3 times
(harness serializes same-subagent-type Agent calls, so plan for
elapsed time = N × per-run cost). Record each run as a separate row.
Compute:

```
score_variance = max(overall) - min(overall)
```

Calibration target: **score_variance ≤ 0.5**. Higher variance means
the rubric prompt is under-specified — different LLM rolls of the
dice produce materially different scores.

### Step 5 — Iterate the rubric

If detection rate < 80% OR variance > 0.5, edit the relevant skill's
`## LLM-as-Judge Rubric` section. Common moves:

- **Tighten dimension criteria** with explicit deduction rules
  (e.g. "factual error → 1-point deduction, hard ceiling 7").
- **Add "inflation guards"** — pattern-detection rules that cap
  the overall score regardless of per-dimension math (e.g. "same
  factual error in ≥2 entries → cap overall at 8.5").
- **Add or split dimensions** when one dimension is doing too much
  work (e.g. split a single "quality" dimension into correctness +
  refusal correctness).
- **Specify ground-truth references** the judge prompt should cite
  ("compare against `expected_answer_summary`; deduct for any
  semantic divergence").

After editing the rubric, repeat steps 2–4. Append the new run with
the new rubric version to the same `<rubric-name>-runs.md` file.
**Do not delete prior runs** — the audit trail is the point.

### Step 6 — Stop when calibrated

A rubric is calibrated when:
- Detection rate ≥ 80% on the ground-truth set.
- Variance ≤ 0.5 across ≥3 consecutive runs.
- The score on a known-flawed artifact is below 8 (i.e., the rubric
  is willing to deduct meaningfully).

Mark the rubric calibrated in `<rubric-name>-runs.md`'s footer with
the calibrating commit SHA. Future rubric edits should re-run
calibration before merging.

## Invocation

This skill is **operator-driven**, not orchestrated. It runs ad-hoc
against an opp folder that already has captured artifacts and a
ground-truth catalogue:

```text
/ace:eval <opp-name> --calibrate <rubric-name>
```

(Slash command not yet implemented; for now invoke this skill
manually as part of the rubric-improvement loop. The
`<rubric-name>` argument selects which `-eval` skill to calibrate;
the catalogue and run-record paths derive from it.)

## What this skill does NOT do

- It does not grade artifacts directly. It grades rubrics. The
  per-skill `-eval` rubrics still do the artifact grading.
- It does not aggregate per-skill scores. That's `opp-eval`'s job.
- It does not run automatically as part of `--mode review` gates.
  Calibration is meta-eval — it's the work that happens between
  runs to make the next run's evals trustworthy.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`, `drive_create_folder`
- Whatever MCP tools the calibrated rubric needs (no direct
  calls from this skill — it dispatches the rubric)

## Why this matters

ACE's whole evaluation story is "LLM-as-Judge + umbrella
aggregation." Without calibration the LLM-as-Judge half is anchored
to model generosity, not artifact quality. Calibration is what makes
the evaluation system **self-improving** rather than
self-congratulating: every rubric edit must show measurable
improvement in detection rate or variance against a real
ground-truth set, captured in an auditable run-record.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. Defines the ground-truth catalogue, multi-run variance protocol, detection-rate metric, and iteration loop. Companion to `pdd-to-deliver-app-eval` and the tightened `ocs-chatbot-eval` rubric, both of which cite this skill as their calibration source. | ACE team (eval system buildout) |
