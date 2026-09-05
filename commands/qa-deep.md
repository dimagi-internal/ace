---
description: Run deep QA (OCS + apps) against an existing opportunity. Manual gate, not part of /ace:run.
argument-hint: <opp-name> [--ocs-only | --apps-only]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion, mcp__plugin_ace_ace-mobile__mobile_run_recipe, mcp__plugin_ace_ace-mobile__mobile_resolve_selectors, mcp__plugin_ace_ace-mobile__mobile_validate_recipe, mcp__plugin_nova_nova__get_form, mcp__plugin_nova_nova__get_app]
---

# /ace:qa-deep — Manual Deep QA

Triggers a full LLM-as-Judge quality assessment of an opportunity that
already has a successful /ace:run behind it.

## Step 0 — choose the run (MANDATORY, before anything else)

Every path below is `runs/<run-id>/...`. **`<run-id>` is not "the newest
folder."** Resolve it with `selectQaDeepRun` and nothing else:

```ts
import { selectQaDeepRun } from '../lib/qa-deep-run-selection';
// candidates = every folder under ACE/$1/runs/ + its parsed run_state.yaml
const pick = selectQaDeepRun(candidates, stage); // 'ocs' | 'apps' | 'both'
if (!pick.ok) { /* print pick.refusal verbatim and HALT */ }
const runId = pick.run_id;
```

The operator may pin a run explicitly (`/ace:qa-deep <opp> <run-id>`); when
they do, still run `assessQaDeepRun` on it and surface the reasons if it is
disqualified — pinning overrides the choice, not the warning.

**Do NOT use `resolve_current_run_id` here.** It returns the
lexicographically-largest FOLDER name, which is a correct answer to a
different question. On `hh-poverty-targeting` (2026-09-05) it returned
`20260901-1932` — a Phase-7-only validation fork (`forked_from:
20260828-0702`, six phases at `verdict: seeded`, 8/9/10 `skipped` with
`skip_reason: "Validation fork -- Phase 7 only."`). Stage B reads
`3-commcare/app-test-cases.yaml` and `commcare-setup.products.apps`, both
of which that fork carries, so the apps half would have run to completion
and written `app-ux-eval_verdict-deep.yaml` into it. Phase 9 `llo-launch`
reads that verdict as its go-live gate and cannot tell the difference: the
gate does not fail, it PASSES on evidence about a different run.

`selectQaDeepRun` refuses rather than falling back. Print `pick.refusal`
and stop — never grade an unknown run.

*Enforced:* `lib/qa-deep-run-selection.ts` +
`test/lib/qa-deep-run-selection.test.ts` (ace#1950).

## Inputs read from Drive (`ACE/$1/`)

All `<run-id>` below is the one Step 0 selected.

- `inputs/pdd.md`, `runs/<run-id>/2-scenarios/pdd-to-test-prompts.md` (OCS deep ground truth)
- `runs/<run-id>/2-scenarios/pdd-to-app-journeys.md`, `runs/<run-id>/3-commcare/app-test-cases.yaml` (app deep ground truth)
- The published OCS chatbot's current configuration
- The latest released CommCare builds (Learn + Deliver)

## What this does

Run the following dispatches in this order:

### Stage A — OCS deep (skip if `--apps-only`)

Pass the Step 0 `runId` AND the run's
`phases.ocs-setup.products.ocs_chatbot.experiment_id` down to the qa skill.
`ocs-chatbot-qa` asserts the bot it resolved is the bot that run built
(`assertRunOwnsChatbot`) and refuses otherwise — without that, its
three-branch resolution chain can grade another run's chatbot, or the
pristine golden template, and `llo-launch` reads the result as clearance
(ace#1950).

1. Dispatch `ocs-chatbot-qa --deep` for $1
2. Dispatch `ocs-chatbot-eval --deep` for $1

Writes (under `ACE/$1/runs/<run-id>/5-ocs/`):
- ocs-chatbot-qa_transcript-deep.md
- ocs-chatbot-eval_verdict-deep.yaml
- ocs-chatbot-eval_report-deep.md

### Stage B — Apps deep (skip if `--ocs-only`)

1. Read `3-commcare/app-test-cases.yaml` for the run.
2. **Lazy deep-recipe generation — generate the deferred deep recipes
   ON DEMAND before executing them.** Phase 3 (`app-test-cases`) authors
   Maestro recipe files only for the two `is_smoke: true` journeys; every
   non-smoke (deep) journey is carried in the catalog with
   `recipe: deferred` (the literal string, not a path) and has NO recipe
   file yet. This is the only place deep recipes are generated (the
   lazy-generation design tracked as jjackson/ace#605 — `/ace:run`'s
   Phase 6 never needs them). For each catalog journey whose `recipe` is
   `deferred`:
   1. Compose the Maestro recipe using the **same composition rules
      `app-test-cases` uses** — see `skills/app-test-cases/SKILL.md`
      § Step 3 (static palette in `mcp/mobile/recipes/static/`, live form
      labels from Nova `get_form` against the run's released app, the
      MANDATORY quiz answer-tap rule, and the strict selector placeholder
      gate). The Nova `app_id` is recorded in the catalog
      (`nova_apps.{learn,deliver}`) / the Phase 3 app summaries, and
      `get_form` still returns the as-built structure within a run, so
      authoring at qa-deep time is safe — the "author before app-release
      freezes it" concern does NOT apply within a single run.
   2. Run the § Step 3.4 selector-resolution gate
      (`mobile_resolve_selectors`) over the composed recipe; halt with a
      `[BLOCKER]` if `unresolved` is non-empty (same contract as Phase 3).
      Validate via `mobile_validate_recipe`.
   3. Write the recipe to
      `ACE/<opp>/runs/<run-id>/3-commcare/recipes/journey-<app>-<slug>.yaml`
      and update that catalog entry's `recipe:` from `deferred` to the
      written path (so a re-run of `/ace:qa-deep` is idempotent — already
      -generated deep recipes are reused, not regenerated).
   (Smoke journeys already have authored recipe files from Phase 3 — leave
   them as-is.)
3. For each journey: call `mobile_run_recipe` against a fresh AVD,
   capture screenshots into
   `ACE/<opp>/runs/<run-id>/6-qa-and-training/screenshots/`, appending
   entries to `6-qa-and-training/app-screenshot-capture_manifest.yaml`.
   Deep runs may overwrite or augment screenshots from a prior shallow
   Phase 6 run — the deep set is authoritative when both exist.
4. Dispatch `app-ux-eval` to grade the captured set.

Writes:
- 3-commcare/recipes/journey-<app>-<slug>.yaml (lazily generated for each `recipe: deferred` deep journey on first qa-deep run)
- 3-commcare/app-test-cases.yaml (updated — each generated deep journey's `recipe:` flipped from `deferred` to its written path)
- 6-qa-and-training/screenshots/*.png (full per-journey set, supersedes any shallow run)
- 6-qa-and-training/app-screenshot-capture_manifest.yaml (updated)
- 6-qa-and-training/app-ux-eval_verdict-deep.yaml
- ACE/$1/eval-calibration/app-ux-eval-runs.md (opp-level audit trail; appended row)

## What this does NOT do

- No /ace:run side effects. No Phase 9 activation, no app rebuild, no
  training-material regeneration.
- No FLW invites, no LLO emails.

## Stage C — route the findings (ALWAYS; this is not optional)

Writing the verdicts is not finishing. A deep run emits findings across
FOUR different owners, and until they are separated the operator is the
router:

| Owner | Means | Fix path | Whose call |
|---|---|---|---|
| `HARNESS` | ACE's recipe / selector / skill is wrong | self-heal PR | nobody — ship it |
| `INSTRUMENT` | the ground truth or suite is wrong | self-heal PR | nobody — ship it |
| `PRODUCT` | the built app is wrong | Phase 3 rework | **operator** |
| `PROMPT` | the bot's system prompt is wrong | Phase 5 re-publish | **operator** |

```ts
import { triageFindings, buildDecisionSet, formatDecisionBrief }
  from '../lib/qa-deep-triage';
const set = buildDecisionSet(triageFindings(findings));
```

1. **Self-heal `HARNESS` + `INSTRUMENT` now**, per CLAUDE.md § self-heal —
   they are ACE's own code and need no decision. Ship each via
   `skills/shipping`. Report them as *filed + fixed (PR #n)*, not as
   findings for the operator to read.
2. **Emit `formatDecisionBrief(...)`** as the reply. One decision per
   operator-owned area — `rework or accept?` — never a finding list.
3. **Never act on an unclassified finding.** `needsTriage` is surfaced and
   left alone.

**Why this is a step and not a nicety.** On
`spark-facilitator/20260828-0703` the app verdict opened with

> `BLOCKER` — The community case's durable state does not advance on a
> real meeting. … This is the whole premise of the longitudinal-visits
> archetype.

which was ACE's own recipe re-filing a preloaded date (ace#1982). **Two of
that verdict's five BLOCKERs were ACE bugs presented as product defects**,
and the run's `reject` disposition rested partly on them. Fifteen findings
went to the operator unsorted; routing them took six rounds of conversation
and three wrong guesses. That is the cost this step removes.

*Enforced:* `lib/qa-deep-triage.ts` + `test/lib/qa-deep-triage.test.ts`.

## After completion

Both verdicts land at the run-scoped paths above
(`5-ocs/ocs-chatbot-eval_verdict-deep.yaml` and
`6-qa-and-training/app-ux-eval_verdict-deep.yaml`). The Phase 9
`llo-launch` gate reads them and refuses activation if either is
missing or stale.

The operator's output is the Stage C decision brief — not the verdict
files. The files are the audit trail.

If you ran this and want to proceed to go-live, re-enter Phase 9 via
/ace:step llo-launch $1. /ace:qa-deep only writes verdicts and
screenshots — it does not touch `run_state.yaml`, so `/ace:run` resume
will pick up at whatever phase the run last halted at.

### Future enhancements

- `--since=<verdict-id>` for incremental app re-grading (re-run only
  journeys whose recipes changed) is deferred to a future release;
  see plan §5 (`/ace:qa-deep` command) note on optional v1 flags.
