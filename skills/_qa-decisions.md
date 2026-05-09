# Per-skill QA decisions

Comprehensive registry of every producer skill's QA status. **Every producer is in this table.** Missing-from-table is a contract violation, not a defaulting case — if you add a producer skill, add a row here.

This file is the canonical answer to "does skill X have QA, and why or why not?" The QA contract itself lives at [`_qa-template.md`](./_qa-template.md); the principle (when to use vs skip QA) lives at [`README.md § QA vs Eval`](./README.md). This file tracks **state**, not principle.

## Status values

Four states cover every producer:

| Status | Meaning |
|---|---|
| **`has QA`** | A standalone `<producer>-qa` skill exists. Cell points at the skill + the PR that added it. |
| **`inline QA`** | The producer's own `## Process` does the structural-correctness checks inline (typically a verify-and-retry loop tightly bound to an external system the producer interacts with). Cell points at the SKILL.md section(s) doing the work + lists the inline checks. See `_qa-template.md § When QA belongs inline` for the heuristic. |
| **`NO QA`** | We deliberately decided this producer doesn't need a QA skill. Cell explains why + lists the conditions under which we'd revisit. |
| **`not yet migrated`** | Pending a future migration phase. Cell points at the migration phase in [`docs/superpowers/specs/2026-05-08-qa-eval-migration.md`](../docs/superpowers/specs/2026-05-08-qa-eval-migration.md). |

A fifth implicit state — *not applicable* — covers utility skills with no per-opp artifact to QA (e.g. `email-communicator`). These are listed but excluded from the migration count.

## When to skip QA (the heuristic that drives `NO QA` decisions)

If **all three** are true, default to `NO QA`:

1. **The artifact's downstream consumers are LLM-driven.** They read the artifact as prose context, not via regex/parser.
2. **No structural property gates anything real.** No CI check, no code path, no orchestrator decision branches on the artifact's exact format.
3. **Quality is what matters, and the eval already grades it.** The companion `-eval` skill's dimensions cover the substantive concerns (specificity, recoverability, measurability, etc.).

When this triple holds, a QA skill enforcing label format / section presence is "fake QA" — it can fail on perfectly usable artifacts (period vs colon punctuation), and it adds zero value the eval doesn't already provide. See [`docs/learnings/2026-05-08-fake-qa-detection.md`](../docs/learnings/2026-05-08-fake-qa-detection.md) for the worked example that produced this principle.

When in doubt, ask: *if I deleted this QA skill, would any downstream consumer notice?* If the answer is "no, because the eval already catches everything that matters," the QA is fake.

## When QA belongs inline (the heuristic that drives `inline QA` decisions)

Some producers do real, non-fake structural checks but the right home for those checks is *inside the producer*, not a separate `-qa` skill. Default to `inline QA` when **both** are true:

1. **The producer interacts tightly with an external system** (Nova MCP, Mobile Maestro, CCHQ HTTP API, OCS clone-and-configure flow, etc.) where the verify-and-retry loop benefits from being in the producer's same agent context — every "fix" is a short-cycle call into the same external system the producer just used.
2. **Extracting QA would force the producer to be dispatched twice** for what is conceptually one task. The dispatch overhead (orchestrator → producer → orchestrator → -qa skill → orchestrator → producer with hint → ...) costs round-trips and loses the producer's working context.

Reference example: Phase 2's Nova builders (`pdd-to-learn-app`, `pdd-to-deliver-app`, `app-deploy`, `app-release`) all do bounded verify-and-retry loops via `/nova:edit` or CCHQ HTTP atoms in the same agent invocation that did the original build. Pulling those checks out into separate `-qa` skills would more than double Nova/CCHQ round-trips per Phase 2 run and force a redesign of the producer's iteration loop, while adding nothing to what the inline checks already catch (Connect markers, slug uniqueness, XML escapes, CCZ collision projection).

Contrast with `idea-to-pdd` (Phase 1): the producer writes a Drive artifact and exits; the orchestrator reads independently. Separate `-qa` skill works cleanly because there's no external-system context to lose.

The shape distinction:

| Producer pattern | QA placement |
|---|---|
| Writes Drive artifact, orchestrator reads independently | Separate `-qa` skill |
| Iterates tightly with an external system (Nova MCP, Mobile, CCHQ HTTP, OCS configure) | `inline QA` in producer |

`inline QA` is **not a downgrade from `has QA`** — it is the right shape when the producer's iteration is already where QA belongs. The registry treats it as a first-class status so future audits know it was a deliberate decision (not "we forgot to extract").

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
| `pdd-to-learn-app` | **inline QA** | Inline checks in `skills/pdd-to-learn-app/SKILL.md § Process step 4a` (post-build field-count verification — `get_app` + per-form `get_form`, cross-reference against PDD-expected counts, bounded retry via `/nova:edit`, max 3 iterations, halt with named failures). Connect-marker verification delegated to sibling `app-connect-coverage` skill (Phase 2 Step 1.5). Schema validity is Nova's own `validate_app` — not duplicated here. |
| `pdd-to-deliver-app` | **inline QA** | Inline checks in `skills/pdd-to-deliver-app/SKILL.md § Process steps 4a + 4b`. 4a: same field-count verify-and-retry as Learn. 4b: structural pre-flight asserting `paid_module_count === intended_paid_form_count` (every paid form lives in its own module — works around Nova's per-module slug reuse that would silently collapse multi-form modules into one Connect deliver_unit). Bounded retry via `/nova:edit`, max 3 iterations. Connect markers delegated to `app-connect-coverage`. |
| `app-deploy` | **inline QA** | Inline checks in `skills/app-deploy/SKILL.md`. § Step 2 — domain match (Nova's bound HQ project space === `ACE_HQ_DOMAIN`). § Step 2.5 — XML-escape lint walking every form, catches `<`/`>`/`&` in field labels that Nova's `validate_app` says ok but CCHQ build rejects. § Steps 3–4 — build-status check on each upload. Class-level preventer per `docs/issues/nova-validate-app-misses-xml-escapes.md`. |
| `app-release` | **inline QA** | Inline checks in `skills/app-release/SKILL.md`. § Step 3 — Connect-coverage pre-flight gate consuming `app-connect-coverage` verdict. § Step 5 — released-state verification via CCHQ read-only API. § Step 6 — CCZ verification: `commcare_download_ccz` projection MUST have `collision_count: 0` (no slug collisions Connect would silently dedup) AND per-type record counts > 0 (Connect markers present in CCZ). On any fail, halt with `[BLOCKER]` naming each colliding slug + kept/dropped forms. Replaces what would have been most of `app-release-qa`. |
| `app-multimedia-coverage` | not yet migrated | Manual sibling of `commcare-form-patch`; Phase 2 reach when its inline shape is reviewed. |
| `commcare-form-patch` | not yet migrated | Manual fix-loop skill; likely `inline QA` candidate. Review when reached. |
| `app-connect-coverage` | **inline QA** | This skill IS the verify-and-fix QA for Connect-marker coverage on Nova-built apps. Inline loop in `skills/app-connect-coverage/SKILL.md` checks every form for required `connect.deliver_unit`/`learn_module`/`assessment` block, dispatches `/nova:edit` to fix missing ones, bounded retry, writes `clean | blocked` verdict that `app-release` consumes. Effectively a dedicated QA skill for a sibling concern; the `-qa` naming would be redundant. |

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
| `app-screenshot-capture` | **inline QA** | Tight Maestro+AVD iteration with bounded smoke-recipe failure handling + per-PNG verification at upload time. Manifest write is verified inline before `verdicts/app-screenshot-capture-shallow.yaml` ships. Extracting QA would force re-dispatch through the AVD agent context. |
| `app-test-cases` | **inline QA** | Tight Nova-MCP iteration. Pre-emit bindings are validated against `mcp__plugin_ace_ace-mobile__mobile_validate_recipe` per generated recipe; failures cause bounded retry against `get_app` to re-resolve form/field IDs. The inline validator runs against the same Nova app the producer just built — separate dispatch loses that context. |
| `training-faq` | **NO QA** | Markdown FAQ document. Consumed by humans (LLOs/FLWs) and by Phase 8 `llo-onboarding` which emails it as a link. No machine consumer regex-parses internal structure. Quality (comprehensiveness, accuracy, scannability) belongs in eval. **Revisit if:** a future skill regex-extracts FAQ entries (e.g. for an OCS prompt-augmentation pipeline). |
| `training-llo-guide` | **NO QA** | LLO-facing operations document. Consumed by human admins and Phase 8 `llo-onboarding` link-emailer. Same rationale as `training-faq`. |
| `training-flw-guide` | **NO QA** | FLW-facing step-by-step guide with embedded screenshots. Producer resolves screenshot fileIds at write time (consumer doesn't); rendered output is a Drive doc humans read. No machine consumer parses internal structure. Same rationale. |
| `training-onboarding-email` | **NO QA** | Email body with Phase-8-substituted personalization tokens. `llo-onboarding` does string substitution (token list is opaque to QA), then sends. No structural QA over the body itself adds value. |
| `training-quick-reference` | **NO QA** | One-page printable pocket card. Consumed by humans. Same rationale. |
| `training-deck-outline` | **inline QA** | Process step 4 self-checks the in-memory draft via `parseDeckOutline()` (the same validator `training-deck-build` uses) before calling `drive_create_file`. Producer is its own structural validator using the consumer's parser — extracting QA would duplicate the parse. |
| `training-deck-build` | **inline QA** | Tight Slides API iteration (`slides_copy_template` + `slides_batch_update`). Render success is verified inline against the produced Slides doc; failures cause bounded retry. Slides API is the external system; producer's loop is the right place. |
| `connect-baseline-screenshots` | not applicable | Cross-opp utility — captures Connect APK screenshots once per Connect version into `ACE/_common/connect-screenshots/<version>/`, not per-opp. Outside the per-opp QA scope (same shape as the Utility section below). Listed here historically; consider moving to Utility on the next registry refresh. |

### Phase 6 — synthetic-data-and-workflows

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `synthetic-narrative-plan` | not yet migrated | **Has-QA candidate, deferred.** Producer writes a manifest YAML consumed by `synthetic-data-generate` → `connect_labs.synthetic_generate_from_manifest`. The MCP atom validates the manifest at the boundary (fail-loud), so QA on the producer side would only add: faster failure (before dispatch) + structured `auto_fix_hint` for orchestrator-driven retry. Building requires authoring a TS Zod schema for the manifest (currently implicit in the Connect-Labs API). Defer until MCP-side rejections become a recurring signal — when they do, ship `synthetic-narrative-plan-qa` with the Zod schema as the QA primitive. |
| `synthetic-data-generate` | **inline QA** | Tight Connect-Labs MCP iteration. Calls `synthetic_generate_from_manifest` which validates the manifest at the boundary; producer surfaces MCP rejections directly. Generated fixture-folder registration is verified inline via `synthetic_register`. No additional QA layer adds value. |
| `synthetic-walkthrough-spec` | not yet migrated | **Has-QA candidate, deferred.** Producer writes per-persona YAML specs consumed by `synthetic-walkthrough-run` → `canopy:walkthrough` (which parses and validates the spec). Same deferral logic as `synthetic-narrative-plan`: canopy validates at the boundary; QA at the producer side would need a TS Zod mirror of canopy's spec schema. Defer until canopy-side rejections recur. |
| `synthetic-walkthrough-run` | **inline QA** | Dispatches `canopy:walkthrough` per persona; canopy reports per-scene scores + render success in the produced HTML deck JSON. Producer verifies the deck was emitted and uploads succeeded inline before appending to `opp.yaml.synthetic.walkthroughs[]`. Tight iteration with canopy's walkthrough loop. |
| `synthetic-summary` | **NO QA** | Pure aggregator — composes a one-page markdown summary from Phase 6 artifacts for stakeholder forwarding. No machine consumer parses internal structure (humans read it; Drive serves it as a link). Fake-QA heuristic: LLM-driven downstream + no code-path branch + eval covers quality (if added later). |
| `synthetic-workflow-seed` | **inline QA** | Tight Connect-Labs MCP iteration. Instantiates SEED templates via `workflow_create_from_template`; wires opp-config via `workflow_update_definition`/`workflow_update_render_code`; verifies result via `workflow_get`. Each step in the producer's loop is a Connect-Labs round-trip with inline verification. |
| `synthetic-workflow-polish` | **inline QA** | Tight Connect-Labs MCP iteration applying surgical render-code edits. Producer calls `workflow_patch_render_code` per polish, verifies via `workflow_get`. Same shape as `-seed` — extracting QA loses the iteration context. |

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
| 2026-05-09 | Added 4th status `inline QA` for producers whose structural checks are correctly placed in the producer's own loop (typically tight iteration with an external system — Nova MCP, CCHQ HTTP, Mobile, OCS configure). Phase 2 Nova builders (`pdd-to-learn-app`, `pdd-to-deliver-app`, `app-deploy`, `app-release`, `app-connect-coverage`) flipped from `not yet migrated` to `inline QA` with pointers to the SKILL.md sections doing the inline work — they were never going to need separate `-qa` skills. Heuristic added to `_qa-template.md § When QA belongs inline`. | ACE team |
| 2026-05-09 | Phase 3 (qa-and-training) classified end-to-end. Five training-doc producers (`training-faq`, `training-llo-guide`, `training-flw-guide`, `training-onboarding-email`, `training-quick-reference`) flipped to `NO QA` per the fake-QA heuristic — consumed by humans + Phase 8 link-emailer, no machine consumer parses them, eval covers the quality concerns. Four producers (`app-screenshot-capture`, `app-test-cases`, `training-deck-outline`, `training-deck-build`) flipped to `inline QA` — tight iteration with external systems (AVD/Maestro, Nova MCP, the deck parser, Slides API). `connect-baseline-screenshots` flipped to `not applicable` (cross-opp utility). Net: third batch in a row that produced zero new `-qa` skills. The heuristics are doing their job. | ACE team |
| 2026-05-09 | Phase 4 (synthetic-data-and-workflows) classified. Four producers flipped to `inline QA` (`synthetic-data-generate`, `synthetic-walkthrough-run`, `synthetic-workflow-seed`, `synthetic-workflow-polish` — all tight Connect-Labs MCP / canopy:walkthrough iteration). One `NO QA` (`synthetic-summary` — pure aggregator for human consumption). Two stayed `not yet migrated` as deferred has-QA candidates (`synthetic-narrative-plan`, `synthetic-walkthrough-spec`) — both produce YAMLs that Connect-Labs / canopy validate at the boundary; building local QA would require TS Zod schemas mirroring those validators. Defer until consumer-side rejections become a recurring signal. | ACE team |
