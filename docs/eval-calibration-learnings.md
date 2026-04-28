# Eval Calibration — Session Learnings

Concrete patterns observed while calibrating ACE's `-eval` rubrics
across the 0.9.0–0.9.5 release trajectory. Written as a durable
reference for future eval-system iterations and as input to the
`eval-calibration` skill itself.

The trigger was the first end-to-end smoke run on `smoke-20260428-1242`
(see `ACE/smoke-20260428-1242/eval-calibration/`). The opp-eval
aggregator returned a confident PASS at 8.92/10 with only 1 of 6
categories actually scored — pure inflation. The first OCS chatbot
eval scored 8.98/10 despite a 12% factual-error rate and an empty
`cited_files` API field on every entry. Both were rubric-design
problems, not artifact problems. This doc captures what fixing them
taught us.

## The three-property invariant

A rubric is calibrated when, on a fixed input, it has all three:

1. **Detection rate ≥ 80%** against a per-opp ground-truth catalogue
   (`eval-calibration/known-issues.md`). The catalogue is human-
   authored after a real run — without it, all scores are vibes.
2. **Same-model variance ≤ 0.5** across ≥3 runs. Higher variance
   means rubric criteria are under-specified.
3. **Cross-model variance ≤ 1.0** across Sonnet/Opus/Haiku. The
   strong-calibration tier. If criteria are explicit enough,
   different models converge on similar overall scores even when
   they disagree on specific rule applications.

Provisionally calibrated = (1) + (2). Strongly calibrated = all
three. New rubrics ship at provisional; rubrics gating critical
decisions should move to strong before being trusted in production.

## Anti-patterns observed

These all surfaced in real calibration runs and got fixed mid-session.

### 1. Inflation by weight renormalization

`opp-eval` weighted-mean math ignored coverage. A 9.0 in 1 of 6
categories renormalized to weight 1.0 and produced a 9.0 PASS run-
level score — even though 5 categories were silently `null`.

**Fix:** coverage-aware verdict cap. 0–1 categories = `incomplete`;
2 = `warn` cap; 3 = `pass` cap if raw ≥7; 4+ = full normal verdict.
Score and coverage are reported separately so a high score on thin
coverage is no longer hidden.

### 2. Generosity by default

LLM-as-Judge rubrics with vague criteria cluster scores in 8–9
regardless of artifact quality. The original OCS rubric had
"correctness 0–10, factually accurate against KB" without explicit
deduction rules. A typo in 12% of responses didn't move the score.

**Fix:** explicit deduction rules with hard ceilings. "Factual error
→ 1-point deduction per occurrence; ceiling 7 on the affected
entry; same error in ≥2 entries → suite-level cap at 8.5." Every
rubric ships with explicit per-defect deductions.

### 3. "N/A defaults to perfect"

The OCS rubric's `refusal_correctness` dimension was supposed to
grade adversarial-prompt handling. When the test suite contained
zero adversarial prompts, the dimension defaulted to **10** ("not
applicable"). That silently credited 2.0 weighted points to the
overall — refusal discipline that was *literally never tested*
counted as perfect.

**Fix:** N/A defaults to **6 (warn)**, not 10. If a dimension
can't be measured, it's unmeasured, not perfect. The cap binds in
the score itself; gate briefs surface the coverage gap as `[INFO]`
separately. Tiered version (added 0.9.4): 0 prompts → cap 6; 1–2
→ cap 7; 3+ → no cap.

### 4. Cap collapses variance

The Learn rubric's inflation guard at 8.5 binds on every Learn
build today (every build has 3+ placeholder WARNs by design).
Same-model variance of 3 runs collapsed to 0.00 post-cap, masking
the 0.275 pre-cap spread.

**Fix:** record both `overall_score_pre_cap` and `overall_score_post_cap`
in verdict YAMLs. Pre-cap is what the variance protocol actually
measures; post-cap is what the user sees.

### 5. Self-eval over-confidence

Skills that self-evaluate inline (PDD stress test 5/5, app build
"0 warnings") tend to be too generous. The PDD self-evaluated 5/5
on its own stress-test rubric but missed a real Verifiability gap
(Layer B "AI-assisted photo content check" was aspirational, not
speccable today).

**Fix:** independent re-grade. The `idea-to-pdd-eval` rubric
re-runs the stress test from outside the PDD-writing context, then
compares. Hard ceiling 7.5 binds when self-eval scored 5/5 but the
independent grader marked any check ≤ partial.

### 6. Same-model variance is not enough

Three same-model runs of the OCS rubric all scored within 0.09 of
each other — looks calibrated. But cross-model variance revealed
that Haiku interpreted one rule ("out-of-scope counts as
adversarial") differently from Sonnet/Opus. Same-model anchoring
masked the rule ambiguity.

**Fix:** cross-model variance protocol on critical-decision rubrics.
If criteria are explicit, different models converge regardless of
rule-interpretation diffs (because dimensions counterbalance).
Spread ≤ 1.0 = strongly calibrated. Spread > 1.0 = the rubric is
leaning on judge-specific generosity rather than the criteria.

## Patterns observed

### Multi-dimensional scores are robust to single-rule disagreement

Cross-model OCS spread was 0.10 across 3 models even though Haiku
took a different read on one specific rule. The other dimensions
counterbalanced. Lesson: rubrics should have 4–7 dimensions, not 2–3.
A single-dimension rubric will be brittle to any judge interpretation
diff.

### Polish reduces variance, doesn't change central tendency

The 0.9.4 polish to OCS rubric (5 fixes) didn't change the median
score (7.62 → 7.67). What it changed was how the score was reached
— more deterministic deductions, fewer judge interpretation calls.
Central tendency is a property of the artifact; variance is a
property of the rubric.

### Cap activity is auditable signal

Every binding cap is a signal worth recording. The Learn rubric's
inflation guard binds on every build today (placeholder WARNs are
universal pre-LLO-deploy) — that's not a bug, it's the rubric
correctly reflecting "this build is structurally OK but not
deployable yet." Logging cap activity in verdict YAMLs lets future
maintainers see *which* defects drove which scores.

### Score trajectory across iterations is the audit trail

The OCS rubric scored 8.92 → 8.28 → 7.62 over three rubric
iterations on the same fixed transcript. Each delta is auditable
to a specific rubric edit. That trajectory IS the calibration
proof — without it, every rubric edit is "trust me, this is
better."

## Practical recipes

### Building a new `-eval` skill

1. Identify the artifact under judgment and its source-of-truth
   spec (PDD, idea.md, prior gate brief).
2. List 5–7 dimensions that cover what "quality" means for this
   artifact. Avoid 1–3 dimensions (too brittle) or 8+ (judge
   gets confused).
3. For each dimension, write at least one **hard deduction rule**
   tied to a concrete defect type. "Vague criteria → cluster 8-9";
   "explicit deduction rules → discriminate."
4. Add an **inflation guard** that binds when ≥2 WARN-tier
   defects compound. Cap at 8.5 by default.
5. Record both pre-cap and post-cap overall scores.
6. Add 3–5 ground-truth issues to the per-opp catalogue with
   `Detection target:` for each.
7. Calibrate via 3 same-model variance runs. If variance > 0.5,
   tighten criteria (less judge interpretation).
8. For critical-decision rubrics, run cross-model variance against
   Sonnet/Opus/Haiku. If spread > 1.0, find the rule diff and
   tighten language to imperative ("MUST" not "should").

### When same-model variance is suspiciously low (≤ 0.1)

Suspect anchoring. Either:
- Judges are pattern-matching their own previous output (run
  cross-model to break this);
- Or hard caps are binding on every run (record pre-cap separately
  to recover the underlying judge discretion).

### When you can't tell whether a rubric is calibrated

Re-run it on a known-good artifact and a known-bad artifact
side-by-side. A calibrated rubric scores ≥1.5 points lower on the
bad artifact. If they score within 0.5 of each other, the rubric
isn't discriminating.

## What's still open (as of 0.9.5)

- **Cross-model variance** on `pdd-to-deliver-app-eval` and
  `pdd-to-learn-app-eval`. (OCS and idea-to-pdd are strongly
  calibrated; the other two are provisional.)
- **Operator-effort tracking** in `state.yaml` — a meta-eval
  signal nobody else has today.
- **`cycle-grade` promotion** to a proper `-eval` skill. Phase 6
  hasn't run for a closed cycle yet so no ground truth.
- **`connect-program-setup-eval`** — unblocked by 0.8.0/0.8.1
  ace-connect MCP but needs a non-degraded run.
- **Adversarial test prompts** in real opps. The
  `pdd-to-test-prompts` skill now requires ≥15% adversarial
  coverage; needs to be exercised on the next opp run.

## See also

- `skills/eval-calibration/SKILL.md` — the methodology spec
- `skills/ocs-chatbot-eval/SKILL.md` — first strongly-calibrated rubric
- `skills/idea-to-pdd-eval/SKILL.md` — second strongly-calibrated rubric
- `skills/pdd-to-deliver-app-eval/SKILL.md` and
  `skills/pdd-to-learn-app-eval/SKILL.md` — cross-artifact rubric
  templates (provisional)
- `skills/opp-eval/SKILL.md` — coverage-aware aggregation
- CHANGELOG entries 0.7.0 → 0.9.5 — the audit trail
