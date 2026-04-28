---
name: opp-eval
description: >
  Umbrella judge that rolls every per-skill `-eval` verdict for an
  opportunity into a single run-level scorecard and emits improvement
  recommendations. Three modes: --quick (structural artifact check,
  no LLM cost), --deep (aggregate verdicts + scorecard + recommendations),
  --monitor (same as --deep plus append a trend line).
---

# Opportunity Eval

Aggregate every per-skill `-eval` verdict for an opportunity into a
single run-level scorecard, surface the weakest skills + dimensions,
and draft improvement recommendations. opp-eval is the **umbrella**
half of ACE's evaluation story — each per-skill eval judges its own
artifact in isolation; opp-eval judges the whole opp.

opp-eval is **ad-hoc** and **opt-in**. It is not part of the
`--mode review` auto-pause-at-gate flow. Run it anytime during or
after an opportunity to answer "how well did this run go overall, and
what should I improve?" — the operator's original ask for "one
overview judge/review agent that we can apply to overall runs."

See `skills/README.md § QA vs Eval — the two-phase pattern` for the
framework rationale and the uniform verdict-YAML shape that this
aggregator reads.

## Modes

| Mode | What it does | LLM cost | Writes |
|---|---|---|---|
| `--quick` | Structural-only: walk the artifact manifest for the opp's current phase, confirm every required (non-dated) artifact exists in the Drive folder. No verdict aggregation. | None | stdout summary + `scorecards/YYYY-MM-DD-opp-eval-quick.md` |
| `--deep` | Structural check **plus** aggregation: discover every `verdicts/*.yaml`, roll scores into skill-category dimensions, compute run-level verdict, emit per-skill narrative + improvement recommendations | LLM-as-Judge (recommendation drafting) | `scorecards/YYYY-MM-DD-opp-eval-deep.md` (human) + `verdicts/opp-eval-deep.yaml` (machine) + `gate-briefs/opp-eval-deep.md` (uniform contract; does not gate a phase today) |
| `--monitor` | Same as `--deep`, plus append a one-liner to `scorecards/trend.md` | LLM-as-Judge | Same as `--deep` + trend append |

If no mode is passed, default to `--quick`.

## Process

1. **Read the PDD for archetype context (best-effort, not required).**
   Look up `ACE/<opp-name>/pdd.md`. If present, read the `archetype:`
   field and `## Evidence Model` section and keep them in scope for
   recommendation phrasing. **If the PDD is missing, do not fail** —
   opp-eval is designed to work on partially-completed opps (that's
   exactly the point of `--quick`). Emit `[INFO] pdd.md not found —
   recommendations will be archetype-agnostic` and continue.

2. **Read `state.yaml`** from `ACE/<opp-name>/state.yaml` to determine
   the opp's current phase. This drives which manifest entries to check
   in step 3. If `state.yaml` is missing, assume `design` phase (only
   the earliest required artifacts are expected).

3. **Structural check (runs in every mode).** For each required,
   non-dated artifact in `lib/artifact-manifest.ts` whose `phase` is at
   or before the opp's current phase, verify the path exists in the
   Drive folder via `drive_list_folder`. Build three lists: `present`,
   `missing`, `unexpected`. Mirror the shape of `validateFixture()` in
   `lib/artifact-manifest.ts` — opp-eval is effectively the live-folder
   equivalent of that fixture-validation helper.

4. **Short-circuit on `--quick`.** Write the quick scorecard (see §
   Quick-mode output below), print a one-line stdout summary
   (`present/expected artifacts, N missing`), and stop. Do not read any
   verdict files. No LLM calls.

5. **Discover verdicts.** List `ACE/<opp-name>/verdicts/*.yaml`. For
   each file, parse as YAML. Expected top-level keys per
   `skills/README.md § QA vs Eval — the two-phase pattern`:
   `skill`, `target`, `mode`, `ran_at`, `capture_path`,
   `overall_score`, `verdict`, `dimensions`, optional `per_item`,
   optional `gate`.

   **Tolerate missing fields.** If a verdict YAML is malformed or
   missing a required key, **do not crash**. Emit
   `[INFO] skill <X> verdict missing required field <Y>` and continue.
   The aggregator must surface gaps, not hide behind them.

6. **Group verdicts into skill categories.** Map each verdict's `skill`
   to one of six run-level dimensions:

   | Category | Weight | Covers skills |
   |---|---|---|
   | `design`    | 0.20 | `idea-to-pdd`, `pdd-to-test-prompts` |
   | `commcare`  | 0.20 | `pdd-to-learn-app`, `pdd-to-deliver-app`, `app-deploy`, `app-test`, `training-materials` |
   | `connect`   | 0.15 | `connect-program-setup`, `connect-opp-setup`, `llo-invite` |
   | `ocs`       | 0.20 | `ocs-agent-setup`, `ocs-chatbot-eval-quick`, `ocs-chatbot-eval-deep` |
   | `operate`   | 0.15 | `llo-onboarding`, `llo-uat`, `llo-launch`, `ocs-chatbot-eval-monitor`, `flw-data-review`, `timeline-monitor` |
   | `closeout`  | 0.10 | `opp-closeout`, `llo-feedback`, `learnings-summary`, `cycle-grade` |

   Category weights sum to 1.0. Per-category score is the simple mean
   of all verdicts that map into the category. Categories with zero
   verdicts score `null` and their weight is redistributed proportionally
   across categories that **did** score — so a partial opp (e.g., still
   in Phase 3, no OCS verdict yet) gets a meaningful run-level number
   rather than an artificially low one.

7. **Compute the run-level overall score.** Weighted mean of the
   non-null category scores, with weights renormalized per step 6. The
   formula is: `sum(score_i * weight_i) / sum(weight_i)` for categories
   where `score_i` is not null.

8. **Classify the run-level verdict (coverage-aware as of 0.8.0).** The
   raw weighted-mean score is computed first; then **coverage** caps
   the verdict regardless of score. This is the explicit fix for the
   "1/6 categories scored 8.9 → run-level PASS" inflation surfaced by
   the first smoke run.

   Coverage tier (count of categories with score ≠ null, ignoring
   categories with `expected_at_phase` later than the opp's current
   phase):

   | Categories scored | Tier | Verdict cap | Notes |
   |---|---|---|---|
   | 0 | none     | `incomplete` | Nothing to grade |
   | 1 | thin     | `incomplete` | Single-category score isn't a run grade — flag `[INFO]` |
   | 2 | partial  | `warn` (max) | One cross-skill signal exists but most of the run is unmeasured |
   | 3 | adequate | `pass` if raw ≥ 7 | Half-coverage; raw score governs |
   | 4+ | full    | `pass` if raw ≥ 7; `warn` 4.0–6.9; `fail` <4.0 | Cross-skill view is real |

   The verdict cap applies AFTER the raw score: a 9.5 raw with
   1-category coverage emits `incomplete`, not a misleading PASS.
   `incomplete` is a new verdict introduced in 0.8.0 — downstream
   readers treat it as "needs more rubric coverage before this number
   is meaningful," not as a quality fail.

9. **Build per-skill breakdown.** For each discovered verdict, capture:
   - `ref` — the eval skill name + mode (e.g. `ocs-chatbot-eval-deep`)
   - `score` — the verdict's `overall_score`
   - `verdict` — pass / warn / fail
   - `note` — one-line summary: overall score + weakest-dimension name +
     its score. Weakest dimension is the `dimensions` entry with the
     lowest `score` value.

10. **Draft improvement recommendations (LLM-as-Judge).** For each
    verdict that is `warn` or `fail`, and for each `dimensions` entry
    with `score < 6.0` across **any** verdict, generate a one-line
    recommendation. Seed the prompt with:
    - The verdict YAML (full).
    - The relevant skill's `## LLM-as-Judge Rubric` section from
      `skills/<skill-name>/SKILL.md` if present — read with
      `drive_read_file`'s local-file equivalent (or by locating the
      skill definition under `skills/`). If the skill has no rubric
      section, emit `[INFO] skill <X> lacks a rubric — recommendation
      will be generic`. (That's the forcing function for per-skill
      rubric work.)
    - A terse instruction: "Given this verdict, propose one concrete
      change that would move the weakest dimension toward 8+."

    Keep each recommendation to a single sentence, imperative voice,
    actionable (point at a skill + what to change). Example:
    `"Tagging dimension consistently below 7.0 across 2 runs —
    consider tightening [training-gap] application rules in the golden
    template prompt"`.

11. **Write the machine-readable verdict** to
    `ACE/<opp-name>/verdicts/opp-eval-<mode>.yaml` (only for `--deep`
    and `--monitor`). Uses the shared verdict shape — see § Verdict
    YAML Shape below.

12. **Write the human-readable scorecard** to
    `ACE/<opp-name>/scorecards/YYYY-MM-DD-opp-eval-<mode>.md`. Shape
    documented in § Scorecard Output below.

13. **Write the gate brief (uniform contract).** For `--deep` and
    `--monitor`, emit `ACE/<opp-name>/gate-briefs/opp-eval-deep.md`
    (same path used by both modes — latest wins) using the shape in
    `agents/ace-orchestrator.md § Gate Brief Contract`. opp-eval does
    **not** gate any phase today; the brief exists for contract
    uniformity so future automation can consume it without a special
    case. See § Gate Brief below.

14. **In `--monitor` mode**, append a single-line entry to
    `ACE/<opp-name>/scorecards/trend.md` with date, overall score,
    each non-null category score, and the number of verdicts
    aggregated. One row per run so drift is visible at a glance.

## LLM-as-Judge Rubric

opp-eval's rubric is **aggregation rules**, not a per-response grader.
The per-skill verdicts already did the LLM-as-Judge grading; opp-eval
rolls those scores up and decides what's worth flagging as a
recommendation.

**Category scoring rules:**
- Per-category score = simple mean of the `overall_score` values of
  every verdict whose `skill` maps into that category (see the
  category table in step 6).
- Categories with zero verdicts score `null` (not 0). A missing verdict
  is an **information gap**, not a zero.
- Weights renormalize across the non-null categories so a partial opp
  isn't penalized for being early in its lifecycle.

**Run-level scoring rules:**
- Overall = weighted mean of non-null category scores.
- Verdict: pass ≥ 7.0 · warn 4.0–6.9 · fail < 4.0.

**Recommendation triggers (one recommendation per trigger):**
- Any verdict with `verdict: warn` or `verdict: fail`.
- Any `dimensions` entry (inside any verdict) with `score < 6.0`.
- Any skill-category with only 1 verdict when ≥ 3 are expected at the
  opp's current phase — surfaced as `[INFO] thin coverage` recommendation.

**What opp-eval will NOT do:**
- Re-grade any individual response. That's the per-skill eval's job.
- Invoke any `-qa` or `-eval` skill. Evidence is pre-captured; opp-eval
  only aggregates.
- Block a gate. The brief exists for uniformity, not gating.

## Archetypes

**This skill is archetype-agnostic by design.** Per-skill `-eval`
skills already applied archetype-specific rubrics when they graded
their own artifact (e.g., `cycle-grade` adds the Research Quality
dimension for `focus-group` PDDs). opp-eval reads the resulting
verdict scores without re-branching on archetype — it trusts the
upstream judgments.

The one place archetype matters is **recommendation phrasing**: if
the PDD is available, opp-eval reads `archetype:` in step 1 and
passes it to the LLM prompt in step 10 so recommendations land in the
right domain vocabulary (e.g., "tighten the FGD facilitator
instructions" for `focus-group` vs. "tighten the visit-flow prompt"
for `atomic-visit`). If the PDD is missing, recommendations are
archetype-agnostic.

## Verdict YAML Shape

Written to `ACE/<opp-name>/verdicts/opp-eval-<mode>.yaml` in `--deep`
and `--monitor` modes. Follows the shared shape from
`skills/README.md § QA vs Eval — the two-phase pattern`:

```yaml
skill: opp-eval
target: <opp-name>
mode: deep | monitor
ran_at: <ISO timestamp>
capture_path: verdicts/   # opp-eval reads a directory, not a single file

overall_score: 0.0-10.0    # weighted, renormalized across non-null categories
verdict: pass | warn | fail

dimensions:
  # For opp-eval, "dimensions" are skill categories. A null `score`
  # means no verdicts were found in this category; its weight is
  # renormalized away from the overall.
  design:       { score: X.X | null, weight: 0.20 }
  commcare:     { score: X.X | null, weight: 0.20 }
  connect:      { score: X.X | null, weight: 0.15 }
  ocs:          { score: X.X | null, weight: 0.20 }
  operate:      { score: X.X | null, weight: 0.15 }
  closeout:     { score: X.X | null, weight: 0.10 }

per_item:
  # One entry per verdict file discovered under verdicts/
  - ref: ocs-chatbot-eval-deep
    score: 8.4
    verdict: pass
    note: "Overall 8.4; weakest dim: tagging (6.8)"
  - ref: cycle-grade
    score: 6.2
    verdict: warn
    note: "Overall 6.2; weakest dim: research_quality (4.1)"

recommendations:
  # One per trigger from the rubric. Severity matches the trigger type.
  - for: ocs-chatbot-eval
    severity: warn
    recommendation: "Tagging dimension consistently below 7.0 across 2 runs — tighten [training-gap] application rules in golden template prompt"
  - for: cycle-grade
    severity: warn
    recommendation: "Research Quality scored 4.1 — consider adding an explicit FGD sampling plan section to the PDD template"
```

## Scorecard Output

### Quick-mode (`scorecards/YYYY-MM-DD-opp-eval-quick.md`)

```markdown
# Opportunity Eval — Quick
Opportunity: <opp-name>
Generated: <ISO timestamp>
Current phase (from state.yaml): <phase>

## Structural check

- **Present:** N / M required artifacts for phase <phase>
- **Missing:** <list, or "none">
- **Unexpected:** <files in the folder that aren't in the manifest, or "none">

## Notes

<One line per INFO from the structural scan. Concrete examples:
  [INFO] state.yaml missing — assumed design phase (default)
  [INFO] 2 unexpected files are operator-maintained (improvement-backlog.md, iteration-log.md); safe to ignore
  [INFO] pdd.md archetype: focus-group — deep-mode recommendations will use FGD vocabulary
If no INFOs to surface, write "None.">

_Run `--deep` to aggregate verdicts and get improvement recommendations._
```

**Stdout summary format** (always printed, both quick and deep modes):
```
opp-eval <mode>: <P>/<M> present, <K> missing, <U> unexpected (phase: <phase>)
```
Example: `opp-eval quick: 4/5 present, 1 missing, 2 unexpected (phase: design)`

### Deep / monitor (`scorecards/YYYY-MM-DD-opp-eval-<mode>.md`)

```markdown
# Opportunity Eval — <mode>
Opportunity: <opp-name>
Generated: <ISO timestamp>
Overall Score: X.X / 10 · Verdict: <pass | warn | fail>

## Category Breakdown

| Category | Score | Weight | Verdicts counted |
|---|---|---|---|
| design    | X.X | 0.20 | N |
| commcare  | X.X | 0.20 | N |
| connect   | —   | 0.15 | 0 (not yet run) |
| ocs       | X.X | 0.20 | N |
| operate   | X.X | 0.15 | N |
| closeout  | X.X | 0.10 | N |

## Per-Skill Results

| Skill | Score | Verdict | Weakest Dimension | Note |
|---|---|---|---|---|
| ocs-chatbot-eval-deep | 8.4 | PASS | tagging (6.8) | Overall 8.4; weakest dim: tagging |
| cycle-grade | 6.2 | WARN | research_quality (4.1) | Overall 6.2; weakest dim: research_quality |
| ... | ... | ... | ... | ... |

## Recommendations

- **[ocs-chatbot-eval · warn]** Tagging dimension consistently below 7.0 across 2 runs — tighten [training-gap] application rules in golden template prompt
- **[cycle-grade · warn]** Research Quality scored 4.1 — consider adding an explicit FGD sampling plan section to the PDD template

## Structural check

- Present: N / M required artifacts for phase <phase>
- Missing: <list, or "none">

## Notes

<Any [INFO] lines: missing PDD, malformed verdict YAMLs, skills without rubrics, thin coverage, etc.>
```

## Gate Brief

opp-eval does **not** gate any phase today. The brief is written for
contract uniformity so future automation (or ad-hoc operator review)
can consume it with the same reader used for the 5 real gate briefs.

Location: `ACE/<opp-name>/gate-briefs/opp-eval-deep.md` (single path
for both `--deep` and `--monitor`; latest invocation wins).

Shape follows `agents/ace-orchestrator.md § Gate Brief Contract`:

- **Artifact Under Review:** path to the scorecard under
  `ACE/<opp-name>/scorecards/`; summary is
  `<overall-score>/10 across <N> verdicts, run-level verdict <pass|warn|fail>`
- **What to Check** (emit these 4 items verbatim):
  - Overall score ≥ 7.0 and no category-level score below 5.0
  - Every expected skill category for the opp's current phase has
    at least one verdict (no information gaps)
  - Each recommendation has a concrete, actionable target — if any
    recommendation is too vague ("improve quality"), push back
  - Skills flagged as lacking a rubric are queued for rubric work
    before the next opp (forcing function)
- **Auto-Surfaced Concerns:** one line per signal:
  - `[BLOCKER]` if overall verdict is `fail`
  - `[WARN]` for each per-skill verdict that is `warn` or `fail`
  - `[WARN]` for each category whose score is below 5.0
  - `[INFO]` for each skill without a `## LLM-as-Judge Rubric` section
  - `[INFO]` for each category with no verdicts yet (thin coverage)
  - "None — all auto-checks passed." if pass with no warns
- **Recommended Disposition:** `Review` (opp-eval never auto-approves
  or auto-rejects a phase; the brief is advisory by design). Spell out
  `Review` verbatim so downstream readers don't confuse it with the 5
  gating skills' Approve/Reject/Iterate set.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_list_folder`,
  `drive_create_file`, `drive_update_file`
- No OCS calls — opp-eval reads pre-captured verdicts, it does not
  exercise any artifact

## Mode Behavior

- **Auto:** Walk the manifest, aggregate verdicts, write
  scorecard + verdict + brief. No pause. Print stdout summary.
- **Review:** Pause after aggregation to show the scorecard before
  writing the final files. The gate brief is advisory either way —
  there is no Approve/Reject prompt.

## Dry-Run Behavior

opp-eval has **no external side effects** (no emails, no API calls, no
tickets). In `--dry-run` mode it behaves identically to a normal run:
reads Drive, writes scorecard + verdict + brief to Drive. These are
all human-facing artifacts; Drive writes are not treated as effectful
for dry-run purposes (same convention as `ocs-chatbot-eval`).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-19 | Initial version — umbrella eval aggregator. Three modes (`--quick` / `--deep` / `--monitor`); rolls every `verdicts/*.yaml` into a run-level scorecard across 6 skill-category dimensions, emits improvement recommendations, and writes a uniform-contract gate brief (advisory; does not gate a phase). | ACE team (opp-eval rollout) |
| 2026-04-19 | Quick-mode template: add `Unexpected:` row (skill was already surfacing unexpected files but the template omitted it); tighten Notes wording with three concrete examples; specify stdout summary format including unexpected count. Surfaced in first run against a real partial opp (cosmetics-fgd-pilot) | ACE team (qa/eval iteration loop) |
