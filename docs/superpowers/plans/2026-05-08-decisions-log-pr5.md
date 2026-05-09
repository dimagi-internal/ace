# Decisions Log — PR #5: Retire "Anchor" Concept — Implementation Plan

> **For agentic workers:** Inline execution recommended (uniform mechanical edits across 9 skills + 1 test + 1 spec). No new code, no new tests.

**Goal:** Retire the "anchor" framing from PRs #2-#4. Replace with `## Common Load-Bearing Decisions` (illustrative + meaningfully improveable, not normative). Bar criterion is the sole filter; these lists are templates that guide LLM judgment, refined over time.

**Why:** "MUST emit anchor decisions if applicable" reintroduced the hardcoded-required-rows pattern PR #2 was meant to retire — just with fewer rows. Two distinct concepts got conflated:
1. **Real eval inputs** — Phase 1 (5 rows in `idea-to-pdd-eval`) and Phase 8 (4 rows in `llo-launch-eval`). The eval rubric grades on these dimensions; missing them = ungraded input.
2. **Speculative templates** — Phase 2-7 + Phase 9 anchors are guesses about what *would* be load-bearing if a viability axis existed for those rubrics. Today nothing actually grades on them.

Treating both kinds as "MUST emit if applicable" overstates the second. The cleaner framing: bar criterion filters; each phase has a list of common load-bearing decisions that informs the LLM but doesn't require any specific row.

**Architecture:** Pure doc renames + one test assertion drop. No new code.

---

## File-by-file change

| File | Change |
|---|---|
| `skills/idea-to-pdd/SKILL.md` | `### Anchor decisions` → `### Common load-bearing decisions`; drop "MUST emit" prose; merge with `### Recommended additional rows` (was already non-binding) |
| `skills/pdd-to-deliver-app/SKILL.md` | Same rename + soften wording |
| `skills/connect-opp-setup/SKILL.md` | Same |
| `skills/ocs-agent-setup/SKILL.md` | Same |
| `skills/app-test-cases/SKILL.md` | Same |
| `skills/synthetic-narrative-plan/SKILL.md` | Same |
| `skills/solicitation-create/SKILL.md` | Same |
| `skills/llo-launch/SKILL.md` | Same. The 4 rows still map 1:1 to `llo-launch-eval` viability dimensions; keep that mapping prominent so the eval grade has structured input |
| `skills/opp-closeout/SKILL.md` | Same |
| `test/skills/idea-to-pdd/decisions-fixture.test.ts` | Drop the "contains every anchor row" assertion (replace with: schema valid + invariants); the 5 Phase 1 rows that happen to be in the fixture are illustrative, not required |
| `docs/superpowers/specs/2026-05-08-decisions-log-design.md` | Wording cleanup: replace "anchor" with "common load-bearing decisions" where used as normative |

---

## Uniform replacement template (applies to all 9 SKILL.md files)

The current section structure (added in PRs #2 and #4):

```markdown
## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority); anchors below are the phase-specific subset
load-bearing for downstream eval rubrics.

### Anchor decisions

| ID | Question | Map to surface |
|---|---|---|
<rows>

### Beyond anchors

Append additional rows whenever the skill applies a load-bearing default
meeting the bar criterion ...
```

Replace with:

```markdown
## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — it's a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time
as we learn from runs.

### Common load-bearing decisions for this phase

| ID | Question | Map to surface |
|---|---|---|
<same rows as before>

The orchestrator's Phase Write-Back Verifier
(`agents/ace-orchestrator.md` § Phase Write-Back Contract § Decisions
log clause) enforces the contract; the renderer
(`skills/decisions-render`) regenerates the gdoc at end of every phase.

Each row this skill writes uses `phase: <N>-<phase-name>` and
`skill: <skill-name>`.
```

For Phase 1 (`skills/idea-to-pdd/SKILL.md`), the existing `### Anchor decisions` and `### Recommended additional rows` tables collapse into a single `### Common load-bearing decisions for Phase 1` table containing all 14 rows.

For Phase 8 (`skills/llo-launch/SKILL.md`), keep an explicit note that the 4 rows map 1:1 to `llo-launch-eval`'s viability dimensions (the eval grade depends on them being present).

For Phase 1 (`skills/idea-to-pdd/SKILL.md`), the same applies: the 5 viability-axis rows map 1:1 to `idea-to-pdd-eval`'s viability dimensions.

---

## Tasks

Inline execution; one commit per file group for easy revert.

### Task 1: Phase 1 — `skills/idea-to-pdd/SKILL.md`

Merge the `### Anchor decisions` and `### Recommended additional rows` sub-sections into a single `### Common load-bearing decisions for Phase 1`. The combined table has all 14 rows. Keep the eval-rubric mapping in the "Map to surface" column — for the 5 rows tied to viability dimensions, note `(eval anchor)` so it's visible without being normative.

### Task 2: Phase 2-9 — eight SKILL.md files

Apply the uniform replacement template to each. The "Map to surface" column stays as-is (already references real eval rubric dimensions where they exist).

### Task 3: Test fixture assertion

Replace the "contains every anchor row from the Phase 1 anchor list" assertion in `test/skills/idea-to-pdd/decisions-fixture.test.ts` with a softer "the fixture covers the 5 viability-axis decisions Phase 1's eval rubric grades on" — phrased as a fixture quality check, not a schema invariant.

### Task 4: Spec wording cleanup

Replace "anchor" with "common load-bearing decisions" where used as normative in `docs/superpowers/specs/2026-05-08-decisions-log-design.md`.

### Task 5: Run full test suite + tsc

Confirm no regressions.

### Task 6: Version bump + push + PR

---

## Self-review

**Spec coverage** — every place "anchor" is used as a normative term gets the rename + soften treatment.

**No code changes** — purely doc + one test assertion edit.

**Backward compatibility** — fixtures with the 5 Phase 1 viability rows still pass tests; the wording shift is invisible to the merger / parser / renderer.

---
