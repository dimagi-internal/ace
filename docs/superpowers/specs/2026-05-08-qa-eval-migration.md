# QA/Eval split — migration plan

**Date:** 2026-05-08
**Status:** Draft (not yet executing). First migration PR will reference this doc.
**Scope:** Migrate ACE's 36 producer skills + 16 eval skills to the QA/Eval split principle codified in PR #146 (`skills/README.md § QA vs Eval — the two-axis pattern`). Concurrent with ace-web visualization changes and a substantial test-harness reorganization.

## Goal

Every producer artifact is checked along two orthogonal axes:

- **QA = structural correctness.** Binary pass/fail. Hard do-not-pass-go failures. Static checks preferred; LLM allowed when needed.
- **Eval = quality judgment.** Soft 0-10 scores via LLM-as-Judge. Quality dimensions only.

Migration end-state:

- Every producer has either a `-qa` companion skill OR an inline QA step + an `-eval` companion OR inline self-eval.
- Every QA result is binary; every eval verdict is quality-only.
- The orchestrator attempts auto-fix on QA failures and halts if it can't.
- Static QA checks are importable TS functions that can be unit-tested without dispatching the skill.
- A calibration corpus + per-skill fixtures + snapshot tests detect drift early.
- ace-web renders QA + eval distinctly so operators see both.

## Non-goals

- This plan does NOT migrate ACE to a new LLM model, MCP, or runtime.
- It does NOT add new dimensions to existing rubrics beyond what the holistic-probe audit surfaces during migration.
- It does NOT change the producer-eval-gate orchestration shape (gate briefs, BLOCKER/WARN/INFO severity tiers in eval).
- It does NOT replace the existing `test/mcp/`, `test/fixtures/`, or `test/eval/` test suites — those continue alongside the new per-skill harness.

## Architectural principle (recap)

From `skills/README.md § QA vs Eval — the two-axis pattern`:

- **The line:** if AI can typically fix the issue by re-reading inputs and trying again → QA. If fixing requires substantive design or value judgments → eval.
- **QA failure semantics:** hard fail; orchestrator attempts auto-fix using per-check `auto_fix_hint`s; halts if remediation can't recover. No "this is bad but okay to continue" tier in QA.
- **QA is necessary but not sufficient:** orchestrator-level meta-judgment still applies on top.
- **No cross-eval cap rules:** evals can read upstream verdicts as context but stand on their own. Each rubric makes its own judgment.
- **Coverage rule:** every producer has both axes (separate skills or inline). QA gates eval — irrecoverable QA failure → eval skipped (`verdict: incomplete`).

## Per-skill migration checklist

For each producer being migrated:

- [ ] **Identify structural checks** currently in the producer's process or eval rubric. Anything that's a regex / parse / arithmetic / schema validation / file existence check → moves to QA.
- [ ] **Identify quality dimensions** that remain in eval. Anything semantic / value judgment / domain-specific → stays in eval (or gets added if missing).
- [ ] **Build the QA skill** as `skills/<producer>-qa/SKILL.md` per `skills/_qa-template.md`.
  - Static checks live in `skills/<producer>-qa/checks.ts` as importable TS functions returning `QACheckResult`.
  - Skill body orchestrates: read artifact, call each check, aggregate into `<producer>-qa_result.yaml`.
  - LLM checks (if any) call out to a `general-purpose` Agent with a binary-output prompt.
- [ ] **Slim the eval skill's rubric** to quality-only dimensions.
  - Remove dimensions that are now QA's job (`structural_completeness`, `numbers_present`, etc.).
  - Re-weight remaining dimensions to sum to 1.0.
  - Tighten anchors to span the full 0-10 range now that the rubric isn't anchored by easy-to-pass structural checks.
  - Update inflation guard threshold if applicable.
- [ ] **Update artifact paths.**
  - `lib/artifact-manifest.ts` adds the new `-qa_result.yaml` artifact.
  - Phase agent's `skills:` frontmatter references the new QA skill.
- [ ] **Update tests.**
  - Per-skill fixture under `test/skills/<producer>/` (see § Test harness below).
  - Static checks unit-tested via vitest.
  - Snapshot test on QA result + eval verdict shape.
- [ ] **Verification.**
  - Dispatch via `/ace:step <producer> <fixture-opp>` with a known-good input. Expect QA pass, eval pass.
  - Dispatch with a known-bad input (deliberately broken artifact). Expect QA fail with specific check IDs + auto_fix_hints.
  - Run against the calibration corpus. Verify scores fall in expected ranges.
- [ ] **Update change logs** on both producer and eval (and new QA) SKILL.md files.

## Migration order

### Phase 0: groundwork (this plan + ace-web changes)

- This plan PR (no code changes; just the spec).
- ace-web visualization changes (separate parallel PR — see § ace-web below).

### Phase 1: first three producers (sequential through the pipeline, all Phase 1)

The first three deliberately span all three migration shapes so the pattern is validated across starting states. All Phase 1 so we can test by dispatching individually against an existing fixture without running the full /ace:run.

| # | Skill | Migration shape | Why |
|---|---|---|---|
| 1 | **`idea-to-pdd`** | **Refactor** — has both inline self-eval + dedicated `-eval`; extract structural to new `idea-to-pdd-qa`, slim eval to quality-only | Exemplar. Most-iterated rubric. Working baseline (turmeric scored 7.55) for verification |
| 2 | **`pdd-to-app-journeys`** | **Greenfield** — has neither today; build both from scratch | Demonstrates from-scratch case. Sets ground truth `app-ux-eval` grades against |
| 3 | **`pdd-to-test-prompts`** | **Greenfield** — has neither today; build both from scratch | Generates test prompts `ocs-chatbot-eval` consumes |

**Test approach for Phase 1:** individual skill dispatch via `/ace:step`, NOT a full /ace:run. Wall-clock minutes per migration vs hours per run. Full /ace:run validation is deferred until after Phase 1's three migrations + Phase 2 batch are complete.

### Phase 2: batch — Phase 2 Nova builders

Four producers share a similar shape (Nova compiles a CommCare app); QA can use a shared helper.

- `pdd-to-learn-app`, `pdd-to-deliver-app` — Nova autobuild; QA = "compiled app validates against schema"
- `app-deploy` — Nova publish; QA = "publish succeeded; markers present in CCZ"
- `app-release` — CCHQ release; QA = "released; status reads 'released'"

Migration shape: **add QA to existing eval.** All four already have `-eval` skills.

### Phase 3: batch — Phase 5 training cluster (5 skills)

`training-faq`, `training-flw-guide`, `training-llo-guide`, `training-onboarding-email`, `training-quick-reference`. Shared helper `training-qa` validates: required sections present, screenshot references resolve, format matches template.

Migration shape: **greenfield** — most have inline self-eval but no dedicated QA.

### Phase 4: batch — Phase 6 synthetic cluster (9 skills)

Recent wave; mostly have `-eval` skills but sparse QA. Shared helper `synthetic-qa` validates: YAML manifest schema, narrative anchoring to PDD, walkthrough YAML format.

### Phase 5: high-priority standalones

- `solicitation-review` — gates Phase 6→7 award decision; needs both QA + strong eval. Currently neither.
- `ocs-agent-setup` — Phase 4 chatbot creation. Currently neither.
- `connect-program-setup`, `connect-opp-setup` — critical Connect setup chain. QA missing.
- `llo-launch` — Phase 8 entry gate. Just got viability axis in PR #145; still needs QA extracted.

### Phase 6: remaining producers, communication chain, recurring tasks

- `llo-invite`, `llo-onboarding`, `llo-feedback`, `llo-uat`
- Recurring: `flw-data-review`, `timeline-monitor`, `solicitation-monitor` (state-tracking QA only; no quality eval)
- Closeout: `opp-closeout`, `learnings-summary`
- `idea-to-pdd-eval`'s own QA (verdict YAML schema validation)

### Phase 7: eval-skill self-QA

All 16 `-eval` skills get a small QA on their verdict YAML — verifying weights sum to 1.0, dimensions match the schema, etc. Cheap, mechanical, can land as a single `verdict-yaml-qa` shared helper.

### Total estimated PRs

Per-skill PRs: ~36 producers + ~16 eval-self-QA + 4 shared helpers (`training-qa`, `synthetic-qa`, `nova-qa`, `verdict-yaml-qa`) = ~50 PRs total. Realistic timeline: weeks of part-time work, not hours.

## ace-web visualization (parallel track)

ace-web today reads `<phase>/*_verdict.yaml` and renders eval scores. It doesn't know about QA.

**Changes needed:**

| Change | Effort | When |
|---|---|---|
| Recognize `<producer>-qa_result.yaml` filename pattern | small | Before Phase 1 migration PR #1 |
| Render QA result distinctly: green check / red X with failed-checks list (vs eval's score donut) | medium | Before Phase 1 migration PR #1 |
| Show producer→QA→(auto-fix loop)→eval flow as per-skill timeline | medium | Phase 1 |
| Distinguish three states per skill: `qa-failed-irrecoverably` / `eval-pending` / `eval-graded` | small | Phase 1 |
| Run-summary view: "N QA failures auto-fixed" + "M still unresolved" | small | Phase 1 |
| Per-skill drill-down: show static-vs-LLM check breakdown in QA results | medium | Phase 2+ |

**Approach:** ship as one ace-web PR concurrent with ACE Phase 1 migration PR #1. After both merge, the first verification dispatch already has the visualization to watch.

## Test harness reorganization

This is the largest infrastructure investment in the plan. The current test setup doesn't support per-skill QA/eval testing well.

### Current state

- `test/mcp/` — vitest unit + integration + E2E tests for MCP servers
- `test/eval/` — PDD eval runner (`run-eval.ts`)
- `test/fixtures/` — partial-coverage manifest fixtures (`ACE-Test-001/002/004/005`)
- `npm test`, `npm run test:integration`, `npm run eval`

What's missing:
- No per-skill test harness — there's no easy way to "run idea-to-pdd-qa against this fixture and assert verdict: pass with no failures."
- Static QA logic doesn't yet exist as importable TS functions; today QA logic is embedded in skill prompts.
- Fixtures don't carry expected QA results / eval verdict shapes.
- No calibration corpus for cross-skill rubric calibration.
- No snapshot testing for verdict YAML schema drift.

### Proposed new structure

```
test/
├── mcp/                        (unchanged)
├── eval/                       (unchanged — PDD eval runner)
├── fixtures/                   (extended — see below)
│   ├── ACE-Test-001/        (existing)
│   │   ├── pdd.md              (existing)
│   │   ├── ...
│   │   └── expected/           (NEW)
│   │       ├── idea-to-pdd-qa_result.yaml
│   │       └── idea-to-pdd-eval_verdict.shape.yaml  (structure-only)
│   ├── ACE-Bad-001/         (NEW — adversarial fixtures)
│   │   ├── pdd.md              (PDD with missing sections)
│   │   └── expected/
│   │       └── idea-to-pdd-qa_result.yaml
│   │           # verdict: fail; failures: [missing_section: target_population, ...]
│   └── ...
├── skills/                     (NEW — per-skill tests)
│   ├── idea-to-pdd-qa/
│   │   ├── checks.test.ts      (static QA checks unit-tested directly)
│   │   ├── integration.test.ts (dispatch skill, assert against fixture expected/)
│   │   └── snapshot.test.ts    (verdict YAML schema drift)
│   ├── idea-to-pdd-eval/
│   │   ├── rubric.test.ts      (quality dimensions calibration)
│   │   └── snapshot.test.ts
│   └── ...
├── calibration/                (NEW — cross-skill calibration corpus)
│   ├── pdds/
│   │   ├── strong-pdd.md       (designed to score ≥9 in all evals)
│   │   ├── viable-but-thin.md  (designed to score 6-7)
│   │   ├── structurally-bad.md (QA should fail)
│   │   └── viability-broken.md (QA passes, eval scores ≤4 on viability dimensions)
│   ├── apps/
│   │   └── ...
│   └── README.md               (provenance + expected score ranges)
└── lib/                        (NEW — shared test utilities)
    ├── skill-runner.ts         (dispatch a skill against a fixture, capture outputs)
    ├── verdict-asserts.ts      (custom matchers for QA/eval verdicts)
    └── fixture-loader.ts
```

### New testing primitives

**1. Static QA checks as importable TS.**
Each `<producer>-qa` skill's static checks become functions in `checks.ts`:

```typescript
// skills/idea-to-pdd-qa/checks.ts
export interface QACheckResult {
  pass: boolean;
  detail?: string;
  auto_fix_hint?: string;
}

export function checkAllSectionsPresent(pdd: string): QACheckResult { ... }
export function checkReviewerCommentTable(pdd: string): QACheckResult { ... }
export function checkArchetypeInEnum(pdd: string): QACheckResult { ... }
```

Skill body orchestrates: read artifact → call each check → aggregate results into the YAML output. LLM checks call separately via Agent dispatch.

Unit tests on `checks.ts` are pure function tests, no LLM, fast (<1s).

**2. Per-skill integration tests.**
A vitest suite that dispatches the skill against a fixture and asserts the verdict matches expected:

```typescript
// test/skills/idea-to-pdd-qa/integration.test.ts
import { runSkill } from '@/test/lib/skill-runner';
import { assertQAResultMatches } from '@/test/lib/verdict-asserts';

test('ACE-Test-001 passes idea-to-pdd-qa', async () => {
  const result = await runSkill('idea-to-pdd-qa', { fixture: 'ACE-Test-001' });
  assertQAResultMatches(result, fixture('ACE-Test-001/expected/idea-to-pdd-qa_result.yaml'));
});

test('ACE-Bad-001 (missing section) fails idea-to-pdd-qa with specific check', async () => {
  const result = await runSkill('idea-to-pdd-qa', { fixture: 'ACE-Bad-001' });
  expect(result.verdict).toBe('fail');
  expect(result.failures).toContainEqual(expect.objectContaining({
    check: 'all_sections_present',
    detail: expect.stringContaining('Target Population'),
  }));
});
```

`runSkill()` is a new test-lib utility; under the hood it either invokes the skill via Claude Code SDK or (preferred) imports + calls the skill's static checks directly + mocks LLM checks. Static-only QA skills can run fully without LLM.

**3. Calibration corpus.**
Cross-skill calibration: a set of curated artifacts at known viability levels. When migrating a rubric, run it against the corpus and verify scores fall in expected ranges. If not, the rubric is mis-calibrated.

```yaml
# test/calibration/pdds/strong-pdd.md ... + alongside:
# test/calibration/pdds/expected.yaml
strong-pdd.md:
  idea-to-pdd-qa: { verdict: pass }
  idea-to-pdd-eval:
    overall_score: { min: 8.5, max: 10.0 }
    dimensions:
      demand_reality: { min: 8.0 }
      mission_alignment: { min: 8.0 }

viability-broken.md:
  idea-to-pdd-qa: { verdict: pass }    # structurally fine
  idea-to-pdd-eval:
    overall_score: { min: 4.0, max: 6.0 }
    dimensions:
      demand_reality: { max: 4.0 }      # specifically broken on this dimension
```

**4. Snapshot tests.**
Verdict YAML structure (not exact scores) snapshotted via vitest's `toMatchSnapshot()`. Detects accidental schema drift when someone refactors the verdict shape.

**5. Adversarial fixture generation.**
For each producer, a small set of `ACE-Bad-*` fixtures with deliberately broken inputs. Each fixture's `expected/` directory documents what QA should catch. Fixtures are versioned alongside the skill.

### Migration order for the test harness

The test-harness reorganization is itself a multi-PR effort, interleaved with the per-skill migrations:

1. **Plan PR (this doc).** No test-harness changes yet.
2. **Test-harness scaffolding PR** (concurrent with Phase 1 PR #1):
   - Add `test/lib/skill-runner.ts`, `verdict-asserts.ts`, `fixture-loader.ts`
   - Add `test/skills/` and `test/calibration/` directory skeletons
   - Add `npm run test:skills` script
   - Document conventions in `test/skills/README.md`
3. **Phase 1 migrations** (PRs 1-3): each migration PR includes its per-skill tests.
4. **Calibration corpus PR** (after Phase 1 done): add the 4-5 calibration PDDs once we know what realistic anchors look like.
5. Subsequent migration PRs fold in their tests.

## Iteration loop per migration

Per the user's preference: skip full /ace:run after each migration. Test individual skills via `/ace:step` against existing run fixtures. Full /ace:run validation deferred until after Phase 1 + Phase 2 batches.

Per-migration loop:

1. **Migrate one skill** per checklist above.
2. **Unit-test the static checks** via vitest (`npm run test:skills -- <producer>-qa`).
3. **Integration-test by dispatching the skill** via `/ace:step <producer> <fixture-opp>` against a known-good and known-bad fixture. Verify QA result matches expected; verify eval verdict shape is correct (don't assert exact scores yet).
4. **Run against the calibration corpus** if it exists. Verify scores fall in expected ranges.
5. **Run `/canopy:improve-lens --lens judge --project ace`** against any opp that has the migrated skill's output. Surface remaining gaps the holistic probe finds (signal: `rubric_blind_spot`).
6. **Open follow-up PRs** for remaining gaps if substantial.
7. **Move to next skill.**

After Phase 1's three migrations are complete:

8. **Run full `/ace:run` on a fresh opp** as integration validation. Verify all three Phase 1 QA + eval pairs fire correctly in sequence.
9. **Compare scores** against the pre-migration baseline (turmeric 7.55 with the post-PR-#145 rubric). Expect: similar-or-slightly-lower scores; QA failures handled correctly with auto-fix or halt; ace-web visualizes the split.

## Rollback criteria

What triggers a stop-and-rethink:

- A Phase 1 migration's static QA checks have >50% false-positive rate on known-good fixtures (the QA is too strict).
- A Phase 1 migration's eval rubric clusters scores in <2-point range across the calibration corpus (the rubric still doesn't discriminate).
- ace-web visualization can't render the QA result format (schema mismatch with what the migration produces).
- The auto-fix protocol fails on >30% of QA failures (orchestrator can't actually fix the things QA flags). Either QA's `auto_fix_hint`s are insufficient or the fix-loop is broken.
- The migration PR adds >300 lines of net code (signals over-engineering; should be smaller per skill).

If rollback triggers fire, halt at the current migration PR, file findings, revise the plan.

## Done definition

The QA/eval migration is **done** when:

- All 36 producers have either a `-qa` companion or inline QA step + eval companion (or inline self-eval).
- All 16 `-eval` skills have verdict-YAML schema QA.
- ace-web renders QA results distinctly from eval verdicts in run summaries and per-skill detail views.
- The calibration corpus includes ≥4 PDDs spanning known viability levels; all evals score them in expected ranges.
- A full `/ace:run` on a fresh opp produces a complete set of `<producer>-qa_result.yaml` + `<producer>-eval_verdict.yaml` files for every applicable skill.
- This plan doc is updated with shipped-state notes per phase.

## Open questions

- **Should `-qa` be a separate skill always, or can simple cases stay inline in the producer?** Tentatively: separate when QA has ≥3 checks OR uses LLM; inline otherwise. Revisit after Phase 1.
- **What's the auto-fix attempt budget per QA failure?** Default 2 attempts. Configurable per skill via descriptor field? Revisit after observing real auto-fix behavior in Phase 1.
- **How does the QA → auto-fix loop interact with `/ace:run`'s default vs review mode?** Auto-fix is silent in default mode; surfaces in review mode? Or always surfaces? Revisit during Phase 1.
- **Do we need a `qa-status` field in `run_state.yaml`** to expose to the orchestrator? Currently `run_state.yaml` tracks phase status but not per-skill QA pass/fail. Likely yes; design during Phase 1.
- **Should the calibration corpus be opp-shaped or artifact-shaped?** Today fixtures are opp-shaped (`ACE-Test-001/`). For per-eval calibration we may want artifact-shaped (`pdds/`, `apps/`, `bots/`). Revisit after corpus reaches 5+ entries.
- **What's the ace-web rendering for "QA passed but eval scored low"?** Distinct from "QA failed irrecoverably" but both are concerning. Visual treatment tbd.

## Update log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial plan. | ACE team |
