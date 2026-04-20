## 2026-04-19 — qa-eval-iteration-loop (custom lens)

**Lens used:** "iterate on cosmetics-fgd-pilot end-to-end, fix gaps as they surface, minimal check-ins with clear choices." Custom session-scoped lens motivated by Neal's lead-exposure portfolio push — specifically the Cosmetics FGD Guide as the first real-content focus-group opp. Scoped away from Nova / CommCare app creation (another team owns that); focus on ACE's own skill chain and the new qa/eval + opp-eval infrastructure.

**Background read:** `CLAUDE.md`, `skills/README.md`, `agents/ace-orchestrator.md`, `agents/{ocs-setup,ocs-tester,llo-manager,design-review}.md`, `skills/{idea-to-pdd,pdd-to-test-prompts,pdd-to-learn-app,pdd-to-deliver-app,ocs-chatbot-qa,ocs-agent-setup,connect-opp-setup,llo-invite,cycle-grade}/SKILL.md`, `lib/artifact-manifest.ts`, `commands/{run,step,status}.md`, `templates/pdd-template.md`, `test/fixtures/artifact-manifest.test.ts`, and prior PM runs `2026-04-08` (focus-group framework), `2026-04-15`, `2026-04-16`, `2026-04-17`. Mid-cycle: Neal's "Going big on lead exposure with Connect" Google Doc (cosmetics + geophagy FGD guides, portfolio framing for the 6 lead-exposure programs).

**Core finding:** ACE's infrastructure for archetype-varying opps and umbrella evaluation was mostly designed but **never end-to-end validated against real content**. This cycle exercised the chain against Neal's cosmetics FGD guide and found the gaps are at the seams: contract drift between skills, silent failure modes in external integrations (OCS), and bypass paths the spec didn't defend. Six shipped PRs worth of surgical fixes now make the qa/eval + opp-eval + archetype-branching story fully coherent. Zero net-new capabilities (fgd-synthesis intentionally deferred per user); all work was existing-surface hardening driven by real diagnostics.

### Do it

1. **qa/eval split refactor — `ocs-chatbot-qa` → qa (capture) + `ocs-chatbot-eval` (judge)** — Effort: M — Status: **done, shipped 0.3.5**
   - PR: jjackson/ace#31
   - Outcome: Split `ocs-chatbot-qa` into two skills per the two-phase pattern. qa captures a transcript + runs structural checks (response received, citations present, no errors); eval reads the transcript and runs the LLM-as-Judge rubric. New `skills/README.md § QA vs Eval — the two-phase pattern` codifies the contract: `qa-captures/` for evidence, `verdicts/<skill>-<mode>.yaml` for machine verdicts, `eval-reports/` for human reports. Uniform verdict YAML shape so the future umbrella aggregator can consume any skill's verdict. 23 files touched; gate brief renamed `ocs-chatbot-qa-deep.md` → `ocs-chatbot-eval-deep.md` (gate is on judgment, not capture). State-key split: `ocs-chatbot-qa-{quick,deep,monitor}` + `ocs-chatbot-eval-{quick,deep,monitor}`.

2. **`ace:opp-eval` umbrella aggregator skill** — Effort: M-L — Status: **done, shipped 0.4.0**
   - PR: jjackson/ace#32 (dispatched to subagent; 490-second solo run, 14-step Process, renormalized weights, fault-tolerant YAML parsing)
   - Outcome: New `opp-eval` skill + `/ace:eval` command. Three modes (`--quick` structural, `--deep` aggregation + recommendations, `--monitor` deep + trend). Reads every `verdicts/*.yaml` in the opp folder, groups by 6 skill-category dimensions (design/commcare/connect/ocs/operate/closeout), computes weighted overall with weights renormalized across non-null categories (so a partial opp isn't penalized for being early). Emits per-skill recommendations and a uniform-contract advisory gate brief (does not gate a phase). Archetype-agnostic by design — per-skill evals already applied archetype-specific rubrics. 7 new manifest entries. Answers the user's original ask for "one overview judge/review agent that we can apply to overall runs."

3. **Iter 1: `pdd-to-test-prompts` archetype branching** — Effort: S — Status: **done, shipped 0.4.1**
   - PR: jjackson/ace#33
   - Outcome: Added `## Archetypes` section with per-archetype category lists. `focus-group` gets session-flow / recruitment-and-venue / consent-and-recording / question-guide-sequencing / facilitation-technique / output-spec / audio-and-evidence; `atomic-visit` retains visit-flow / eligibility / GPS / duplicate-handling; `multi-stage` mixes per-stage + adds stage-gate-transition. Surfaced during Iter 0 (cosmetics FGD Phase 1 recon) — subagent running the skill had to manually remap every atomic-visit-worded category. A weaker LLM would miss it and produce atomic-visit prompts against an FGD PDD, cascading into `ocs-chatbot-eval --deep` false-positive failures. Archetype-aware skill count 7 → 8.

4. **Iter 3: `llo-invite` archetype branching** — Effort: S — Status: **done, shipped 0.4.2**
   - PR: jjackson/ace#34
   - Outcome: `focus-group` selection criteria emphasize qualitative research experience (or training willingness), language/cultural fit for sensitive topics, audio-recording capability, facilitator time budgeting, and a **small-N bias** (1–2 LLOs, not 3–5). Gate brief gains FGD-specific WARN: count > 2 without justification, or rationale silent on facilitation capability. Archetype-aware skill count 8 → 9. Field-level enforcement (gate brief WARNs) ensures the shift lands even under weaker dispatches.

5. **Iter 7: Contract cleanup + orchestrator hardening** — Effort: M — Status: **done, shipped 0.4.3**
   - PR: jjackson/ace#35
   - Outcome: Six contract fixes + one orchestrator hardening. (1) `per_item:` canonical for per-item verdict list; `per_prompt:` in ocs-chatbot-eval renamed, with `prompt:` kept as domain-specific subkey inside each entry. (2) `auto_surfaced:` promoted to optional top-level verdict field so opp-eval can aggregate across skills. (3) `ACE/golden-template/` documented as canonical no-opp fallback path root (both qa and eval). (4) `ocs_send_test_message` MCP tool flagged as structurally incomplete — returns only `response`, missing `cited_files`/`tags`/`session_id`/`elapsed_ms` — raw widget HTTP is load-bearing. (5) OCS env vars pinned to `$CLAUDE_PLUGIN_DATA/.env`. (6) opp-eval quick-mode template adds `Unexpected:` row, tightens Notes examples, specifies stdout format. Orchestrator: state.yaml schema example upgraded from abstract to concrete (all 6 phases, qa/eval split step keys, `ocs-chatbot-eval-deep` gate); new `Defensive state.yaml init on bypass paths` section; `/ace:step` step 4 now ensures state.yaml before updating last_actor. The last one closes the bug I hit myself in cosmetics-fgd-pilot setup (direct `ace:design-review` Agent-tool dispatch bypassed `/ace:run` and the opp never got a state file).

6. **Iter 6: Golden template fix + bootstrap defense** — Effort: M — Status: **done, shipped 0.4.4**
   - PR: jjackson/ace#36 (dispatched to subagent after rate-limit retry; live OCS state change + code fix)
   - Outcome: Diagnosed + fixed a silent-publish-block bug on the deployed golden template (experiment 11792). Root cause: `OCS_SHARED_COLLECTION_ID=718` pointed at a collection that didn't exist on team `connect-ace`. `ocs_attach_knowledge` silently succeeded at the pipeline-patch layer but then blocked every `publishChatbotVersion` call with the opaque UI message "Unable to create a new version when the pipeline has errors." v1 (empty post-clone state) stayed as the default version; embedded widget served vanilla LLM. Bot suggested DoorDash/Route4Me for "flagged deliveries." Live fix: restored canonical system prompt (PDD not IDD, `ace@dimagi-ai.com`, emoji-discouraged guidance), removed phantom collection 718, republished to v2. Code fix: `scripts/bootstrap-ocs-golden-template.ts` now pre-flight validates the collection exists on the team (via a new `listCollectionIndexIds` helper that scrapes the edit page — OCS has no REST endpoint) and skips gracefully with a loud actionable warning if missing. **Template score: 3.84/10 FAIL → 8.2/10 PASS.**

### Backlog

Prioritized; most items are direct follow-ups from Iter 6's root cause.

**P1 — OCS robustness (next cycle):**
- **Add `ocs_list_collections` MCP tool.** bootstrap-ocs-golden-template.ts had to scrape the chatbot edit page because OCS exposes no REST endpoint for collections. Small wrapper; unblocks future defensive checks in other scripts / skills.
- **`publishChatbotVersion` pre-flight validation in `mcp/ocs/backends/playwright.ts`.** Post the current graph through `/pipelines/data/` first and surface any `errors.node` entries as a `PipelineValidationError` before attempting version creation. The silent-publish-block that bricked the golden template for weeks was hidden by exactly this gap.
- **`ocs-agent-setup` SKILL pre-flight check on `OCS_SHARED_COLLECTION_ID`.** Every per-opp bot the skill clones hits the same silent-block risk if the env var is stale — same class of bug, new blast radius.

**P2 — Archetype coverage audit (next cycle):**
- Audit `connect-program-setup`, `training-materials`, `llo-onboarding`, `llo-uat`, `llo-launch`, `llo-feedback`, `app-test`, `flw-data-review` for silent atomic-visit defaults. Iter 3 (connect-opp-setup) was already solid; Iter 1 + Iter 3 took archetype-aware count 7 → 9. The remaining gap is 7 more skills that may or may not need branching.

**P3 — Rubric proliferation (following cycles):**
- Add `## LLM-as-Judge Rubric` sections to skills that lack them. opp-eval emits `[INFO] skill X lacks a rubric` for every skill without one — the forcing function the 0.4.0 work surfaced. Highest-signal first: `app-test`, `flw-data-review`, `cycle-grade` (already has dimensions but not the rubric format).

**P4 — Dogfood: real Phase 4 on cosmetics-fgd-pilot:**
- Now that the golden template is fixed, run `ocs-setup` end-to-end on cosmetics-fgd-pilot. Clone, configure, qa/eval. First real-opp exercise of the full 0.3.5+0.4.x stack.

**P5 — External team-infrastructure (not ACE code):**
- Create a Connect shared knowledge collection on team `connect-ace`, record its id as `OCS_SHARED_COLLECTION_ID`, also set `OCS_LLM_PROVIDER_ID` + `OCS_EMBEDDING_MODEL_ID`. Until this happens, every bot clone inherits zero citations. Documented in ocs-agent-setup + ocs-chatbot-qa but can't be enforced until the collection exists.

**P6 — Net-new capability (a cycle of its own):**
- **`fgd-synthesis` skill** — the "shareable-with-LEEP" narrative report Neal explicitly wants for FGD opps. Composes across N session transcripts + notes + audio: themes, representative quotes, decision-driver map, receptivity read. Biggest net-new gap and the actual deliverable of an FGD program. Deferred this cycle per user request ("improve core ACE first"). Priority should flip as soon as core is stable — without synthesis, FGD opps have no publishable output.

### Closed

(none from this run)

### Skipped on this run (raised but not formally proposed)

- **Iter 2: Nova brief quality** — checked `pdd-to-learn-app` + `pdd-to-deliver-app` for FGD archetype branches; both already solid (facilitation craft, session-documentation form). Per user's explicit guidance ("don't focus on Nova / CommCare app creation, another team owns that"), validated-and-moved-on rather than iterating.
- **state.yaml init for cosmetics-fgd-pilot specifically** — orchestrator hardening (Iter 7) now makes `/ace:step` robust to missing state.yaml, but the cosmetics-fgd-pilot Drive folder itself still lacks a state.yaml because I bypassed `/ace:run` at setup. Easy to init manually or by running `/ace:step idea-to-pdd cosmetics-fgd-pilot` once (which will now initialize defensively). Not worth a formal proposal — one-shot operational fix.
- **`generate_citations: false` on golden template** — the Iter 6 subagent considered setting this since there's currently nothing to cite on team `connect-ace`, but rejected it: per-opp bots will attach an opp-specific collection and want citations on by default. Same file, leave as-is.
- **Context refresh (`.claude/pm/context.md`)** — the "Tech Stack" line still said "5 agents, 19 skills, 4 commands" (now 8/24/10). Fixed the counts; larger refresh of the "Current State" paragraph (which references old PR #3 / stress-test observations) deferred — it's a context-hygiene cycle of its own, not a code-lens concern.

### Meta-observations

**What worked well:**

- **Dispatching subagents for mechanical sub-work while keeping judgment in the main thread** paid off twice. (1) The 0.4.0 opp-eval skill was a 490-second solo subagent run against a detailed spec — produced a 380-line SKILL.md, fixture stubs, manifest entries, new command, and a clean PR. (2) Two parallel diagnostic dispatches (Iter 4 + Iter 5) compressed what would have been serial cycles; each came back with a ~400-word report and no main-thread context pollution. Rule: **delegate mechanical scope, keep design decisions in the main thread, brief the subagent like it's never seen the session.**
- **Running the pipeline against real content surfaces gaps that spec reviews miss.** The 2026-04-08 focus-group framework was designed carefully and shipped with medium-high confidence but *"real validation requires running the skills against the fixture in a Claude session, which I can't do from the implementing session"*. The first real run (cosmetics FGD Phase 1 recon) found the category-naming drift that shipped as Iter 1. Same for the qa/eval split: the first real run against the golden template found the `per_item` / `per_prompt` naming drift + the no-opp fallback gap + the MCP tool schema gap — none of which showed up in the 0.3.5 design phase.
- **Atomic PRs per fix kept the session manageable.** Four separate PRs (#33–#36) with clear scope each. Tests green between every PR. Zero cross-PR conflict. Each shipped as its own installable version (0.4.1 → 0.4.4) so the progression is replayable later.
- **Persistent backlog in Drive (plus in-repo CHANGELOG) during the session** served as a working-memory bridge between iterations. The Drive backlog surfaced each time I picked the next fix; the CHANGELOG entries captured durable rationale. The run log (this file) consolidates.
- **`drive_create_file` default to Google Doc conversion was transparent** — idea.md uploaded as a Doc rather than markdown, but `drive_read_file` exported it cleanly, so idea-to-pdd didn't choke. My initial concern didn't materialize. Worth noting as a positive signal: the MCP tool handles both cases.

**What was wasteful:**

- **MCP parameter-name confusion burned ~15 minutes** up front. Used `parentId` (wrong) then got the correct `parentFolderId` from the ToolSearch schema only after the user called out the Drive-quota error was a bogus red herring. The "Drive quota exceeded" error was a misleading symptom of the wrong-param (folder created in SA's own Drive root, not the shared drive). Rule for next time: **when an MCP tool errors on what looks like auth/quota, first verify schema via ToolSearch — the call may be hitting a different code path than intended.**
- **Dispatched the Iter 6 subagent and hit a rate limit mid-diagnosis.** 7 tool calls in, then `"You've hit your limit · resets 9am (America/Denver)"`. Unknown whether it made partial changes to the live template. Retry after reset (a few hours later) worked; found no user-facing drift from the prior attempt. But the blind-retry approach means any partial mutation could have caused confusion. Rule: **when dispatching subagents that modify production state, emit a checkpoint after each mutation so a retry has an auditable stopping point.** Candidate for canopy-skills.
- **Iteration log + backlog files in Drive got written once, then not updated.** Drift. The repo CHANGELOG was the real source of truth. **For a future iteration loop, either auto-update the Drive file each cycle or skip it entirely and rely on CHANGELOG + this run log.** Recommend the latter — fewer surfaces to keep in sync.

**Prompt adjustments for next time:**

- **Flag context.md as needing refresh when skill/command/agent counts drift.** `context.md` line 18 said "5 agents, 19 skills, 4 commands" for several cycles after the actual counts moved. It's low-cost to keep current if done during the cycle that changes the count; high-cost to discover stale later. Add a preflight step: when a cycle adds a skill or command, also bump the counts in `context.md`.
- **For multi-iteration cycles (N > 3 iterations in one session), write the backlog out to Drive / the run log at a midpoint.** This session ran 8 iterations in one sitting. Captured persistence at the end worked but would have failed gracefully if the session crashed mid-cycle. Either a midpoint flush or auto-append-on-merge would prevent loss.
- **Subagent path-substitution conventions should be in the skill contract from day one.** The no-opp fallback (`ACE/golden-template/`) wasn't in the original 0.3.5 qa/eval split, surfaced during Iter 4 testing, shipped in Iter 7 as a contract fix. Any skill that can run without an opp context needs its fallback path explicit on first ship.

**Confidence on validation:**

- **High on Iters 1, 3, 7 (text / contract edits).** Tests green; each is a small scoped SKILL.md or agent change with clear semantics. Manual re-run of the affected skills against cosmetics-fgd-pilot would confirm behavior, left for a dogfood cycle.
- **High on Iter 6 (golden template + bootstrap).** Before/after scores are concrete (3.84 → 8.2), re-ran qa/eval as proof. Bootstrap defense is validated against the same bad-state it was designed to catch (via the scrape helper that actually walks live OCS data).
- **Medium on the qa/eval split (0.3.5) + opp-eval (0.4.0).** Both shipped with passing tests and documented contracts, but the underlying integration points (real OCS chat, real verdict aggregation) got exercised only against the golden template (5 prompts) and against one partial opp (cosmetics-fgd-pilot, no verdicts). The 0.4.3 contract cleanup closed surfaced gaps; another real run (P4 backlog item) is needed to get to high confidence.
- **Low on orchestrator defensive init (Iter 7).** The rule is spec-level; no skill invocation has actually exercised the new `/ace:step` init path in this session. Next time `/ace:step` is invoked against an opp without state.yaml, we'll know.

### Self-improvement (canopy-skills meta-PRs)

Three candidates surfaced from this run's meta-observations:

1. **"Subagent state-mutation checkpointing."** When a subagent modifies production state (live OCS template, Drive content, external API calls), instruct it to emit a checkpoint after each mutation — timestamped, structured, greppable — so a retry after interruption has an auditable stopping point. Today the Iter 6 retry worked without issue, but in a less-fortunate case the prior partial run could have left the template in a worse state than the baseline. Worth a universal-PR for the canopy product-management skill's subagent-dispatch section.

2. **"ToolSearch before schema-guessing on MCP errors."** The Drive-quota red herring cost ~15 minutes because I inferred the wrong parameter name and read the error at face value. When an MCP tool errors on what looks like auth or quota, invoke ToolSearch for the exact schema before retrying. Small addition to canopy's debugging-skill guidance.

3. **"Auto-append context.md on count-drift."** When a cycle adds a skill, agent, or command, update the count in context.md in the same commit that adds the artifact. Cheap to do inline; expensive to catch later. PM scout skill's Phase 5 (validate) should include a count-check.

Beyond these three: the "archetype branching is a single-skill single-PR unit of work" pattern is confirmed (two shipped cleanly this session). The "qa/eval two-phase pattern" is now a first-class concept worth extracting from ACE into the canopy product-management guidance for any project where an artifact needs external exercising before judgment.
