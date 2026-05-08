# Fake QA: how to spot a structural check that gates nothing

**Date:** 2026-05-08
**Triggered by:** Phase 1 QA/Eval-split validation against turmeric run `20260507-1733`. The new `pdd-to-app-journeys-qa` skill flagged `verdict: fail` on a perfectly usable journeys artifact — the producer used `**Goal.**` (period) and the QA's regex required `**Goal:**` (colon). Investigation showed the QA's strictness gated nothing real downstream.

## The pattern

A QA skill enforces structural properties of an artifact (sections present, fields populated, exact label format). The intent is to catch malformed artifacts before eval grades them. The reality, when it goes wrong:

- The downstream consumer is **another LLM** that reads the artifact as prose context.
- The LLM doesn't care about exact label punctuation — it reads the *content* and infers the meaning.
- The QA's structural strictness can fail on artifacts that downstream consumes happily, OR pass on artifacts that downstream silently mis-interprets. Either way, QA is buying nothing.

This is "fake QA": it looks like a binary safety net, but it isn't gating any real behavior. It just adds noise + maintenance cost.

## How to detect it on a code review

When reviewing a `<producer>-qa` skill (new or existing), ask three questions:

1. **Who reads the artifact?** Trace the artifact through the codebase — `grep` for the artifact's path. List every consumer.
2. **For each consumer, do they regex/parse the artifact, or read it as LLM prompt context?** If every consumer is an LLM-driven skill, the consumer doesn't care about label format.
3. **Does any code path branch on the QA verdict beyond "skip eval"?** If the only effect of QA fail is "eval is skipped," the eval already grades the substantive concerns and the QA's structural enforcement is redundant.

**If all three answers are "LLM-only / no real branch," the QA is fake.** Drop it.

The worked example: `pdd-to-app-journeys-qa` had 7 checks; 4 of them (each_journey_has_goal / happy_path / edge_cases / pass_criteria) enforced bold-label punctuation. Both downstream consumers (`app-test-cases`, `app-ux-eval`) are LLM-driven; neither parses labels. The eval (`pdd-to-app-journeys-eval`) already graded narrative voice, edge-case recoverability, pass-criteria measurability — the same concerns the QA was structurally proxying. The QA was net-negative: noise on real content, zero coverage gain.

## What to do when you spot fake QA

1. **Drop the QA skill** + its tests + the design-review wiring + the manifest entry.
2. **Update the eval skill** to not gate on a QA verdict (since there isn't one). Add a fast-path halt for missing/empty producer artifact so the absent-QA case is still defended.
3. **Record the decision** in `skills/_qa-decisions.md` with rationale + revisit conditions. Don't let absence-from-table happen — that's indistinguishable from "not yet migrated."
4. **Cross-link** the no-QA decision from the producer skill's change log so readers of the skill find it.

## What this is NOT

This learning is about *fake* QA — checks that don't gate anything real. Real QA is still valuable when:

- The artifact has a **machine-parsed schema** (JSON, YAML, structured CSV) and a downstream consumer parses it. Schema validation is real QA.
- The artifact has a **header / count claim** that downstream sanity-checks ("Total prompts: N" must equal actual prompt count). That's real QA — the integrity invariant gates correctness.
- The artifact has **regex-extracted fields** that drive code paths. Field-presence is real QA.
- The artifact is a **runtime exercise capture** (deployed chatbot transcript, app screenshot manifest) that has format-shape consumers parse. That's real QA — see `_qa-template.md § When QA work requires runtime`.

The line: real QA gates real machine consumers. Fake QA enforces aesthetic regularity that no machine consumer cares about.

## Related

- `skills/_qa-template.md § When to skip QA` — the heuristic codified into the QA author contract.
- `skills/_qa-decisions.md` — per-skill registry; this learning's worked example (`pdd-to-app-journeys`) is the first `NO QA` entry.
- ACE PR #160 — dropped `pdd-to-app-journeys-qa`, introduced `_qa-decisions.md`.
