# Don't formalize what orchestrator judgment handles

**Date:** 2026-05-09
**Triggered by:** Closed PR #163, replaced with PR #170. The closed PR drafted a 200-line design doc to formalize the QA auto-fix loop's halt logic — replace the hard-count "halt after 2 attempts" rule with a "halt when the same failure set persists" detector. Four "open design questions" surfaced for review (safety ceiling? IDs vs IDs+details? loop-state location? per-attempt trace?). The user pushed back: "These are all weird questions that we should just let the orchestrator do correctly."

## The pattern

ACE's orchestration is procedural-prose-driven: agent procedure docs (`agents/*.md`) are markdown an LLM (the dispatched subagent) reads and executes. The LLM applies judgment within the procedure. This is a feature, not a workaround — it lets us specify intent without pseudocode.

Over-specification happens when we treat the procedure doc as if it were code:

- **Pseudocode-ifying judgment calls.** "Should we keep looping if the failure count drops but the IDs are the same?" → an LLM reading "halt when the producer can no longer make progress" decides this in context. Specifying the answer formally ties our hands.
- **Designing for edge cases the user hasn't seen.** Pathological loops, partial-progress detection, resume-after-interrupt — these all get formalized in the spec but never trigger in practice. Writing them in code costs maintenance + invites bugs in the formalization itself.
- **Bookkeeping shape decisions.** "Where does loop state live?" "Should the halt YAML include a trace?" — these are tactics the orchestrator can decide situationally, not contracts.

The result is over-engineering: a 200-line design doc + 4 open questions + an implementation PR + tests, when 3 sentences of prose would have done it.

## How to detect over-spec

When you find yourself writing a design-doc PR (per the established pattern), ask:

1. **Is the rule a judgment call an LLM can make from a one-line statement of intent?** ("Halt when stuck on same problem" vs "Halt after exactly 2 attempts.") If yes, prose is enough.
2. **Are the "open questions" all bookkeeping shape decisions?** (Where does state live? What format does X take? Compare A or B+C?) If all of them are tactics, not contracts, the design doc is over-spec.
3. **Would an LLM reading the prose default to the right answer 90% of the time?** If yes, the spec is documenting what the LLM would do anyway.
4. **Does the implementation PR add a `lib/<thing>.ts` helper for what's currently a paragraph of prose?** If the prose-to-code translation isn't catching real failure modes, the helper is added complexity for no benefit.

When all four are true, **drop the spec; ship a prose update**. The change probably needed to be 3 sentences in `agents/<phase>.md`, not 200 lines + helper + tests.

## What to do when you spot over-spec

1. **Close the spec PR** (or rewrite as a 3-sentence prose change).
2. **Update the relevant `agents/*.md` procedure** with a one-line intent statement that an LLM can apply judgment around.
3. **Don't formalize the open questions.** Leave them to the orchestrator. If a real failure mode shows up later (the orchestrator made the wrong judgment in some edge case), update the prose to nudge it differently — still in prose.
4. **Capture the meta-learning** if the over-spec pattern is recurring (this doc is one).

## What this is NOT

This learning is about *over-spec for orchestrator-decidable judgment*. Real specs are still valuable when:

- The decision affects external systems (data retention, auth boundaries, irreversible actions like `award_response`).
- Multiple skills/agents need to coordinate around a contract (e.g., the artifact-path scheme, the QA result YAML schema in `lib/qa-types.ts`).
- The cost of getting it wrong is high enough that "trust the LLM" isn't acceptable (security-critical paths, billing).
- A future maintainer reading the code couldn't reverse-engineer the design intent (cross-cutting architectural decisions like the QA/Eval split principle itself).

The line: **specs codify contracts that span boundaries (other code, other agents, external systems). Don't spec what's local to the orchestrator's loop.**

## Related

- Closed PR #163 — the worked example. 200 lines of spec for a behavior that's now 3 sentences in `agents/design-review.md`.
- Replacement PR #170 — the prose-only fix.
- `docs/learnings/2026-05-08-fake-qa-detection.md` — the sibling learning about not building QA infrastructure that doesn't add value. Same shape: don't add structure that the existing primitives (LLM grading, in this case orchestrator judgment) already provide.

The two learnings together: **trust the LLMs that already exist in the system. Don't build infrastructure to do what they would do anyway.**
