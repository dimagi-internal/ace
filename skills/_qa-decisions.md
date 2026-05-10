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
| `pdd-to-test-prompts` | **has QA** | `pdd-to-test-prompts-qa` (PR #151). 8 static checks: header + total count, prompt count in range, each prompt has required fields, all 5 adversarial categories present, ≥15% adversarial share, training-gap / product-feedback / escalation prompts. Downstream consumer `ocs-chatbot-qa --deep` regex-iterates each prompt entry's question + expected-answer summary as the opp-specific suite (see `skills/ocs-chatbot-qa/SKILL.md` § Phase 1 input contract); structural correctness of the prompt list gates a real per-prompt parser, even though the `Total prompts: N` header itself is only consumed by this QA's own check #1. |

### Phase 2 — commcare-setup

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `pdd-to-learn-app` | **inline QA** | Inline checks in `skills/pdd-to-learn-app/SKILL.md § Process step 4a` (post-build field-count verification — `get_app` + per-form `get_form`, cross-reference against PDD-expected counts, bounded retry via `/nova:edit`, max 3 iterations, halt with named failures). Connect-marker verification delegated to sibling `app-connect-coverage` skill (Phase 2 Step 1.5). Schema validity is Nova's own `validate_app` — not duplicated here. |
| `pdd-to-deliver-app` | **inline QA** | Inline checks in `skills/pdd-to-deliver-app/SKILL.md § Process steps 4a + 4b`. 4a: same field-count verify-and-retry as Learn. 4b: structural pre-flight asserting `paid_module_count === intended_paid_form_count` (every paid form lives in its own module — works around Nova's per-module slug reuse that would silently collapse multi-form modules into one Connect deliver_unit). Bounded retry via `/nova:edit`, max 3 iterations. Connect markers delegated to `app-connect-coverage`. |
| `app-deploy` | **inline QA** | Inline checks in `skills/app-deploy/SKILL.md`. § Step 2 — domain match (Nova's bound HQ project space === `ACE_HQ_DOMAIN`). § Step 2.5 — XML-escape lint walking every form, catches `<`/`>`/`&` in field labels that Nova's `validate_app` says ok but CCHQ build rejects. § Steps 3–4 — build-status check on each upload. Class-level preventer per `docs/issues/nova-validate-app-misses-xml-escapes.md`. |
| `app-release` | **inline QA** | Inline checks in `skills/app-release/SKILL.md`. § Step 3 — Connect-coverage pre-flight gate consuming `app-connect-coverage` verdict. § Step 5 — released-state verification via CCHQ read-only API. § Step 6 — CCZ verification: `commcare_download_ccz` projection MUST have `collision_count: 0` (no slug collisions Connect would silently dedup) AND per-type record counts > 0 (Connect markers present in CCZ). On any fail, halt with `[BLOCKER]` naming each colliding slug + kept/dropped forms. Replaces what would have been most of `app-release-qa`. |
| `app-multimedia-coverage` | **inline QA** | Manual gate (not part of `/ace:run`). Tight Nova + CCHQ iteration: schema for media on field → asset generation → form-XML reference → CCZ bundling → release verification. Same surgical-patch shape as `commcare-form-patch`. Producer's loop is the right place. |
| `commcare-form-patch` | **inline QA** | Workaround skill — patches CCHQ form XML directly when Nova's `compile_app` emits Connect-rejecting render shapes, then re-builds + re-releases. Tight CCHQ-HTTP iteration; producer verifies the re-released CCZ is Connect-compatible inline. (Skill is explicitly TEMPORARY — when Nova fixes its render shape upstream, this skill retires entirely.) |
| `app-connect-coverage` | **inline QA** | This skill IS the verify-and-fix QA for Connect-marker coverage on Nova-built apps. Inline loop in `skills/app-connect-coverage/SKILL.md` checks every form for required `connect.deliver_unit`/`learn_module`/`assessment` block, dispatches `/nova:edit` to fix missing ones, bounded retry, writes `clean | blocked` verdict that `app-release` consumes. Effectively a dedicated QA skill for a sibling concern; the `-qa` naming would be redundant. |

### Phase 3 — connect-setup

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `connect-program-setup` | **NO QA** | Connect MCP atom (`connect_create_program`) validates name + organization + archetype at boundary. Producer dispatches and surfaces failures; nothing to revalidate ACE-side. *Eval* candidate exists (`connect-program-setup-eval` already ships) for "is this program-shape sensible for the PDD" — that's a quality judgment, not structural. |
| `connect-opp-setup` | **NO QA** | Connect MCP atoms each validate at boundary (`connect_create_opportunity`, `connect_set_verification_flags`, `connect_create_payment_units`). Producer dispatches and surfaces failures; ACE-side QA would duplicate. **Eval candidate exists** (`_eval-decisions.md` — "is the configuration sensible for the PDD's archetype") which is the right home for the substantive concerns. |

### Phase 4 — ocs-setup

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `ocs-agent-setup` | **NO QA** | OCS MCP atoms each validate at boundary (`ocs_clone_chatbot`, `ocs_create_collection`, `ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`, `ocs_publish_chatbot_version`). Producer dispatches each and surfaces failures. The configured bot's quality is graded by the runtime QA pair (`ocs-chatbot-qa` + `ocs-chatbot-eval`) — separate concern, correctly split. ACE-side configuration QA would duplicate the OCS boundary. |
| `ocs-chatbot-qa` (runtime) | **has QA** | Reference example for runtime-exercise QA pattern. Pairs with `ocs-chatbot-eval`. The "producer" here is the deployed chatbot (runtime artifact), not a Drive document — `ocs-chatbot-qa` exercises it via probes and writes a transcript. See `_qa-template.md § When QA work requires runtime`. |

### Phase 5 — qa-and-training

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `app-screenshot-capture` | **inline QA** | Tight Maestro+AVD iteration with bounded smoke-recipe failure handling + per-PNG verification at upload time. Manifest write is verified inline before `verdicts/app-screenshot-capture-shallow.yaml` ships. Extracting QA would force re-dispatch through the AVD agent context. |
| `app-test-cases` | **NO QA** | Mobile MCP atom `mobile_validate_recipe` validates each generated recipe at boundary. Producer dispatches the validator per recipe and acts on its verdict (re-resolve form/field IDs from Nova on failure). The producer's iteration loop wraps the MCP validator — the validation IS the MCP, ACE doesn't add structural QA on top. If `mobile_validate_recipe` doesn't catch a class of bad recipes, that's an MCP improvement, not an ACE-side QA addition. |
| `training-faq` | **NO QA** | Markdown FAQ document. Consumed by humans (LLOs/FLWs) and by Phase 8 `llo-onboarding` which emails it as a link. No machine consumer regex-parses internal structure. Quality (comprehensiveness, accuracy, scannability) belongs in eval. **Revisit if:** a future skill regex-extracts FAQ entries (e.g. for an OCS prompt-augmentation pipeline). |
| `training-llo-guide` | **NO QA** | LLO-facing operations document. Consumed by human admins and Phase 8 `llo-onboarding` link-emailer. Same rationale as `training-faq`. |
| `training-flw-guide` | **NO QA** | FLW-facing step-by-step guide with embedded screenshots. Producer resolves screenshot fileIds at write time (consumer doesn't); rendered output is a Drive doc humans read. No machine consumer parses internal structure. Same rationale. |
| `training-onboarding-email` | **NO QA** | Email body with Phase-8-substituted personalization tokens. `llo-onboarding` does string substitution (token list is opaque to QA), then sends. No structural QA over the body itself adds value. |
| `training-quick-reference` | **NO QA** | One-page printable pocket card. Consumed by humans. Same rationale. |
| `training-deck-outline` | **inline QA** | Process step 4 self-checks the in-memory draft inline before `drive_create_file`: single `# Title` heading, ≥4 `## Slide:` headings, every image ref is `drive:<fileId>` or `https://...`, every speaker-notes block non-empty. Downstream consumer `training-deck-build` re-parses the same file via `parseDeckOutline` (`lib/training-deck-spec.ts`) at its Step 2; producer's inline check approximates the consumer's structural contract — extracting a separate `-qa` skill would duplicate Step 4's checks for no additional coverage. |
| `training-deck-build` | **inline QA** | Tight Slides API iteration (`slides_copy_template` + `slides_batch_update`). Render success is verified inline against the produced Slides doc; failures cause bounded retry. Slides API is the external system; producer's loop is the right place. |
| `connect-baseline-screenshots` | not applicable | Cross-opp utility — captures Connect APK screenshots once per Connect version into `ACE/_common/connect-screenshots/<version>/`, not per-opp. Outside the per-opp QA scope (same shape as the Utility section below). Listed here historically; consider moving to Utility on the next registry refresh. |

### Phase 6 — synthetic-data-and-workflows

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `synthetic-narrative-plan` | **has QA** | `synthetic-narrative-plan-qa`. 8 static checks via Zod schema (`ManifestZ`): YAML parse, required top-level keys, FLW personas well-formed (archetype enum, name, optional id/display_name), KPI field-paths resolvable against deliver-app summary (graceful skip if absent), anomalies traceable (detection_path + flw_id + week), coaching_arcs match personas, random_seed present, timeline dates consistent. The Zod schema mirrors the Connect-Labs MCP boundary — failures provide structured `auto_fix_hint` for orchestrator-driven retry before the MCP dispatch. |
| `synthetic-data-generate` | **NO QA** | Connect-Labs MCP atom `synthetic_generate_from_manifest` validates the manifest at boundary. Generated fixture-folder registration via `synthetic_register` is also MCP-validated. Producer dispatches and surfaces failures; ACE-side QA would duplicate. |
| `synthetic-walkthrough-spec` | **has QA** | `synthetic-walkthrough-spec-qa`. 7 static checks via Zod schema (`SpecZ`): YAML parse, required top-level keys, scenes array well-formed (≥4 scenes), scene personas resolvable, AI-quality assertions falsifiable, persona pain-points documented (intro non-empty per canopy contract), scene titles unique (canopy derives screenshot filenames from titles). Per-persona QA result at `synthetic-walkthrough-spec_<persona>-qa_result.yaml`. Schema mirrors canopy:walkthrough's spec contract. |
| `synthetic-walkthrough-run` | **NO QA** | `canopy:walkthrough` skill validates spec inputs and produces graded output (per-scene scores via `canopy:visual-judge`). Producer dispatches canopy and surfaces failures; the canopy boundary is the QA. Drive uploads of the rendered HTML deck are MCP-validated. |
| `synthetic-summary` | **NO QA** | Pure aggregator — composes a one-page markdown summary from Phase 6 artifacts for stakeholder forwarding. No machine consumer parses internal structure (humans read it; Drive serves it as a link). Fake-QA heuristic: LLM-driven downstream + no code-path branch + eval covers quality (if added later). |
| `synthetic-workflow-seed` | **NO QA** | Connect-Labs MCP atoms each validate at boundary (`workflow_create_from_template`, `workflow_update_definition`, `workflow_update_render_code`, `workflow_get`). Producer dispatches and surfaces failures; ACE-side QA would duplicate the MCP boundary. |
| `synthetic-workflow-polish` | **NO QA** | Same shape as `-seed`. Connect-Labs MCP `workflow_patch_render_code` + `workflow_get` validate at boundary. NO QA needed ACE-side. |

### Phase 7 — solicitation-management

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `solicitation-create` | **NO QA** | Connect-Labs MCP `create_solicitation` validates payload at boundary. Producer dispatches; ACE-side QA would duplicate. *Eval* exists (`solicitation-create-eval`) for quality dimensions (scope clarity, criteria measurability) — that's the right home. |
| `solicitation-monitor` | **NO QA** | Process / state-tracking skill. Polls Connect-Labs `list_responses` (MCP-validated read) and writes per-response markdown files (Drive-MCP-validated write). No structural artifact ACE produces — just relayed external state. |
| `solicitation-review` | **has QA** | `solicitation-review-qa`. 8 static checks: recommendation section present, awardee named (response_id or org_slug), awardee reasoning substantive (≥3 sentences + criterion reference), all responses scored (graceful skip if response files absent), criteria-coverage table populated, scoring table well-formed (response_id/score/rationale columns), tie-break resolved when top-two gap <0.5, **`no_award_action_yet`** (load-bearing — QA must run BEFORE `award_response` is called by the HITL gate). Companion `solicitation-review-eval` already grades quality. |

### Phase 8 — execution-management

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `llo-onboarding` | **NO QA** | Process skill. Entry guard (`selected_llo.org_slug` non-null) is a precondition, not QA. Sends Connect invite (`connect_send_llo_invite` — MCP-validated) + onboarding email (email-communicator MCP). No structural artifact produced; outcomes are external state changes the MCPs validate. *Eval candidate exists per `_eval-decisions.md`*. |
| `llo-launch` | **has eval, NO QA** | Process skill. Reads UAT results + deep-QA verdicts inline (consumes upstream artifacts; doesn't produce a structural one). Activates opp via `connect_activate_opportunity` (MCP-validated). Notifies LLOs via email. The QA-shaped concerns ("are UAT verdicts fresh," "is deep-QA recent enough") are pre-conditions captured by the producer's halt logic, not QA grading. Quality is graded by `llo-launch-eval` (already exists). |
| `llo-invite` | **NO QA** | Process skill — email send loop over PDD's `preferred_llos`. Email-communicator MCP validates each send. No artifact produced. |
| `llo-uat` | **NO QA** | Process / coordination skill. Compiles `llo-uat_results.md` from collected LLO responses. Format is loose enough that `llo-launch` reads it as LLM context rather than parsing structurally. *Eval candidate per `_eval-decisions.md` for UAT coverage completeness*. |
| `flw-data-review` | **NO QA** | Recurring; analyzes FLW submissions via Connect data API (MCP-validated reads). Output is analysis recommendations the LLO acts on — eval-shaped (already has `flw-data-review-eval`), not QA-shaped. |
| `timeline-monitor` | **NO QA** | Recurring poll. State-tracking against PDD milestones via Connect MCP. No artifact produced ACE-side. |

### Phase 9 — closeout

| Producer | QA status | QA skill / rationale |
|---|---|---|
| `opp-closeout` | **NO QA** | Process skill. Pulls invoices via Connect MCP (`connect_list_invoices`, `connect_get_invoice` — MCP-validated reads), creates Jira ticket via Jira MCP (MCP-validated). Closeout summary is human-read narrative, not structurally consumed. |
| `llo-feedback` | **NO QA** | Process skill — surveys LLO via email, collects responses. The collected feedback IS the quality signal (humans read it during closeout review); no ACE-side QA layer adds value. |
| `learnings-summary` | **NO QA** | LLM-authored synthesis document. Reads all opp artifacts, drafts a markdown summary, optionally seeds a new PDD for the next cycle. Consumed by humans (closeout review) and optionally by the next cycle's `idea-to-pdd` (which itself is LLM-driven and reads as prose context). Fake-QA heuristic applies. |
| `cycle-grade` | **NO QA** | Final cycle grade and recommendations document. Consumed by humans for the closeout review. The grade itself is the artifact's quality signal — extracting structural QA over the grade's format adds nothing. The companion `cycle-grade-eval` does the soft-score calibration on the grading consistency. |

### Eval-self-QA (cross-cutting)

The cross-cutting `verdict-yaml-qa` skill structurally checks any `<producer>-eval_verdict.yaml` written by any `-eval` skill. 7 static checks: YAML parses, schema validates against `lib/verdict-schema.ts § VerdictSchema`, dimension weights sum to 1.0, `overall_score` ≈ weighted mean (with `overall_score_pre_cap` honored when an inflation cap was applied), verdict tier matches score range, `live_state_verified: false` caps at `partial` / 8.5, gate disposition consistent with score-vs-threshold.

Single shared helper covers all 27 `-eval` skills' verdicts — adding a new `-eval` skill picks up coverage automatically. No per-eval QA skills needed.

| Verdict producer | Verdict path | Eval-self-QA status |
|---|---|---|
| All `-eval` skills | `<phase>/<producer>-eval_verdict.yaml` | **covered by `verdict-yaml-qa`** (7 static checks; see `skills/verdict-yaml-qa/SKILL.md`) |

Dispatched at two natural points: inline self-check by each `-eval` skill after writing its verdict (catches malformations before propagating), or as a pre-aggregation gate in `opp-eval` (verdicts that fail QA are flagged in the rollup but not aggregated). The shared-helper shape supports both — the SKILL is a single dispatch surface, not a per-eval skill.

### Utility / cross-cutting (no per-opp artifact)

| Producer | QA status | Rationale |
|---|---|---|
| `email-communicator` | not applicable | Utility skill — sends mail; no Drive artifact. |
| `decisions-render` | not applicable | Utility skill — renders `decisions.yaml` to HTML. Already has unit tests on the renderer; no per-opp artifact under QA scope. |
| `upload-transcript` | not applicable | Utility — ingests JSONL transcripts. |
| `eval-calibration` | not applicable | Meta-skill — calibrates other evals' rubrics. Not a producer of a per-opp artifact. |
| `verdict-yaml-qa` | not applicable | Cross-cutting QA skill — structurally checks any `-eval` verdict YAML. Not a producer of a per-opp artifact. See `### Eval-self-QA (cross-cutting)` above for the contract. |

## MCP-improvement candidates surfaced by the audit

The 10 producers classified as `inline QA` are filling **real gaps** in MCP-boundary validation. Each represents an upstream MCP improvement we'd prefer over the current ACE-side patch. Surfacing here so future MCP work has a list:

| MCP gap | Affected producer(s) | Currently filled by | Upstream fix |
|---|---|---|---|
| Nova `validate_app` doesn't check CommCare Connect markers (`<learn:deliver>`, `<learn:module>`, `<learn:assessment>`) | `pdd-to-learn-app`, `pdd-to-deliver-app`, `app-connect-coverage` | Inline marker checks per form post-build; verify-and-fix loop via `/nova:edit` | Add Connect-aware validation to Nova when `Connect type` is `learn`/`deliver`. Tracked in `docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 1. |
| Nova `add_fields` partial-persistence — silently drops fields beyond the first | `pdd-to-learn-app`, `pdd-to-deliver-app` | Inline field-count verify-and-retry, max 3 iterations | Make `add_fields` atomic over the input array. `docs/learnings/2026-04-29-nova-connect-marker-bugs.md` § Bug 3. |
| Nova `compile_app` reuses module slug as `<learn:deliver id>` per form, causing Connect-side dedup → silent multi-form-module collapse | `pdd-to-deliver-app` (Step 4b one-form-per-module check), `app-release` (collision_count projection) | Inline module/form-count assertion + per-form-per-module enforcement | Make Nova's `compile_app` slug `<learn:deliver id>` per-form. Memory: `feedback_connect_deliver_unit_per_module`. |
| Nova `validate_app` doesn't reject XML-unescape characters (`<`, `>`, `&`) in field labels | `app-deploy` Step 2.5 XML-escape lint | Inline regex walk over every form's labels; auto-escape via `edit_field` | Make Nova auto-escape on `add_field`/`edit_field` OR have `validate_app` reject. `docs/issues/nova-validate-app-misses-xml-escapes.md`. |
| CCHQ build accepts apps Connect can't sync — no Connect-compatibility validation at build time | `app-release` Step 6 CCZ projection check | Inline `commcare_download_ccz` projection (`projected_connect_state.collision_count`, per-type record counts > 0) | CCHQ adds Connect-aware validation to the build endpoint. Cross-system; would need coordination with the Connect team. |
| Nova render-shape outputs CCHQ form XML that Connect's `/opportunity/init/` rejects with HTTP 500 | `commcare-form-patch` (TEMPORARY workaround skill) | Patches form XML directly, re-builds, re-releases | Fix the Nova render shapes upstream. When done, this entire skill retires. |
| Slides API render success isn't always machine-detectable (e.g., partial render with no error) | `training-deck-build` | Inline post-render `slides_get` verification of slide count | Slides API itself is third-party (Google); workaround stays. |

When a row above ships its upstream fix, the corresponding ACE-side `inline QA` flips to `NO QA` (covered by the now-improved MCP/external system). Re-audit cadence: when any of these upstream fixes lands, walk back through the affected producers and update their registry rows.

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
| 2026-05-09 | **Registry complete.** All remaining producers classified: Phase 2 leftovers (`app-multimedia-coverage`, `commcare-form-patch` → `inline QA`), Phase 3 connect-setup (`connect-program-setup`, `connect-opp-setup` → `inline QA`), Phase 4 ocs-setup (`ocs-agent-setup` → `inline QA`), Phase 7 solicitation (`solicitation-create`, `solicitation-monitor` → `inline QA`; `solicitation-review` deferred has-QA candidate — Phase 7→8 HITL gate is the current safety net), Phase 8 execution (`llo-onboarding`, `llo-launch`, `llo-invite`, `llo-uat`, `flw-data-review`, `timeline-monitor` → `inline QA`), Phase 9 closeout (`opp-closeout`, `llo-feedback` → `inline QA`; `learnings-summary`, `cycle-grade` → `NO QA` — LLM-authored synthesis docs for humans). Final tally across all 47 producers: **3 has QA, 24 inline QA, 12 NO QA, 4 not applicable, 4 not yet migrated (all explicit deferred has-QA candidates with stated revisit conditions).** No producer left ambiguously classified; missing-from-table is now a true contract violation. | ACE team |
| 2026-05-09 | **Re-audit applying MCP-boundary heuristic.** Earlier classifications were too quick to call producers `inline QA` when they were actually (a) process skills with no structural artifact or (b) just dispatching MCP atoms whose own boundary validation already covers the structural concerns. New heuristic codified at `_qa-template.md § Don't duplicate MCP-boundary QA`: if an MCP validates at its boundary, ACE-side QA shouldn't duplicate; if the MCP is missing a check, improve the MCP. **17 producers flipped from `inline QA` to `NO QA`** under the tighter heuristic — connect-program-setup, connect-opp-setup, ocs-agent-setup, app-test-cases, synthetic-data-generate, synthetic-walkthrough-run, synthetic-workflow-seed/polish, solicitation-create/monitor, all 6 Phase 8 execution skills, opp-closeout, llo-feedback. Producers that **stay** `inline QA` (10 total) are exactly those filling a real MCP gap: Phase 2 Nova builders + helpers (Nova doesn't catch Connect markers, XML escapes, field-count drops, slug collisions), `app-screenshot-capture` (Maestro coordination), `training-deck-outline`/`-build` (parser self-check + Slides render). Final tally now: **3 has QA, 10 inline QA, 27 NO QA, 4 not applicable, 3 not yet migrated.** | ACE team |
| 2026-05-09 | **Initial-build registry completion.** All 3 deferred has-QA candidates shipped: `synthetic-narrative-plan-qa` (Zod manifest schema, 8 checks), `synthetic-walkthrough-spec-qa` (Zod canopy-spec mirror, 7 checks, per-persona), `solicitation-review-qa` (8 checks including the load-bearing `no_award_action_yet` safety check). Each has importable `checks.ts` + vitest unit tests in `test/skills/<skill>/`. The deferral conditions ("wait until consumer-side rejections become a recurring signal") were overridden by user direction to complete the initial registry buildout before the next audit-lens run; the QAs ship at provisional calibration with their Zod schemas approximating the consumer boundary. Final tally: **6 has QA, 10 inline QA, 27 NO QA, 4 not applicable, 0 not yet migrated.** | ACE team |
| 2026-05-09 | **Eval-self-QA cross-cutting helper shipped.** `verdict-yaml-qa` closes the deferred eval-self-QA workstream from the migration spec's Phase 7. 7 static checks (`yaml_parses`, `schema_validates` calling `VerdictSchema`, `dimension_weights_sum_to_one`, `overall_score_consistent_with_dimensions`, `verdict_tier_matches_score`, `live_state_verified_consistency`, `gate_disposition_consistent`) covering every cross-field invariant the Zod schema can't express. 40 vitest unit tests. Single shared helper covers all 27 `-eval` skills' verdict YAMLs — added the `### Eval-self-QA (cross-cutting)` section above to track coverage; no individual rows per eval. Final tally: **6 has QA + 1 cross-cutting QA helper (`verdict-yaml-qa` covers 27 evals' verdicts), 10 inline QA, 27 NO QA, 5 not applicable (added `verdict-yaml-qa` itself; it's not a per-opp producer), 0 not yet migrated.** | ACE team |
