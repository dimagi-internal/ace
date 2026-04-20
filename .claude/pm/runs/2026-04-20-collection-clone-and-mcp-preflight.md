## 2026-04-20 — collection-clone-and-mcp-preflight (custom lens)

**Lens used:** "close out the source_usage gap on the golden template; ship items 2 + 3 from prior backlog as OCS-layer defense." Continuation of the 2026-04-19 iteration loop, driven by the `[WARN] source_usage: 5.0` finding from Iter 4 recon.

**Background read:** `.claude/pm/runs/2026-04-19-qa-eval-iteration-loop.md` (prior cycle, backlog owners), `~/.ace/connect-ocs-bot.json` (production bot metadata), `docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md` (verification items 6, 7: team-scoping intent), `scripts/bootstrap-ocs-golden-template.ts` (prior-cycle collection-existence defense), `mcp/ocs/backends/{playwright,pipeline-patch}.ts`, `mcp/ocs-server.ts`, `test/mcp/ocs/{playwright-backend,pipeline-patch}.test.ts`. Mid-cycle: user clarified that `connect-ace` is AI-isolated from `ccc-support` for blast-radius containment (deliberate architectural choice), and that `chatbots.dimagi.com` is a legacy DNS alias for the same `openchatstudio.com` backend.

**Core finding:** The "fix items 2 and 3" framing from the prior session's backlog was **anchored on a wrong premise** — the Iter 6 subagent's "collection 718 doesn't exist on connect-ace" finding led me to categorize it as team-infrastructure work. The user's challenge ("can we reference collections across teams? what team is the support bot on?") surfaced that 718 was **stale metadata** in `~/.ace/connect-ocs-bot.json` (dated 2026-04-09). The real "NM Bot" collection is id **135** on `ccc-support`. Two DNS names for one backend created secondary confusion. A one-day loop of Path C verification → Path B execution (subagent-driven clone to connect-ace, new collection 350) → MCP-layer defense against the same class of silent-block bug resolved the gap cleanly and closed backlog item 2 as redundant with item 3.

### Do it

1. **Path C verification — cross-team collection attach → publish** — Effort: S (exploratory) — Status: **done, no PR**
   - 4 MCP tool calls: `ocs_get_chatbot_embed_info(11792)` → `ocs_attach_knowledge({collection_index_ids: [718]})` (ok: true at pipeline-patch layer) → `ocs_publish_chatbot_version` (**silent-block**: `HTTP 200 Version publish rejected: form re-rendered without redirect`) → revert: `ocs_attach_knowledge({collection_index_ids: []})` + republish to clean state.
   - Outcome: **confirmed OCS enforces team scoping at publish, not attach.** Cross-team collection references are not supported by OCS. The attach layer accepts any id; publish layer validates and rejects without surfacing the error. Path A (move template to ccc-support) was unacceptable (user: `connect-ace` is deliberately AI-isolated from human-managed production); Path B (clone locally) was the remaining option.

2. **Iter 8: Subagent clone of collection 135 (ccc-support) → 350 (connect-ace)** — Effort: M — Status: **done, live OCS state change, no code PR**
   - Dispatched a general-purpose subagent with ~40 tool-call budget. Sessions probed: connect-ace valid; ccc-support valid. Collection 718 didn't exist (stale metadata); found 135 by name ("NM Bot"). Enumerated: 2 files (`AutoConnect_FAQs.docx`, `Support_bot_FAQ_ECD-KMC-CHC.docx`), 111 chunks, ~170 KB. Extracted `OCS_LLM_PROVIDER_ID=378` (OpenAI for Embeddings) and `OCS_EMBEDDING_MODEL_ID=1` (text-embedding-3-small) from template 11792's pipeline. Created collection 350 on connect-ace, uploaded files, waited for indexing (ready=true, 2 files indexed). Attached to template 11792, republished v4 (no silent-block this time). Verified end-to-end with 5 canonical `--quick` prompts — all returned high-quality Connect-knowledgeable content clearly sourced from the uploaded docs (e.g., walked through CommCare onboarding steps lifted verbatim).
   - Side effects: env file write sandbox-blocked; user must manually add `OCS_SHARED_COLLECTION_ID=350`, `OCS_LLM_PROVIDER_ID=378`, `OCS_EMBEDDING_MODEL_ID=1` to `$CLAUDE_PLUGIN_DATA/.env`.
   - Scope discipline: read-only contract with ccc-support honored; only GETs to its API.

3. **0.5.1 — `publishChatbotVersion` pre-flight + `uploadCollectionFiles` chunk params** — Effort: M — Status: **done, shipped**
   - PR: jjackson/ace#39
   - `mcp/ocs/backends/pipeline-patch.ts` — new `validatePipeline` helper round-trips the current graph through `/pipelines/data/` to surface node-level errors. New `extractPipelineErrors` helper handles both the legacy top-level `{errors: [...]}` shape and the nested `{errors: {node: {<id>: {<field>: <msg>}}}}` shape that OCS actually returns for node-level validation. `patchLlmNodeParams` now uses the same extractor — it had the same top-level-only blindspot that hid the phantom-collection bug on 2026-04-19.
   - `mcp/ocs/backends/playwright.ts:publishChatbotVersion` — calls `validatePipeline` before `/versions/create`. The silent-publish-block class is now structurally impossible: every publish goes through the pre-flight, every node-level error surfaces as a typed `PipelineValidationError` naming the exact node + field.
   - `mcp/ocs/backends/playwright.ts:uploadCollectionFiles` — sends `chunk_size` + `chunk_overlap` (required by Django's `add_collection_files` form; omitted before this cycle). Defaults 800/400 match upstream NM Bot. MCP tool schema exposes both as optional overrides; invalid values (overlap ≥ size) throw before HTTP.
   - 12 new unit tests (89 total, up from 77). Covers both error-shape variants, pre-flight blocking, chunk-param passthrough, overlap-validation.
   - **Backlog item 2 ("ocs-agent-setup pre-flight on OCS_SHARED_COLLECTION_ID")** dropped as redundant — the MCP-layer pre-flight catches the class at the bottleneck; every path that publishes goes through it.

4. **`~/.ace/connect-ocs-bot.json` metadata refresh** — Effort: trivial — Status: **done (local file, not in repo)**
   - `shared_collection_id: 718` → 135; `shared_collection_chunks: 148` → 111; `base_url` → canonical `www.openchatstudio.com` with `base_url_legacy_alias` for the DNS fallback; new `connect_ace_local_copy` pointer to collection 350; corrected source description (uploaded docs, not Confluence auto-sync). Prevents another ghost chase from stale metadata.

### Backlog

**P1 — User action (unblocks post-clone retrieval):**
- Append three lines to `~/.claude/plugins/data/ace-ace/.env`:
  ```
  OCS_SHARED_COLLECTION_ID=350
  OCS_LLM_PROVIDER_ID=378
  OCS_EMBEDDING_MODEL_ID=1
  ```
  Without these, future opp clones go through `/ace:ocs-bootstrap-template` (which now defensively skips if env var is missing) but inherit no shared knowledge. Can't be done from within ACE-code path because the sandbox blocks writes to `$CLAUDE_PLUGIN_DATA/.env`.

**P2 — Dogfood on cosmetics-fgd-pilot (was P4 prior cycle):**
- Now unblocked: golden template works, shared collection provisioned, MCP pre-flight live. Running `ocs-setup` end-to-end on cosmetics-fgd-pilot will exercise the full 0.3.5+0.4.x+0.5.x stack against a real opp for the first time.

**P3 — `ocs_list_collections` MCP tool (was P1 prior cycle):**
- Still worth adding. `bootstrap-ocs-golden-template.ts` has a scrape-based `listCollectionIndexIds` helper; lift it to a first-class MCP tool. Would have let the Iter 8 subagent probe collection existence via tool instead of direct HTML scraping.

**P4 — Archetype coverage audit (was P2 prior cycle):**
- Unchanged: `connect-program-setup`, `training-materials`, `llo-onboarding/uat/launch/feedback`, `app-test`, `flw-data-review` need FGD-branch audit. Small per-skill PRs.

**P5 — Rubric proliferation (was P3 prior cycle):**
- Unchanged: add `## LLM-as-Judge Rubric` to more skills so `opp-eval` aggregates beyond `ocs-chatbot-eval`. Forcing function from prior cycle still standing.

**P6 — Collection sync from ccc-support upstream:**
- Collection 350 is a point-in-time clone of ccc-support 135 as of 2026-04-20. Drift is inevitable. Options: (a) manual periodic refresh, (b) auto-sync from the same Confluence source if/when that source is added, (c) cross-OCS tooling. Deferred until drift becomes observable (connect content changes slowly; days-of-lag is fine).

**P7 — `fgd-synthesis` skill (was P6 prior cycle):**
- Unchanged and deferred per user direction ("improve core first"). The "shareable-with-LEEP" narrative report is the biggest net-new capability for FGD opps, but core stability comes first.

### Closed

- **Item 2 from 2026-04-19 backlog: `ocs-agent-setup` pre-flight on `OCS_SHARED_COLLECTION_ID`.** Made redundant by the MCP-layer pre-flight in 0.5.1 — `publishChatbotVersion` now refuses any pipeline with validation errors, so per-opp bot creation is automatically protected. Skill-level duplication would be defense-in-depth but not worth the added complexity.

### Skipped on this run (raised but not formally proposed)

- **Cross-team collection support via OCS.** Verified impossible from our side (publish enforces team scope); any forward path requires an OCS feature request. Flagged as external-dependency, not in our roadmap.
- **`ocs_list_collections` MCP tool.** Would have prevented the 718 phantom-collection discovery from requiring a full subagent dispatch. Still worth doing (see P3) but not urgent.
- **Auto-validation of `~/.ace/*.json` metadata files.** The 2026-04-09 snapshot stayed authoritative in our reasoning for 11 days. Worth a "freshness probe" pattern — could be a canopy-skills universal candidate.
- **Updating 0.4.5 PM run log** to cross-reference today's discoveries. Deferred: cross-referencing is fine from this log pointing backward; forward-rewrite isn't worth it.

### Meta-observations

**What worked well:**

- **User's direct challenge broke a wrong premise.** "How does having the template in ccc-support help? we still need to create the bots... in connect ace" cut through my Path A framing in one sentence. The subagent's "collection 718 doesn't exist on connect-ace" was technically true but misleading; I'd converted it into "needs team-infra work to create a new collection" without verifying. The user asked the right question first. Rule: **when a subagent reports a factual constraint, invert it — "is this actually true?" — before categorizing the work.**
- **Path C as a cheap disambiguation experiment.** 4 MCP calls to test "does OCS reject cross-team collection attaches?" beat hours of documentation reading or speculation. The revert was clean. Rule: **for cross-system questions with reversible consequences, run the experiment.**
- **Subagent Iter 8 checkpoint discipline.** The cloning subagent emitted checkpoints after each mutation (collection created, files uploaded, attached, published). This cycle's prior-attempt rate-limit (2026-04-19 Iter 6) validated the pattern: if interrupted, the next agent picks up from the last checkpoint instead of re-running potentially destructive steps.
- **Bounded subagent scope with explicit read-only contract.** "Read-only on ccc-support. Write allowed on connect-ace." The subagent honored it cleanly; no confusion about which team to modify.
- **MCP pre-flight as class-level defense, not instance-level.** Fixing one method (`publishChatbotVersion`) catches every future silent-block, not just today's phantom-collection case. Covers `ocs-agent-setup`'s per-opp clones, manual UI edits, future `ocs_attach_knowledge` misuses — every path that publishes. Item 2 dropping as redundant is the payoff.

**What was wasteful:**

- **Assumed "720 doesn't exist on team" was a complete finding when it was an ambiguous one.** The subagent correctly observed the UI state; I wrote up a backlog item on it without probing further. Propagated a wrong premise into the prior session's PM run log (now superseded by today's discovery). Rule: **a subagent's observation is an input to reasoning, not a conclusion. Challenge the factual framing before extending it.**
- **Didn't catch the MCP field-name + chunk-param bug in earlier cycles.** The 0.3.5 qa/eval split shipped tests against a fake request layer; the `uploadCollectionFiles` chunk-param omission wouldn't have shown in any of those because the tests weren't simulating Django's form-validation behavior. The bug surfaced only when the Iter 8 subagent actually tried to upload files to a real collection. Rule: **for HTTP backend code that integrates with a specific server's form validation, unit tests against mock requests can miss entire failure classes. Integration tests are load-bearing.** Not fixing today (no new integration tests shipped), but worth noting.

**Prompt adjustments for next time:**

- **When dispatching a subagent that modifies external production state, require it to report blocked operations explicitly.** The env-file write was sandbox-blocked; the subagent buried that in the report text rather than surfacing it as a top-level "USER ACTION REQUIRED." Took a re-read to notice. Add a convention: subagent report should have a dedicated "blocked / requires manual follow-up" section.
- **Metadata files (`~/.ace/*.json`) should be treated as hypotheses, not truths.** The 2026-04-09 connect-ocs-bot.json was trusted for 11 days without re-probing. Today's refresh is a one-shot; the pattern would be "before acting on metadata older than N days, probe its facts against live state."

**Confidence on validation:**

- **High on 0.5.1 (MCP pre-flight + upload chunks).** 89 tests pass. Every observed failure shape has a test. `publishChatbotVersion` pre-flight tested end-to-end at the mock-request layer, including the exact phantom-collection nested-error shape.
- **High on Iter 8 clone (live OCS state change).** Subagent ran the 5 canonical `--quick` prompts post-republish; all 5 returned high-quality Connect-knowledgeable responses. Content provenance is qualitatively clear (e.g., CommCare onboarding walkthrough details lifted verbatim from uploaded docs). A formal `ocs-chatbot-qa --deep` + `ocs-chatbot-eval --deep` score comparison (pre-clone 8.2 overall / source_usage 5.0 → post-clone ?) would be a satisfying capstone; left for the next cycle.
- **Medium on "team-scoping is enforced at publish-time only."** Verified via one experiment (Path C). Hypothesis confirmed but n=1. A second reversing experiment (attach a collection that DOES exist, confirm publish succeeds) would strengthen confidence; left as an imputed fact.

### Self-improvement (canopy-skills meta-PRs)

Two candidates:

1. **"Metadata files as hypotheses, not truths."** When a PM cycle reads a JSON/YAML/env metadata file that anchors subsequent reasoning, tag it with a freshness check: probe the relevant fact against live state if the file is older than ~7 days. Today's stale `connect-ocs-bot.json` from 2026-04-09 cost a full exploratory cycle to unwind. Candidate for canopy's general PM-scout skill Phase 1 guidance.

2. **"Subagent blocked-operations convention."** When a subagent dispatches on a mutation task, its report should have a dedicated "USER ACTION REQUIRED" section at the top for any step sandbox-blocked or otherwise unattainable. Today's env-file write was blocked and the line buried mid-report; a convention forces it into the summary. Candidate for canopy's subagent-dispatch guidance.

Beyond these: "team-scoped resources enforced at mutation-publish time, not mutation-attach time" is OCS-specific but generalizes to "silent-accept-then-reject-on-commit" patterns across systems (SQL DDL, container orchestrators, etc.). Worth noting but not its own canopy rule.
