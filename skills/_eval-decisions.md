# Per-skill eval decisions

Comprehensive registry of every producer skill's eval status. **Every producer is in this table.** Missing-from-table is a contract violation, not a defaulting case — if you add a producer skill, add a row here.

This file is the canonical answer to "does skill X have eval, and why or why not?" The eval contract itself lives at [`_eval-template.md`](./_eval-template.md); the principle (when to use vs skip eval) lives at [`README.md § QA vs Eval`](./README.md). This file tracks **state**, not principle.

Companion to [`_qa-decisions.md`](./_qa-decisions.md). Where QA is structural correctness (binary), eval is quality judgment (0-10 scored via LLM-as-Judge).

## Status values

Five states cover every producer:

| Status | Meaning |
|---|---|
| **`has eval`** | A standalone `<producer>-eval` skill exists. Cell points at the skill + the PR that added it. |
| **`inline self-eval`** | The producer's own SKILL.md has an `## LLM-as-Judge Rubric` section it executes inline before completing. Cell points at the section. |
| **`covered by sibling eval`** | The producer's output is graded by a sibling-named eval skill (e.g. `app-screenshot-capture` graded by `app-ux-eval`; `ocs-agent-setup` graded by the runtime `ocs-chatbot-eval` pair). Cell names the sibling eval. |
| **`NO eval`** | Producer is a process/utility skill with no quality dimension to grade — binary success/fail, state-tracking, or covered upstream. Cell explains why. |
| **`not yet migrated`** | An eval skill would add value but hasn't been built. Cell states the candidate quality dimensions + revisit triggers. |

A sixth implicit state — *not applicable* — covers utility skills with no per-opp artifact. Listed but excluded from the migration count.

## When to skip eval

Default to **`NO eval`** when the producer's output is one of:

1. **Binary correctness** — the artifact is "correct" or "wrong"; there's no spectrum to score. Examples: `app-deploy` (build succeeded or failed), `commcare-form-patch` (patched or didn't), `app-connect-coverage` (clean or blocked).
2. **Process / state-tracking** — the producer's job is to advance external state, not produce a gradable artifact. Examples: `llo-invite` (sends emails), `solicitation-monitor` (polls for responses), `opp-closeout` (creates Jira ticket).
3. **Covered by a sibling eval** — the producer's output IS the input to another `-eval` skill that grades it. Don't double-grade. Example: `ocs-agent-setup` configures the bot; `ocs-chatbot-eval` grades the deployed bot's responses — that's where quality lives.
4. **The output IS the quality signal** — e.g., `llo-feedback` collects LLO feedback; the feedback itself is what's being measured, not the collection process.

When in doubt, ask: *what would a 3/10 vs 9/10 score on this artifact actually mean?* If you can't answer concretely, the artifact probably doesn't need eval.

## When eval belongs inline (vs companion `-eval` skill)

Same shape as the QA inline-vs-separate decision (see `_qa-template.md § When QA belongs inline`). Default to `inline self-eval` when:

1. The producer is a single LLM dispatch that authors and grades in the same context (no external-system iteration that would force re-dispatch).
2. The eval is a small rubric (2-3 dimensions) tied directly to the producer's process — not worth a separate skill to factor out.

Default to `has eval` (separate `-eval` skill) when:

1. The eval rubric is substantive (5+ dimensions, multi-page anchors).
2. Quality concerns warrant their own calibration corpus and re-runnable verdicts independent of producer dispatches.
3. The eval is consumed by `opp-eval` (umbrella aggregator) for cross-skill rollups.

Most ACE evals are companion `-eval` skills today. `inline self-eval` is rare but valid (`idea-to-pdd` does both — inline 5-question stress test + companion `idea-to-pdd-eval` that re-grades independently).

## Registry

### Phase 1 — design-review

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `idea-to-pdd` | **has eval + inline self-eval** | Companion `idea-to-pdd-eval` (slimmed to quality-only in PR #149). Plus inline 5-question stress-test rubric in producer's `## Process` step 6. The inline check fires during dispatch (gate-brief input); the companion eval re-grades independently. Both shapes valid here because they serve different roles — inline = producer self-aware halt, companion = independent grader. |
| `pdd-to-app-journeys` | **has eval** | `pdd-to-app-journeys-eval` (PR #150). 6 quality dimensions: persona specificity, archetype alignment, coverage completeness, happy-path narrative voice, edge-case recoverability, pass-criteria measurability. |
| `pdd-to-test-prompts` | **has eval** | `pdd-to-test-prompts-eval` (PR #151). 6 quality dimensions: expected-answer specificity, adversarial-prompt quality, archetype coverage, prompt phrasing realism, expected-tag correctness, escalation-prompt quality. |

### Phase 2 — commcare-setup

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `pdd-to-learn-app` | **has eval** | `pdd-to-learn-app-eval`. Grades whether the built Learn app structure matches the PDD's Learn spec, archetype-appropriate. |
| `pdd-to-deliver-app` | **has eval** | `pdd-to-deliver-app-eval`. Same shape for Deliver app. |
| `app-deploy` | **NO eval** | Binary process — uploads to CCHQ, build succeeds or fails. The quality of the deployed app is upstream (Nova autobuild) and downstream (`app-ux-eval` grades the running app). Nothing about the deploy step itself is graded on a 0-10 spectrum. |
| `app-release` | **has eval** | `app-release-eval`. Grades whether the release was done correctly (versioning, marker integrity, post-release CCZ projection). Quality dimension: did this release actually unblock Connect's deliver-unit sync? |
| `app-multimedia-coverage` | **NO eval** | Manual surgical patch — attaches images. Binary did/didn't apply correctly. The quality of the attached images themselves is a different concern (potentially handled by future `app-ux-eval` if media accessibility scoring is added). |
| `commcare-form-patch` | **NO eval** | TEMPORARY workaround that patches form XML. Binary success — patch applies cleanly or it doesn't. No quality dimension. |
| `app-connect-coverage` | **NO eval** | Verify+fix loop emitting `clean | blocked` verdict. Binary outcome — same shape as a QA. The "quality" of coverage IS the binary verdict. |

### Phase 3 — connect-setup

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `connect-program-setup` | **has eval** | `connect-program-setup-eval`. Grades whether the program shape (name, archetype-match) is appropriate for the opp. |
| `connect-opp-setup` | not yet migrated | **Eval candidate.** Sets up Connect opp with verification flags + payment units. Quality dimensions: appropriateness of verification flags for the archetype (e.g., GPS strict vs lenient), payment-unit count matches PDD's per-payment-unit spec, deliver-unit configuration matches Connect-Labs expectations. The producer is `inline QA` for structural correctness; an eval would grade *configuration appropriateness*. **Revisit when:** we've seen Connect opps fail to launch due to mis-configured flags more than once. Today, manual review at Phase 7→8 catches this. |

### Phase 4 — ocs-setup

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `ocs-agent-setup` | **covered by sibling eval** | The configured bot is graded by the runtime QA pair `ocs-chatbot-qa` + `ocs-chatbot-eval` (probes the deployed bot, evaluates responses). The configuration step itself doesn't need a separate eval — the bot's behavior IS the quality signal. |
| `ocs-chatbot-qa` (runtime QA) | **has eval** | Pairs with `ocs-chatbot-eval` — qa captures transcript, eval scores responses. Reference example for the runtime-exercise eval pattern. |
| `ocs-widget-handoff` (in `ocs-agent-setup`) | **has eval** | `ocs-widget-handoff-eval` evaluates the widget handoff artifact (URL valid, embed metadata correct, branding fields populated). Distinct from `ocs-chatbot-eval` (which grades responses). |

### Phase 5 — qa-and-training

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `app-screenshot-capture` | **inline self-eval + covered by sibling eval** | Producer has inline UX smoke judge (~2 LLM calls) for shallow scoring. The deep per-journey UX grading lives in `app-ux-eval` (runs from `/ace:qa-deep`, separate workstream). Two-tier: inline shallow (every Phase 5 run) + deep (`app-ux-eval`, on-demand). |
| `app-test-cases` | **NO eval** | Bindings YAML. Quality is "do the bindings resolve to real Nova form/field IDs and produce valid Maestro recipes" — that's structural (validated inline via `mobile_validate_recipe`), not gradable on a 0-10 spectrum. The downstream consumer (`app-ux-eval`) grades the actual app UX, not the bindings. |
| `training-faq` | not yet migrated | **Eval candidate.** Quality dimensions: comprehensiveness (covers anticipated questions), accuracy (matches PDD/app reality), scannability (mid-task FLW can find their answer fast). **Revisit when:** there's signal that LLO/FLW questions to the OCS chatbot expose FAQ gaps the human review missed. |
| `training-llo-guide` | not yet migrated | **Eval candidate.** Quality dimensions: operational completeness (morning check-ins, daily caps, escalation triggers all covered), action-orientation (LLO knows what to do), screenshot grounding. **Revisit when:** LLO onboarding feedback (Phase 8 `llo-feedback`) reveals guide gaps. |
| `training-flw-guide` | not yet migrated | **Eval candidate.** Quality dimensions: step-by-step concreteness (FLW with no context can follow), screenshot completeness, language accessibility. Same revisit trigger as `training-llo-guide`. |
| `training-onboarding-email` | not yet migrated | **Eval candidate, low priority.** Quality dimensions: warmth, clarity, call-to-action effectiveness. Could be measured via Phase 8 `llo-onboarding` response rates. |
| `training-quick-reference` | not yet migrated | **Eval candidate.** Quality dimensions: scannability (FLW glances mid-visit), coverage of key numbers (daily caps, payment per visit, support contact). Cheap to grade; defer until shipped to a real LLO. |
| `training-deck-outline` | not yet migrated | **Eval candidate.** Quality dimensions: pedagogical flow (intro → reference → walkthrough → recap), screenshot integration, anticipated-question coverage. |
| `training-deck-build` | **NO eval** | Renders the outline into Slides via the Slides API. Quality of the rendered deck IS the quality of the outline (graded above) plus visual consistency (graded by Slides template). Producer doesn't add quality — it transcribes. |
| `connect-baseline-screenshots` | not applicable | Cross-opp utility (per-Connect-version, not per-opp). Outside per-opp eval scope. |

### Phase 6 — synthetic-data-and-workflows

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `synthetic-narrative-plan` | **has eval** | `synthetic-narrative-plan-eval`. Grades manifest narrative quality (named FLWs feel realistic, anomalies tell a story, week-over-week arc is coherent). |
| `synthetic-data-generate` | **has eval** | `synthetic-data-generate-eval`. Grades fixture-data quality (FLW count + visit distribution match manifest, anomaly events plausibly seeded, payment timing realistic). |
| `synthetic-walkthrough-spec` | **has eval** | `synthetic-walkthrough-spec-eval`. Grades per-persona spec quality (scenes hit persona pain points, scoring rubric well-anchored). |
| `synthetic-walkthrough-run` | **covered by sibling eval** | Dispatches `canopy:walkthrough` which has its own per-scene scoring (canopy v0.2.79+: `canopy:visual-judge` Tough Judge methodology). Producer's job is orchestration; the canopy output IS already graded. |
| `synthetic-summary` | not yet migrated | **Eval candidate.** Quality dimensions: stakeholder-readiness (does the summary work for forwarding?), narrative coherence, completeness (links/labs URL/fixture folder all populated). Defer until first stakeholder forwarding signal. |
| `synthetic-workflow-seed` | **has eval** | `synthetic-workflow-seed-eval`. Grades workflow seeding quality (KPIs wired correctly to manifest, coaching tasks attached to right FLWs, render-code sane). |
| `synthetic-workflow-polish` | **has eval** | `synthetic-workflow-polish-eval`. Grades polish quality (visual coherence with opp domain, hero panels useful, anomaly callouts surface real anomalies). |

### Phase 7 — solicitation-management

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `solicitation-create` | **has eval** | `solicitation-create-eval`. Grades published solicitation quality (scope clarity, criteria measurability, evaluation framework completeness). |
| `solicitation-monitor` | **NO eval** | Recurring poll for responses. State-tracking; nothing to grade on a 0-10 spectrum. |
| `solicitation-review` | **has eval** | `solicitation-review-eval`. Grades the awardee recommendation (scoring rubric applied consistently, recommendation reasoning grounded in responses, no obvious bias). Critical for Phase 7→8 HITL gate quality. |

### Phase 8 — execution-management

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `llo-onboarding` | **NO eval** | Process skill — sends Connect invite + onboarding email. Binary success/fail. The quality of the onboarding email content is graded upstream by `training-onboarding-email-eval` (when shipped); the dispatch itself isn't graded. |
| `llo-launch` | **has eval** | `llo-launch-eval`. Phase 8 entry-quality grade (UAT verdicts considered, deep-QA freshness checked, activation timing appropriate). Critical pre-go-live gate. |
| `llo-invite` | **NO eval** | Email send loop. Process skill, no quality dimension. |
| `llo-uat` | not yet migrated | **Eval candidate, moderate priority.** Quality dimensions: UAT coverage completeness, LLO sign-off clarity, blocker resolution. Defer until UAT compilation reveals quality issues. |
| `flw-data-review` | **has eval** | `flw-data-review-eval`. Grades FLW data review quality (issue detection rate, recommendation actionability, prioritization). Recurring during active opp. |
| `timeline-monitor` | **NO eval** | Recurring state-tracking. No artifact to grade. |

### Phase 9 — closeout

| Producer | Eval status | Eval skill / rationale |
|---|---|---|
| `opp-closeout` | **NO eval** | Process skill — pulls invoices, creates Jira ticket. Binary success. |
| `llo-feedback` | **NO eval** | The collected feedback IS the quality signal (graded by humans during closeout review, not by an eval). |
| `learnings-summary` | not yet migrated | **Eval candidate.** Quality dimensions: opp-lifecycle coverage, recommendation actionability, calibration vs `cycle-grade`. Could share an eval with `cycle-grade-eval` or stand on its own. |
| `cycle-grade` | **has eval** | `cycle-grade-eval`. Grades the grade itself — calibration consistency across opps, evidence-grounding, archetype-appropriateness. Meta-eval. |

### Cross-cutting evals (not paired with a single producer)

| Eval skill | Role |
|---|---|
| `app-ux-eval` | Deep per-journey UX grading; runs from `/ace:qa-deep`. Consumes Phase 1 `pdd-to-app-journeys.md` + Phase 2 `app-test-cases.yaml` + Phase 5 screenshots. |
| `opp-eval` | Umbrella aggregator across all per-skill eval verdicts. Per CLAUDE.md, produces opp-level rollup. |
| `eval-calibration` | Meta-skill — calibrates other evals' rubrics against ground-truth catalogues per `eval-calibration` methodology. Not a per-opp producer. |

### Utility / cross-cutting (no per-opp artifact)

| Producer | Eval status | Rationale |
|---|---|---|
| `email-communicator` | not applicable | Utility — sends mail. |
| `decisions-render` | not applicable | Utility — renders decisions.yaml. |
| `decisions-sync` | not applicable | Utility — syncs decisions log. |
| `upload-transcript` | not applicable | Utility — ingests JSONL transcripts. |
| `eval-calibration` | not applicable | Meta-skill listed above; not a per-opp producer. |

## Maintenance

Same contract as `_qa-decisions.md`:

- When a new producer skill ships, add a row in the appropriate Phase section.
- When a producer's eval status changes, update the row.
- Cross-link from the producer's own `SKILL.md § Change Log`.
- Future CI lint enforces every `producedBy` in `lib/artifact-manifest.ts` has a row in this table (sibling check to the QA registry coverage).

## Eval-self-QA (deferred separate workstream)

Per the migration spec's Phase 7: every `-eval` skill could get a small QA on its verdict YAML schema (verifying weights sum to 1.0, dimensions match the schema, severity tags valid). Cheap, mechanical, can land as a single shared `verdict-yaml-qa` helper.

Not yet built. When shipped, will add a row to `_qa-decisions.md` for each `-eval` skill (effectively `verdict-yaml-qa` covers all of them).

## Change log

| Date | Change | Author |
|---|---|---|
| 2026-05-09 | Initial registry. Mirrors `_qa-decisions.md` structure. Captures 17 `has eval` (companion `-eval` skill exists), 1 `inline self-eval` only (`idea-to-pdd` has both inline + companion), 2 `covered by sibling eval` (`app-screenshot-capture` via `app-ux-eval`; `ocs-agent-setup` via runtime `ocs-chatbot-qa`/`-eval` pair), 12 `NO eval` (binary process / state-tracking / covered upstream), 5 `not applicable` (utilities), 11 `not yet migrated` (eval candidates with stated revisit triggers — most concentrated in the training cluster + closeout cluster). Plus 3 cross-cutting evals (`app-ux-eval`, `opp-eval`, `eval-calibration`) listed separately since they don't pair with a single producer. | ACE team |
