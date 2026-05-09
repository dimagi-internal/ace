# QA auto-fix loop: halt-on-stuck-failure-set redesign

**Date:** 2026-05-09
**Status:** Draft (design only). Implementation in a follow-up PR after this spec is approved.
**Scope:** Replace the current hard-count halt (2 attempts) in the QA auto-fix loop with a "stuck on the same failure set" detector. Affects every QA dispatch wired in the agents/ procedure docs (Phase 1's `idea-to-pdd-qa`, `pdd-to-test-prompts-qa`; future Phase 2-7 QA skills).

## Problem

Today the orchestrator halts the QA auto-fix loop after a fixed number of attempts (currently 2). Procedural prose in `agents/design-review.md`:

> if `verdict: fail`, attempt up to 2 auto-fix retries (regenerate PDD with `failures[].auto_fix_hint` instructions, re-run QA). After bounded retries, halt with `verdict: incomplete`.

Two issues with the hard-count rule:

1. **It penalizes legitimate progress.** A PDD with 3 failures might shed one per attempt — by attempt 3 there's only one failure left, but the hard cap forces a halt anyway. The producer was making real progress; the loop just ran out of budget.
2. **It papers over actual stuck-ness.** A producer that consistently fails on the same check (e.g., a producer that can't satisfy a check because the required input is missing) will be stopped at the same attempt count whether it's making no progress at all or thrashing on a different failure each time. The signal "we're stuck" gets lost in the noise of "we hit the budget."

Surfaced during E2E auto-fix loop validation (Phase 1 QA/Eval-split, 2026-05-08). The convergent test (Test A) succeeded at attempt 1 — well within budget. The halt test (Test B) needed careful test-design to actually trigger a halt without accidentally satisfying the check (one of the agent's "wrong" fixes was too plausible and unexpectedly passed).

## Proposed redesign

**Halt when the current attempt's failure set is a subset of (or equal to) the previous attempt's.**

Concretely, the orchestrator tracks a per-loop `previous_failure_check_ids: Set<string>`. After each QA attempt:

- If `verdict: pass` → loop succeeds, proceed to eval.
- If `verdict: fail`:
  - If this is attempt 0 (no previous attempt), record `previous_failure_check_ids = {check IDs in this verdict}` and continue to the next attempt.
  - If this is attempt N≥1, compute `current = {check IDs}`. If `current ⊆ previous`, **halt** — the producer made no new progress (and may have introduced regressions on already-flagged checks). Surface `verdict: incomplete` with the unresolved check IDs + their auto_fix_hints + a "stuck on these checks across N attempts" note.
  - Else (current has at least one check ID not in previous, i.e. progress), update `previous = current` and continue.

### Worked example — convergent (succeeds, no halt)

| Attempt | failure_check_ids | Comparison vs prev | Decision |
|---|---|---|---|
| 0 | {sections, archetype, success_metrics} | (none) | retry |
| 1 | {sections} | strict subset → progress | retry |
| 2 | (pass) | n/a | succeed |

### Worked example — true halt

| Attempt | failure_check_ids | Comparison vs prev | Decision |
|---|---|---|---|
| 0 | {sections} | (none) | retry |
| 1 | {sections} | equal set → no progress | **halt** |

### Worked example — progress-but-thrashing (the open question, see below)

| Attempt | failure_check_ids | Comparison vs prev | Decision under proposal |
|---|---|---|---|
| 0 | {sections, archetype} | (none) | retry |
| 1 | {sections, evidence_model} | not subset (new failure) | retry |
| 2 | {archetype, success_metrics} | not subset | retry |
| 3 | {sections, evidence_model} | not subset | retry |
| ... | ... | ... | continues forever? |

## Open questions

### 1. Should we keep a hard safety ceiling?

The user explicitly chose "redesign halt" over "hybrid: same-failure halt + max safety bound" — but the worked example above shows a producer can theoretically loop forever by bouncing between failure sets. Possibilities:

- **No ceiling (current proposal).** Trust the same-failure detector. Risk: pathological cases waste compute; benefit: no premature halt on legitimate hard problems.
- **Soft ceiling (warn-and-continue).** After N attempts (e.g. 5), emit a `[WARN]` to the operator but keep looping. Operator can interrupt manually.
- **Hard ceiling at high N (10+).** Trust the same-failure detector for normal cases; safety net only for pathological loops. The number is meant to be uncomfortable to hit.

**Recommendation:** start with no ceiling for Phase 1 implementation (this is the spirit of the user's choice). If real-world dispatches show pathological loops, add a soft ceiling in a follow-up. Don't pre-optimize for a failure mode we haven't seen.

### 2. What counts as "the same failure set" — IDs only, or IDs + detail?

Two failures with the same check ID but different details (e.g., `all_required_sections_present` flagging "missing § Target Population" once and "missing § Timeline" the next attempt) is arguably progress on Target Population.

- **IDs only (proposal).** Simpler. A check ID flagging on attempt N+1 means the check still has *some* failure; the producer didn't reduce the failure surface. Feels right when the check is monolithic.
- **IDs + detail.** Treat each `(check_id, detail)` tuple as the unit. Strictly counts progress within a check. Risk: details can be noisy strings and may not deduplicate cleanly; also lets a producer "thrash" within a single check by flipping which sub-issue it fails on.

**Recommendation:** IDs only for Phase 1. The current 6 checks in `idea-to-pdd-qa` are mostly single-issue; the only multi-issue check is `all_required_sections_present` (lists missing sections in `detail`). For that case we accept that "still missing some section" counts as no progress even if the producer fixed one.

### 3. Where does the failure-set state live?

The QA result YAML records each attempt's failures, but not a "loop state" across attempts. Options:

- **Orchestrator-only (proposal).** The orchestrator (design-review.md procedure, executed by the design-review subagent) maintains the `previous_failure_check_ids` in its working memory across the loop. Nothing is persisted to Drive between attempts.
- **Loop-state in run_state.yaml.** Add `phases.<phase>.steps.<skill>.qa_loop: { attempt: N, previous_failure_check_ids: [...] }` so a resumed run can pick up where it left off.

**Recommendation:** Orchestrator-only for Phase 1. Loop state survives the orchestrator's procedure scope (one phase invocation); resume-after-interrupt is a separate concern that's already partially solved by the QA result YAML being the source of truth for "what happened on the last attempt." If we hit a real case where loop-resume matters, add the run_state field then.

### 4. Should halt include the *trace* of previous attempts?

Today the operator-actionable halt output names the unresolved failures + auto_fix_hints. Should it also include "attempt 0 had failures {X, Y}; attempt 1 fixed Y but X persists; attempt 2 X still present and W regressed"?

- **Proposal:** yes, include the trace. Operator triage benefits — they know whether the producer is stuck on a hard check or thrashing across a wider problem.
- **Cost:** a few extra lines in the halt YAML. Worth it.

## Implementation outline

A separate implementation PR will:

1. **Update `agents/design-review.md`** Step 1.4, 2.4, 3.4 (well, 3.4 was removed in PR #160 since journeys has no QA, so just 1.4 + 2.4) to use the new same-failure-set halt logic. New procedural prose:

   ```markdown
   ### Step 1.4: Idea-to-PDD QA (structural pass/fail)

   Invoke the `idea-to-pdd-qa` skill — runs 6 static structural checks
   against the produced PDD.

   - Input: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
   - Output: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd-qa_result.yaml`
   - **QA gates eval:** on `verdict: fail`, attempt auto-fix:
     1. Read each `failures[].auto_fix_hint`. Re-dispatch `idea-to-pdd`
        with explicit instructions to apply each hint.
     2. Re-run `idea-to-pdd-qa`.
     3. **Halt-on-stuck-failure-set:** if the new attempt's
        `failures[].check` set is a subset of (or equal to) the
        previous attempt's, halt with `verdict: incomplete`. The
        producer made no new progress on any check.
     4. Otherwise (the failure set has changed — at least one check
        dropped or a new check appeared), continue to the next attempt.
     5. On halt, surface the unresolved failures + their auto_fix_hints
        + the per-attempt failure-set trace to the operator.
   ```

2. **Add a small bookkeeping helper** in `lib/qa-runner.ts` or a new `lib/qa-loop.ts` for the orchestrator to call:

   ```typescript
   export function isStuckOnSameFailures(
     current: QAResult,
     previous: QAResult | null,
   ): boolean {
     if (previous === null) return false;  // attempt 0
     const currentIds = new Set(current.failures.map(f => f.check));
     const previousIds = new Set(previous.failures.map(f => f.check));
     return [...currentIds].every(id => previousIds.has(id));
   }
   ```

   (Pure function. Unit-testable. Used by the orchestrator's procedure but the procedure stays in the markdown — this is just a primitive the operator can also call from a script.)

3. **Update the orchestrator's halt-state YAML format** to include the per-attempt trace:

   ```yaml
   verdict: incomplete
   skill: <producer>
   target: <opp>
   halt_reason: stuck_on_same_failure_set
   attempts: N
   trace:
     - attempt: 0
       failures: [check_id_a, check_id_b, check_id_c]
     - attempt: 1
       failures: [check_id_a, check_id_b]   # progress: dropped check_c
     - attempt: 2
       failures: [check_id_a, check_id_b]   # no progress: same set as attempt 1 → halt
   unresolved_failures:
     - check: check_id_a
       detail: ...
       auto_fix_hint: ...
     - check: check_id_b
       detail: ...
       auto_fix_hint: ...
   operator_action_required: |
     Producer made no new progress between attempts 1 and 2.
     Manual intervention: <auto_fix_hints summarized>
   ```

4. **Update tests.** Add E2E loop tests under `test/e2e/qa-auto-fix-loop.test.ts` covering:
   - Convergent loop (passes within N attempts; never halt).
   - True halt (failure set unchanged across two attempts → halt at the second).
   - Progress halt (failure set keeps changing — should NOT halt under the new logic; this is the test that would have failed under the old hard-count logic).

   E2E loop tests use the same `runChecks()` primitive, but iterate via the helper from (2) instead of dispatching the orchestrator subagent.

## Migration

The procedural prose lives in `agents/design-review.md` (and analogous places when other phases get QA). No durable per-opp state changes; existing runs aren't affected.

If we add the `qa_loop` field to `run_state.yaml` later (open question 3), a small migration script reads existing runs and adds the field as `null` (no loop state). Forward-compatible.

## Done definition

The implementation PR is **done** when:

- `agents/design-review.md` Step 1.4 + 2.4 (and analogous places) reflect the new halt logic.
- `lib/qa-loop.ts` (or equivalent) ships a unit-tested `isStuckOnSameFailures` primitive.
- `test/e2e/qa-auto-fix-loop.test.ts` covers convergent / true-halt / progress-not-halted scenarios.
- A real `/ace:run` against a fresh opp with deliberately-broken inputs converges or halts as expected (manual smoke). Capture the trace in the implementation PR description.

## Update log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-09 | Initial draft. Surfaced from E2E auto-fix loop validation (Phase 1 QA/Eval split, PR #157/#159/#162). | ACE team |
