# Decisions Log — PR #4: Phase 2-9 Writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Extend decisions-log writing across all 9 phases. Each phase's primary writing skill gains a `## Decisions Log` section that (a) references `skills/idea-to-pdd/SKILL.md § Decisions Log Convention` as the authoritative bar criterion, (b) declares 1-4 anchor decisions specific to the phase, (c) acknowledges additional rows beyond anchors come from LLM judgment per the bar.

**Architecture:** Pure doc surface — no new code, no new tests. The orchestrator's Phase Write-Back Verifier already enforces "every phase MUST append rows to decisions.yaml" (PR #1). The renderer auto-picks up new rows on every phase invocation (PR #2). The sync skill rounds-trips human edits (PR #3). PR #4's job is to give each phase's writing skill phase-specific guidance about which anchors are load-bearing.

**Tech stack:** Markdown editing only.

**Spec deviation:** None — this is the spec's PR #2 scope (Phase 2-9 writes), reordered behind PRs #2 and #3 because human visibility and iteration matter before broader data collection.

---

## Phase → primary writing skill → anchor decisions

| Phase | Skill | Anchor rows |
|---|---|---|
| 2 commcare | `pdd-to-deliver-app` | `deliver-unit-count`, `one-form-per-module-workaround`, `multimedia-coverage-strategy` |
| 3 connect | `connect-opp-setup` | `verification-flags`, `payment-unit-shape`, `opportunity-end-date` |
| 4 ocs | `ocs-agent-setup` | `system-prompt-baseline`, `rag-collection-scope`, `test-prompt-count` |
| 5 qa-and-training | `app-test-cases` | `test-scenario-count`, `test-archetype-coverage` |
| 6 synthetic | `synthetic-narrative-plan` | `persona-count`, `scenario-count`, `narrative-arc-shape` |
| 7 solicitation | `solicitation-create` | `solicitation-type`, `response-deadline`, `response-template-choice` |
| 8 execution | `llo-launch` | `llo-capacity-actual`, `day-one-readiness`, `downstream-handoff-alignment`, `stop-loss-planning` |
| 9 closeout | `opp-closeout` | `closeout-depth`, `learnings-summary-scope` |

The Phase 8 anchors come directly from `llo-launch-eval`'s viability axis (PR #145). Other phases' anchors are derived from common load-bearing decisions; each phase's eval rubric has not declared explicit viability dimensions yet, so the bar criterion is the operative filter.

---

## Tasks

Each task adds a uniform `## Decisions Log` section to the named skill. The section structure is identical across all 8 skills; only the anchor list and phase tag vary.

### Task structure (applies to Tasks 1-8)

For each skill in the table above, append a new top-level section before the existing `## Change Log` table. The section template:

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
<phase-specific rows>

### Beyond anchors

Append additional rows whenever the skill applies a load-bearing default
meeting the bar criterion (load-bearing + maps to known surface). The
orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: <N>-<phase-name>` and
`skill: <this-skill-name>`.
```

Then add a row to the `## Change Log` table:

```markdown
| 2026-05-08 | Add `## Decisions Log` section: phase-specific anchor rows + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 2-9 writes). | ACE team (decisions-log PR #4) |
```

---

### Task 1: Phase 2 — `skills/pdd-to-deliver-app/SKILL.md`

Anchor rows:

```markdown
| `deliver-unit-count` | How many distinct deliver units (modules × forms) does the Deliver app expose? | PDD `Deliver App Specification` numeric |
| `one-form-per-module-workaround` | Are we one-form-per-module to dodge Nova's CCZ marker bug? | `pdd-to-deliver-app-eval` connect-marker-coverage dimension; CLAUDE.md gotcha |
| `multimedia-coverage-strategy` | What multimedia (text vs voice prompts vs both) does the Deliver app surface? | `app-multimedia-coverage` skill output; PDD multimedia note |
```

Phase tag: `2-commcare`. Skill name: `pdd-to-deliver-app`.

- [ ] Add the section.
- [ ] Add change-log row.
- [ ] Commit:
  ```bash
  git add skills/pdd-to-deliver-app/SKILL.md
  git commit -m "skill(pdd-to-deliver-app): wire Phase 2 anchors to decisions log

3 anchor rows: deliver-unit-count, one-form-per-module-workaround,
multimedia-coverage-strategy. References the bar criterion in
idea-to-pdd's Decisions Log Convention as the authoritative filter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: Phase 3 — `skills/connect-opp-setup/SKILL.md`

Anchor rows:

```markdown
| `verification-flags` | Which verification flags (gps, photo, location toggle, duration thresholds) does the opportunity require? | `connect-opp-setup-eval`; PDD `Verification Mechanism` |
| `payment-unit-shape` | Per-visit fixed amount, tiered, milestone-gated, etc.? | `connect-opp-setup` payment-unit creation; PDD `Payment Rate` |
| `opportunity-end-date` | When does the opportunity close? | PDD `Timeline` numeric; gates Phase 8 monitoring cadence |
```

Phase tag: `3-connect`. Skill name: `connect-opp-setup`.

- [ ] Add section + change-log row.
- [ ] Commit.

---

### Task 3: Phase 4 — `skills/ocs-agent-setup/SKILL.md`

Anchor rows:

```markdown
| `system-prompt-baseline` | What baseline system prompt does the per-opp chatbot inherit (golden template default vs. customized for archetype)? | `ocs-chatbot-eval` rubric coverage |
| `rag-collection-scope` | What documents land in the per-opp RAG collection (golden defaults vs. opp-specific additions)? | `ocs-chatbot-eval` retrieval-quality dimension |
| `test-prompt-count` | How many test prompts feed the smoke-eval gate (default 5 quick, 90 deep)? | `pdd-to-test-prompts` output cardinality; deep vs shallow QA split |
```

Phase tag: `4-ocs`. Skill name: `ocs-agent-setup`.

- [ ] Add section + change-log row.
- [ ] Commit.

---

### Task 4: Phase 5 — `skills/app-test-cases/SKILL.md`

Anchor rows:

```markdown
| `test-scenario-count` | How many app-walkthrough scenarios feed the qa+eval pair? | `pdd-to-app-journeys-eval` coverage_completeness dimension |
| `test-archetype-coverage` | Are all archetypes in the PDD covered by at least one scenario? | `pdd-to-app-journeys-eval` archetype_alignment dimension |
```

Phase tag: `5-qa-and-training`. Skill name: `app-test-cases`.

- [ ] Add section + change-log row.
- [ ] Commit.

---

### Task 5: Phase 6 — `skills/synthetic-narrative-plan/SKILL.md`

Anchor rows:

```markdown
| `persona-count` | How many personas does the synthetic data narrative cover? | `synthetic-narrative-plan-eval` persona-coverage dimension |
| `scenario-count` | How many distinct scenarios per persona? | `synthetic-narrative-plan-eval` scenario-density |
| `narrative-arc-shape` | Linear, branching, or stage-gated story arc? | `synthetic-narrative-plan-eval` narrative-coherence; archetype alignment |
```

Phase tag: `6-synthetic-data-and-workflows`. Skill name: `synthetic-narrative-plan`.

- [ ] Add section + change-log row.
- [ ] Commit.

---

### Task 6: Phase 7 — `skills/solicitation-create/SKILL.md`

Anchor rows:

```markdown
| `solicitation-type` | EOI vs RFP vs custom? | `solicitation-create-eval`; affects who applies and at what fidelity |
| `response-deadline` | Days from publish to deadline (default 14)? | `solicitation-create` schema; gates Phase 7→8 timing |
| `response-template-choice` | Stock template vs opp-custom response form? | `solicitation-create` content; downstream `solicitation-review` rubric input |
```

Phase tag: `7-solicitation-management`. Skill name: `solicitation-create`.

- [ ] Add section + change-log row.
- [ ] Commit.

---

### Task 7: Phase 8 — `skills/llo-launch/SKILL.md`

Anchor rows (these come directly from `llo-launch-eval`'s viability axis added in PR #145):

```markdown
| `llo-capacity-actual` | Did the LLO actually recruit the team they promised? | `llo-launch-eval` `llo_capacity_actual` dimension (PR #145) |
| `day-one-readiness` | Are FLWs actually ready Day 1 (training complete, devices provisioned, accounts activated)? | `llo-launch-eval` `day_one_readiness` dimension (PR #145) |
| `downstream-handoff-alignment` | Is the named downstream consumer ready to receive data on the agreed cadence? | `llo-launch-eval` `downstream_handoff_alignment` dimension (PR #145) |
| `stop-loss-planning` | Is there a documented halt condition (data-quality floor, recruitment failure, etc.)? | `llo-launch-eval` `stop_loss_planning` dimension (PR #145) |
```

Phase tag: `8-execution-management`. Skill name: `llo-launch`.

- [ ] Add section + change-log row.
- [ ] Commit.

---

### Task 8: Phase 9 — `skills/opp-closeout/SKILL.md`

Anchor rows:

```markdown
| `closeout-depth` | Standard summary vs. deep retrospective with cycle-grade re-anchor? | `cycle-grade-eval` rubric input |
| `learnings-summary-scope` | Per-opp only, or cross-opp pattern aggregation? | `learnings-summary` skill output; ACE-wide pattern catalogue |
```

Phase tag: `9-closeout`. Skill name: `opp-closeout`.

- [ ] Add section + change-log row.
- [ ] Commit.

---

### Task 9: Run full test suite

- [ ] Run `npm test`. Expected: all pre-existing tests pass; no new tests added in this PR.

If anything fails, the SKILL.md edits broke a markdown-grep-shaped test (e.g., a test counts `## ` sections per skill). Fix by reverting the offending change or adjusting the test to allow the new section.

---

### Task 10: Version bump + push + PR

- [ ] Run `bash scripts/version-bump.sh` and `npm install --package-lock-only`.
- [ ] Commit:
  ```bash
  git add VERSION package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
  git commit -m "chore: bump version for decisions-log PR #4 (Phase 2-9 writes)

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```
- [ ] Push: `git push -u origin emdash/questions-70lfu`.
- [ ] Open the PR:
  ```bash
  gh pr create --title "decisions-log PR #4: Phase 2-9 anchor decisions" --body "$(cat <<'EOF'
  ## Summary

  Fourth PR in the decisions-log series ([spec](docs/superpowers/specs/2026-05-08-decisions-log-design.md), [plan](docs/superpowers/plans/2026-05-08-decisions-log-pr4.md)). Extends decisions-log writing from Phase 1 (PR #1-#3) to all 9 phases.

  ## What ships

  Eight skill bodies updated with a uniform `## Decisions Log` section listing per-phase anchor decisions tied to specific eval rubric dimensions. Doc-only — no new code, no new tests. The orchestrator contract, the renderer, and the sync skill are already wired (PRs #1-#3) and pick up rows from any phase automatically.

  | Phase | Skill | Anchors |
  |---|---|---|
  | 2 commcare | \`pdd-to-deliver-app\` | deliver-unit-count, one-form-per-module-workaround, multimedia-coverage-strategy |
  | 3 connect | \`connect-opp-setup\` | verification-flags, payment-unit-shape, opportunity-end-date |
  | 4 ocs | \`ocs-agent-setup\` | system-prompt-baseline, rag-collection-scope, test-prompt-count |
  | 5 qa-and-training | \`app-test-cases\` | test-scenario-count, test-archetype-coverage |
  | 6 synthetic | \`synthetic-narrative-plan\` | persona-count, scenario-count, narrative-arc-shape |
  | 7 solicitation | \`solicitation-create\` | solicitation-type, response-deadline, response-template-choice |
  | 8 execution | \`llo-launch\` | llo-capacity-actual, day-one-readiness, downstream-handoff-alignment, stop-loss-planning |
  | 9 closeout | \`opp-closeout\` | closeout-depth, learnings-summary-scope |

  Phase 8 anchors come directly from \`llo-launch-eval\`'s viability axis (PR #145); other phases' anchors derive from common load-bearing decisions per the bar criterion.

  ## What does NOT ship

  - Eval rubric re-anchor (\`idea-to-pdd-eval\`'s \`deferred-decision-discipline\` branch grading on \`decisions.yaml\` directly) — separate follow-up.

  ## Test plan

  - [ ] CI green
  - [x] \`npm test\` passes locally
  - [ ] Manual verification: re-run any phase, confirm new rows appear in decisions.yaml + decisions.gdoc with the phase tag set correctly

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

---

## Self-review pass

**Spec coverage** — all 8 phases mapped to a primary writing skill with anchor rows.

**Placeholder scan** — anchor row `Map to surface` cells reference real eval rubric dimensions where they exist (Phase 8 viability axis from PR #145; Phase 1 archetype/numbers/etc. dimensions). For phases without explicit viability dimensions in their eval rubrics yet, the surface is the corresponding rubric file or PDD section — concrete enough.

**Type consistency** — every anchor row's phase tag matches the phase name in the table; every skill name matches the actual skill directory.

---

## Execution

Subagent-driven not strictly needed (mechanical doc edits, ~5-10 lines per skill). Inline execution is cleaner for this PR.
