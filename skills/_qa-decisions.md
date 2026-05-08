# Per-skill QA decisions

Comprehensive registry of every producer skill's QA status. **Every producer is in this table.** Missing-from-table is a contract violation, not a defaulting case — if you add a producer skill, add a row here.

This file is the canonical answer to "does skill X have QA, and why or why not?" The QA contract itself lives at [`_qa-template.md`](./_qa-template.md); the principle (when to use vs skip QA) lives at [`README.md § QA vs Eval`](./README.md). This file tracks **state**, not principle.

## Status values

Three states cover every producer:

| Status | Meaning |
|---|---|
| **`has QA`** | A `<producer>-qa` skill exists. Cell points at the skill + the PR that added it. |
| **`NO QA`** | We deliberately decided this producer doesn't need a QA skill. Cell explains why + lists the conditions under which we'd revisit. |
| **`not yet migrated`** | Pending a future migration phase. Cell points at the migration phase in [`docs/superpowers/specs/2026-05-08-qa-eval-migration.md`](../docs/superpowers/specs/2026-05-08-qa-eval-migration.md). |

A fourth implicit state — *not applicable* — covers utility skills with no per-opp artifact to QA (e.g. `email-communicator`). These are listed but excluded from the migration count.

## When to skip QA (the heuristic that drives `NO QA` decisions)

If **all three** are true, default to `NO QA`:

1. **The artifact's downstream consumers are LLM-driven.** They read the artifact as prose context, not via regex/parser.
2. **No structural property gates anything real.** No CI check, no code path, no orchestrator decision branches on the artifact's exact format.
3. **Quality is what matters, and the eval already grades it.** The companion `-eval` skill's dimensions cover the substantive concerns (specificity, recoverability, measurability, etc.).

When this triple holds, a QA skill enforcing label format / section presence is "fake QA" — it can fail on perfectly usable artifacts (period vs colon punctuation), and it adds zero value the eval doesn't already provide. See [`docs/learnings/2026-05-08-fake-qa-detection.md`](../docs/learnings/2026-05-08-fake-qa-detection.md) for the worked example that produced this principle.

When in doubt, ask: *if I deleted this QA skill, would any downstream consumer notice?* If the answer is "no, because the eval already catches everything that matters," the QA is fake.

## Registry

### Phase 1 — design-review

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `idea-to-pdd` | **has QA** | `idea-to-pdd-qa` (PR #149). 6 static checks: required sections, archetype enum, stress-test appendix, success-metrics table, evidence-model layers, reviewer-comment table. Downstream skills regex-extract sections from the PDD; structural correctness gates real consumers. |
| `pdd-to-app-journeys` | **NO QA** | Dropped in PR #160 (this file's introduction). Downstream consumers (`app-test-cases`, `app-ux-eval`) are LLM-driven and grade content, not bold-label punctuation. Eval (`pdd-to-app-journeys-eval`) already grades narrative voice, edge-case recoverability, pass-criteria measurability — so a QA enforcing `**Goal:**` vs `**Goal.**` adds noise without value. **Revisit if:** a future consumer (e.g. a new `app-*` skill) starts regex-parsing the journeys doc, OR if the eval's calibration shows it's failing to catch issues a structural QA would have caught. |
| `pdd-to-test-prompts` | **has QA** | `pdd-to-test-prompts-qa` (PR #151). 8 static checks: header + total count, prompt count in range, each prompt has required fields, all 5 adversarial categories present, ≥15% adversarial share, training-gap / product-feedback / escalation prompts. The `Total prompts: N` header is parsed by `ocs-chatbot-qa` for sanity-checking; structural correctness gates real consumers. |

### Phase 2 — commcare-setup

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `pdd-to-learn-app` | not yet migrated | Phase 2 batch (Nova builders) per migration spec. Will likely share a `nova-qa` helper checking compiled-app schema. |
| `pdd-to-deliver-app` | not yet migrated | Phase 2 batch — same `nova-qa` helper. |
| `app-deploy` | not yet migrated | Phase 2 batch — QA = "publish succeeded; markers present in CCZ". |
| `app-release` | not yet migrated | Phase 2 batch — QA = "released; status reads 'released'". |
| `app-multimedia-coverage` | not yet migrated | Manual sibling of `commcare-form-patch`; Phase 2 batch reach. |
| `commcare-form-patch` | not yet migrated | Manual fix-loop skill; QA scope to be decided during Phase 2 batch. |
| `app-connect-coverage` | not yet migrated | Phase 2 reach. |

### Phase 3 — connect-setup

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `connect-program-setup` | not yet migrated | Phase 5 standalone migration per spec — critical Connect setup chain. |
| `connect-opp-setup` | not yet migrated | Phase 5 standalone migration per spec. |

### Phase 4 — ocs-setup

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `ocs-agent-setup` | not yet migrated | Phase 5 standalone migration per spec — chatbot creation. |
| `ocs-chatbot-qa` (runtime) | **has QA** | Reference example for runtime-exercise QA pattern. Pairs with `ocs-chatbot-eval`. The "producer" here is the deployed chatbot (runtime artifact), not a Drive document — `ocs-chatbot-qa` exercises it via probes and writes a transcript. See `_qa-template.md § When QA work requires runtime`. |

### Phase 5 — qa-and-training

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `app-screenshot-capture` | not yet migrated | Has internal manifest verification today; could become a proper `-qa` companion in Phase 3 batch. |
| `app-test-cases` | not yet migrated | Phase 3 batch — bindings YAML schema, recipe-ID resolution. |
| `training-faq` | not yet migrated | Phase 3 batch (training cluster) — shared `training-qa` helper proposed. Likely candidate for `NO QA` per the heuristic — review during Phase 3. |
| `training-llo-guide` | not yet migrated | Phase 3 batch — shared `training-qa`. Likely `NO QA` candidate. |
| `training-flw-guide` | not yet migrated | Phase 3 batch — shared `training-qa`. Likely `NO QA` candidate. |
| `training-onboarding-email` | not yet migrated | Phase 3 batch — shared `training-qa`. Likely `NO QA` candidate. |
| `training-quick-reference` | not yet migrated | Phase 3 batch — shared `training-qa`. Likely `NO QA` candidate. |
| `training-deck-outline` | not yet migrated | Phase 3 batch. Slide-spec consumer is LLM-driven; likely `NO QA`. |
| `training-deck-build` | not yet migrated | Phase 3 batch. Renders deck via Slides API; QA could verify structural slide count. |
| `connect-baseline-screenshots` | not yet migrated | Standalone skill; QA scope tbd. |

### Phase 6 — synthetic-data-and-workflows

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `synthetic-narrative-plan` | not yet migrated | Phase 4 batch — shared `synthetic-qa` helper proposed (manifest schema, narrative-anchoring). |
| `synthetic-data-generate` | not yet migrated | Phase 4 batch — manifest schema is real (`connect_labs.synthetic_generate_from_manifest` consumes it). Likely `has QA`. |
| `synthetic-walkthrough-spec` | not yet migrated | Phase 4 batch. |
| `synthetic-walkthrough-run` | not yet migrated | Phase 4 batch — runtime exercise, possibly `has QA` runtime-pattern. |
| `synthetic-summary` | not yet migrated | Phase 4 batch — likely `NO QA` candidate (LLM-driven consumer). |
| `synthetic-workflow-seed` | not yet migrated | Phase 4 batch — workflow YAML schema is real. Likely `has QA`. |
| `synthetic-workflow-polish` | not yet migrated | Phase 4 batch. |

### Phase 7 — solicitation-management

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `solicitation-create` | not yet migrated | Phase 5 standalone migration per spec. |
| `solicitation-monitor` | not yet migrated | Recurring; state-tracking QA only — no quality eval per spec. |
| `solicitation-review` | not yet migrated | Phase 5 standalone — gates Phase 6→7 award decision; needs both QA + strong eval. |

### Phase 8 — execution-management

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `llo-onboarding` | not yet migrated | Phase 6 reach. |
| `llo-launch` | not yet migrated | Phase 5 standalone — Phase 8 entry gate; QA needs extracting. |
| `llo-invite` | not yet migrated | Phase 6 reach. |
| `llo-uat` | not yet migrated | Phase 6 reach. |
| `flw-data-review` | not yet migrated | Recurring — state-tracking QA only. |
| `timeline-monitor` | not yet migrated | Recurring — state-tracking QA only. |

### Phase 9 — closeout

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `opp-closeout` | not yet migrated | Phase 6 reach. |
| `llo-feedback` | not yet migrated | Phase 6 reach. |
| `learnings-summary` | not yet migrated | Phase 6 reach. |
| `cycle-grade` | not yet migrated | Phase 6 reach. |

### Utility / cross-cutting (no per-opp artifact)

| Producer | QA status | Rationale |
|---|---|---|
| `email-communicator` | not applicable | Utility skill — sends mail; no Drive artifact. |
| `decisions-render` | not applicable | Utility skill — renders `decisions.yaml` to HTML. Already has unit tests on the renderer; no per-opp artifact under QA scope. |
| `upload-transcript` | not applicable | Utility — ingests JSONL transcripts. |
| `eval-calibration` | not applicable | Meta-skill — calibrates other evals' rubrics. Not a producer of a per-opp artifact. |

## Maintenance

- When a new producer skill ships, add a row in the appropriate Phase section with one of the four states.
- When a producer's QA status changes (gains a `-qa`, deletes its `-qa`, or migrates from `not yet migrated` to one of the other two), update its row.
- Cross-link from the producer's own `SKILL.md § Change Log` so readers of the skill discover the decision.
- A future CI lint can enforce "every `producedBy` in `lib/artifact-manifest.ts` has a row in this table" — leaving room for that, the table follows the same naming as the manifest.

## Change log

| Date | Change | Author |
|---|---|---|
| 2026-05-08 | Initial registry (PR #160). Captures three `has QA` (idea-to-pdd, pdd-to-test-prompts, ocs-chatbot runtime) + first `NO QA` (pdd-to-app-journeys, with rationale). Remaining 40+ producers marked `not yet migrated` per the migration spec's phase plan. | ACE team |
