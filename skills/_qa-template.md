# `*-qa` skill template

Shared boilerplate for ACE's `*-qa` skills. QA skills do **structural correctness** checks — binary pass/fail, hard do-not-pass-go failures, AI-fixable. They run before eval; if QA fails irrecoverably, eval is skipped.

This is a **reference document**, not a skill. It is excluded from the skill catalog because the filename starts with `_`.

See `skills/README.md § QA vs Eval` for the full principle. This file documents the QA-specific contract.

For per-skill QA status — which producers have a `-qa` companion, which deliberately don't, and which are pending — see [`_qa-decisions.md`](./_qa-decisions.md). That file is the registry; this one is the contract.

## What QA checks

A QA check answers: **"is the artifact structurally correct enough to grade?"** It does NOT answer: "is the artifact good?" — that's eval's job.

The line is: if the AI can typically fix the issue by re-reading inputs and trying again, it's QA. If fixing requires substantive design decisions or value judgments, it's eval.

**Examples of valid QA checks:**

- Required sections are present (regex over headings)
- Required fields are non-null (parse + check)
- Verdict YAML weights sum to 1.0 (arithmetic)
- Reviewer-comment table has a row per source comment (table parse)
- File counts match expected (filesystem listing)
- Schema validation passes (Zod / JSON-schema)
- Phase-foldering is correct (path matches `runs/<run-id>/<phase>/...`)
- Numeric values match across sections where consistency is mechanical (regex compare)
- Required input artifacts exist before the producer ran (precondition check)

**Examples that are NOT QA checks** (these belong in eval):

- "Is the section substantive vs just present?" → eval
- "Are dispositions concrete vs hand-waved?" → eval
- "Does the budget cover the implied labor at recruitment-realistic rates?" → eval
- "Does the archetype match the spirit, not just the declaration?" → eval

## When to skip QA

Some producers don't benefit from QA at all. The decision to skip QA is deliberate, not the absence of one — it's recorded per-skill in [`_qa-decisions.md`](./_qa-decisions.md) so future audits can tell "we skipped this on purpose" from "we haven't gotten to it yet."

Default to **`NO QA`** when **all three** are true:

1. **Downstream consumers are LLM-driven.** They read the artifact as prose context, not via regex/parser. The LLM doesn't care about exact label punctuation.
2. **No code path branches on the artifact's structure.** No CI check, no orchestrator decision, no skill that dispatches differently based on which sections are present.
3. **Quality is what matters, and the eval grades it.** The companion `-eval` skill's dimensions cover the substantive concerns — specificity, recoverability, measurability, etc.

When this triple holds, a QA skill enforcing label format / section presence is *fake QA*: it can fail on perfectly usable artifacts (period vs colon punctuation), and it adds zero value the eval doesn't already provide. Worse, it creates regression risk during refactors — anyone tightening the producer's output format has to chase the QA's regex too.

The worked example (`pdd-to-app-journeys-qa`, dropped in PR #160) is documented in [`docs/learnings/2026-05-08-fake-qa-detection.md`](../docs/learnings/2026-05-08-fake-qa-detection.md).

When you decide to skip QA for a new producer, add a row to `_qa-decisions.md` with rationale + revisit conditions. Don't just leave it absent — absence is indistinguishable from "not yet migrated."

## Static vs LLM

**Prefer static.** Regex, parsing, schema validation, arithmetic, filesystem checks. They're cheap, fast, deterministic, and don't burn LLM budget on every run.

**LLM is allowed when** static can't capture the rule but the check is still hard-fail-shaped:

- "Is this section actually about X, or just labeled X?" — static can check the heading text but not whether the body content matches the heading semantically.
- "Are these reviewer comments actually addressed in the cited sections, or is the citation broken?" — semantic alignment between two pieces of text.
- "Is the budget figure stated as a number, or is it `TBD` / placeholder?" — pattern detection that regex can do, but the regex would miss creative placeholder phrasings.

When using LLM in QA, the check is still binary pass/fail. The LLM call returns a single boolean (with reasoning for the failure case + auto-fix hint). It does NOT return a 0-10 score; that's eval's shape.

## Skeleton

Every `*-qa` skill follows this body skeleton:

```markdown
# <Skill Name> QA

(1-3 sentence framing — what artifact this checks, what it gates, who fixes failures.)

## Process

1. Read inputs from Drive (the artifact + any required upstream artifacts).
2. Run static checks (in order, fail-fast where appropriate).
3. Run LLM checks (if any).
4. Write the QA result YAML — see "QA result YAML contract" below.
5. If any check failed: surface to orchestrator with auto-fix hints.

## Checks

(Per-skill check list. Each check has: id, type (static | llm), description,
auto_fix_hint, failure detail format.)

## MCP Tools Used

See `skills/_qa-template.md § MCP Tools Used`.

## Mode Behavior

See `skills/_qa-template.md § Mode Behavior`.

## Change Log

| Date | Change | Author |
|---|---|---|
```

## QA result YAML contract

The QA result is the binary pass/fail unit the orchestrator reads. It is NOT a verdict (no scores, no dimensions). Filename: `<phase>/<producer>-qa_result.yaml`.

```yaml
skill: <producer>-qa
target: <opp-name | artifact-id>
ran_at: <ISO timestamp>
capture_path: <relative path to artifact under review>

verdict: pass | fail | incomplete
# pass: all checks passed; eval can proceed.
# fail: ≥1 check failed; orchestrator should attempt auto-fix or halt.
# incomplete: QA could not complete (e.g. artifact missing entirely);
#   distinct from fail because there's nothing to fix.

stats:
  checks_run: 11
  checks_passed: 10
  checks_failed: 1

failures:                          # empty list when verdict: pass
  - check: <check-id>              # stable identifier; matches `## Checks` table
    type: static | llm
    detail: "<one-line description of what's wrong>"
    auto_fix_hint: "<one-line instruction for orchestrator to pass to producer on regen>"
    severity: blocker              # ALWAYS blocker — QA has no warn/info tiers
                                    # (severity field present for symmetry with eval verdicts;
                                    #  always 'blocker' in QA results.)

# Optional — useful for audit. Omit by default to keep YAML tight.
passed:
  - check: <check-id>
    detail: "<what was verified>"
```

**No score fields.** No `overall_score`, no `dimensions:`, no `weight:`. QA is binary. If you find yourself wanting to add a score, the check belongs in eval, not QA.

**No `auto_surfaced` block.** QA failures ARE the surfaces; they go in `failures`. Eval surfaces (gate briefs, WARN/INFO) are a separate concern.

## Auto-fix protocol

When the orchestrator receives `verdict: fail` from a QA result:

1. **Bound the attempts.** Default 2 auto-fix attempts per QA run; configurable per skill.
2. **Pass each `auto_fix_hint` to the producer** with explicit "fix this and re-emit" instructions. The producer does the work; QA does not fix artifacts itself.
3. **Re-run QA after each attempt.** If now `verdict: pass`, proceed to eval.
4. **If still failing after all attempts: halt.** Set the run's phase to `incomplete`, surface the remaining failures + hints to the operator, and write a halt-state entry to `run_state.yaml`.

**Anti-pattern:** silently proceeding to eval when QA failed. QA is do-not-pass-go.

## QA gates eval, but doesn't replace meta-judgment

QA is necessary but not sufficient. It catches what we know how to check; the orchestrator (or a human reviewer) may still flag things QA missed. QA passing means *the artifact is gradable* — not *the artifact is good*.

Concretely: a producer can produce a structurally perfect artifact that QA passes 100%, and eval can still flag substantial quality concerns (low demand_reality score, infeasible budget, etc.). QA's job is to ensure eval has a fair input; eval's job is to grade quality.

## When QA work requires runtime

Some artifacts can only be checked by running something — a deployed chatbot must be exercised before structural checks (response received, citation field populated, latency under threshold) can fire. In that case, the QA skill:

1. Exercises the artifact (e.g. sends prompts to the bot, waits for responses).
2. Writes a capture / transcript artifact alongside the QA result.
3. Runs structural checks against the capture.
4. Emits the QA result + capture to known paths.

The eval skill then reads BOTH the original artifact AND the capture as inputs. The reference example is `ocs-chatbot-qa` + `ocs-chatbot-eval`.

## MCP Tools Used (stock)

```markdown
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`, `drive_update_file`
```

If a specific QA needs to exercise an artifact via a non-Drive MCP (OCS, Connect, Mobile, Nova), list those in addition to the stock block.

## Mode Behavior (stock)

```markdown
- **Auto:** Run checks, write QA result, return verdict + failures (if any).
- **Review:** Same as Auto — QA is binary; there's no human pause-and-review.
  (Eval has Review mode for quality judgments; QA doesn't because there's
  nothing to weigh in on.)
```

## Why this lives in `_qa-template.md`

QA skills share a contract: binary verdict, structured failures, auto-fix hints, no scores. Each per-skill body should reference this file's contracts instead of duplicating them.

When you change a shared contract (QA result shape, auto-fix protocol), edit this file once and the change propagates to every QA skill automatically.

## Migration from inline QA

Most ACE producers today embed structural checks inline in their `## Process` step or fold them into the `## LLM-as-Judge Rubric`. The migration target:

- Producers that have **dedicated structural checks** (e.g. `app-screenshot-capture`'s manifest verification, `idea-to-pdd`'s section-presence check via the rubric's `structural_completeness` dimension) → extract a `-qa` skill or inline QA step that emits `<producer>-qa_result.yaml` separately from the producer artifact.
- Eval skills that have a **`structural_completeness` dimension** → remove that dimension; rely on QA. Reweight remaining (now purely quality) dimensions to span the full 0-10 range.

Track migrations at the per-skill `## Change Log` with date + "QA extracted from eval" entry.
