---
name: ocs-agent-setup
description: >
  Clone the ACE OCS template into a per-opp chatbot, attach a RAG
  collection from PDD + training + app summaries, publish, return embed credentials.
disable-model-invocation: true
---

# OCS Agent Setup

Run end-to-end against the OCS MCP server (`mcp/ocs-server.ts`). Uses these
atoms: `ocs_list_chatbots`, `ocs_clone_chatbot`, `ocs_create_collection`,
`ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`,
`ocs_set_chatbot_system_prompt`, `ocs_attach_knowledge`, `ocs_set_chatbot_tools`,
`ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`.

Runs in Phase 5 as Step 1 under the `ocs-setup` agent. The agent handles
quality gating via the `ocs-chatbot-qa` → `ocs-chatbot-eval` pair (quick
+ deep) in subsequent steps, so this skill is now purely configuration —
no inline self-eval.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | RAG content + system prompt framing |
| Phase 6 | `runs/<run-id>/6-qa-and-training/` (per-artifact training docs) | RAG content (LLO/FLW guides, FAQ, quick-reference) |
| Phase 3 | `runs/<run-id>/3-commcare/` (app summaries) | RAG content (app structure for the chatbot to answer "where do I find X" questions) |
| Phase 4 | `4-connect/connect-opp-setup.md` | opp framing for system prompt |

## Products

- `5-ocs/ocs-agent-setup.md` — chatbot identifiers (`experiment_id`, `version_number`, embed `public_id` + `embed_key`)
- `5-ocs/ocs-setup_widget-handoff.md` — widget URL + embed credentials staged for Connect HITL paste-in
- `run_state.yaml.phases.ocs-setup.products.ocs_chatbot` — `{experiment_id, public_id, embed_key, admin_url, team_slug}` typed handoff. Sole writer.

## Modes

- **Default (full setup).** Run every step end-to-end. Re-runs against
  an opp that already has a state file short-circuit at Step 0 — they
  skip to Step 10 (retrieve embed) with zero OCS calls.
- **`--prompt-patch`** (cheap iteration after `ocs-chatbot-eval --quick`
  fails). Reuses the existing chatbot, collection, and uploaded files;
  recomposes the system prompt against the latest PDD, calls
  `ocs_set_chatbot_pipeline` with the new prompt, and publishes a new
  version. Skips clone (Step 3), create collection (Step 4), upload
  (Step 5), and the 5–10 minute re-index (Step 6). Use this when the
  RAG content didn't change but the prompt needs a tweak — the typical
  outcome of a `--quick` quality fail.

## Sequencing contract — dependent OCS calls run STRICTLY serially (jjackson/ace#585)

Every OCS call below that consumes an identifier produced by an earlier
call (`create_collection` needs the cloned `experiment_id`; `upload`
needs `collection_id` + the returned `file_ids`; `set_chatbot_pipeline`
needs `pipeline_id`; `publish` / `get_chatbot_embed_info` need
`experiment_id`) MUST be issued **one at a time, each AFTER the producing
call's real result has flushed to context.** Do NOT batch dependent OCS
calls in a single parallel block. Under OCS/Drive result-delivery
latency, a real result can arrive several turns after its call; batching
dependents makes it tempting to "fill the gap" with an invented
placeholder id — the documented #1 Phase-5 derail (bednet-spot-check
20260530-2015: duplicate collections 486/487, 403 "Invalid widget embed
key" on placeholder `send_test_message`, and a `run_state` block written
with fabricated `experiment_id`/`public_id`/`embed_key`).

**NEVER fabricate, guess, or placeholder an OCS identifier.** Use only
IDs returned by a real, flushed tool result. If a result hasn't arrived,
WAIT for it — do not proceed with a stand-in. `classify_phase_writeback`
checks block *shape*, not ID realness, so a fabricated-but-well-formed
block passes structural validation; the only real guard is the live
round-trip gate in Step 11.5 below.

## Process

0. **Idempotency short-circuit (read state file first — runs before any
   OCS call).** Read `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup.md`.
   - **State file absent.** Fresh setup. Continue to Step 1.
   - **State file present, `--prompt-patch` flag set.** Reuse the
     existing `experiment_id`, `collection_id`, and `pipeline_id`.
     Skip to Step 7 (recompose prompt) → Step 8
     (`ocs_set_chatbot_pipeline` with the new prompt and the existing
     collection list) → Step 9 (publish) → Step 10 (retrieve embed) →
     Step 11 (overwrite state file with the new `version_number`).
   - **State file present, no flag.** The chatbot is already
     configured; just refresh embed credentials. Skip to Step 10. Do
     NOT call `ocs_list_chatbots`, do NOT re-clone — the state file is
     authoritative.

   This step exists because Step 2's `ocs_list_chatbots` filter is the
   second-line idempotency check, not the first. A live OCS list call
   on every re-run wastes ~1s when the local artifact already has the
   answer; on a `--prompt-patch` re-run it would also walk the full
   pipeline (clone is a no-op when the bot exists, but the create
   collection / upload / wait-for-indexing branches re-fire and burn
   5–10 min) before the existing state would even be consulted.

1. **Read opportunity context from GDrive:**
   - PDD: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
   - Training materials: `ACE/<opp-name>/runs/<run-id>/6-qa-and-training/`
   - Opportunity details: `ACE/<opp-name>/runs/<run-id>/4-connect/connect-opp-setup.md`
   - App summaries: `ACE/<opp-name>/runs/<run-id>/3-commcare/`

2. **Check for existing chatbot via OCS list** (second-line idempotency
   — only reachable when Step 0 found no state file):
   - Call `ocs_list_chatbots` and filter by `name == "ACE - <opp-name>"`
   - If found, **read the integer `experiment_id` from the matched entry** (returned alongside the UUID `id` as of 0.5.19), reconstruct the state file from `ocs_get_chatbot` to populate `collection_id` / `pipeline_id`, and skip to step 11. Do NOT clone — re-cloning leaves the prior bot orphaned in OCS, which has no MCP-side cleanup atom. The previous (pre-0.5.19) skill version had to clone a `-resume` variant because the integer id wasn't reachable from list results; that footgun is closed.
   - Otherwise continue to step 3

3. **Clone the golden template:**
   - `ocs_clone_chatbot({ template_id: $OCS_GOLDEN_TEMPLATE_ID, new_name: "ACE - <opp-name>" })`
   - Capture `{experiment_id, public_id, pipeline_id}`

4. **Create a per-opp Collection:**
   - `ocs_create_collection({ name: "ACE <opp-name>", summary: "Knowledge base for <opp-name> — PDD, training, app summaries", is_index: true, is_remote_index: false })`
   - `llm_provider` and `embedding_model` default from `OCS_LLM_PROVIDER_ID` and `OCS_EMBEDDING_MODEL_ID` env vars (required for indexed collections)
   - Use `is_remote_index: false` (local index) — remote indexes crash with 500 on the connect-ace team
   - Capture `collection_id`

5. **Upload RAG files (PDD + source inputs + training + summaries).**

   The canonical KB recipe is **PDD + inputs + training + app summaries**
   (per [#106 finding 15](https://github.com/jjackson/ace/issues/106)).
   Indexing the source PDFs/spreadsheets directly alongside the
   synthesized PDD gives the bot procedural fidelity for SOP-level
   questions where the PDD summary may have lost detail. The pre-fix
   recipe was PDD-only; that lost the original SOP wording.

   Files to gather:
   - `runs/<run-id>/1-design/idea-to-pdd.md` — synthesized PDD
   - `runs/<run-id>/2-scenarios/pdd-to-test-prompts.md` — Phase 2's
     32 derived Q&A pairs. Especially useful for **`focus-group`**
     archetype where the chatbot is the **primary** facilitator
     surface (training reference + post-session gdoc-writing
     guidance); indexing the test prompts gives meaningfully better
     facilitator-domain grounding than the PDD alone. Less load-bearing
     for `atomic-visit` (where the Learn app carries the bulk of
     training), but always-include is the simpler rule and the
     marginal token cost is small.
   - `inputs/*` — every file in the opp's `inputs/` folder (SOPs,
     questionnaire templates, data spreadsheets, evidence packs).
     Use `drive_list_folder` + `drive_download_binary` for binary
     types (PDF, docx, xlsx — see also [#106 finding 4](https://github.com/jjackson/ace/issues/106));
     use `drive_read_file` for text files (markdown, plain text).
   - `runs/<run-id>/6-qa-and-training/*` — per-artifact training docs
     (LLO/FLW guides, FAQ, quick-reference). Phase 6 may not have run
     yet when this skill runs in `/ace:run` flow — skip missing files
     silently rather than halting; Phase 6's `--prompt-patch` re-run
     picks them up after the fact.
   - `runs/<run-id>/3-commcare/*` — app structure summaries

   For each file, base64-encode the content (the upload atom takes
   base64). Upload in one call:

   - `ocs_upload_collection_files({ collection_id, files: [...] })`
   - Capture `file_ids`

   Note on PDF token cost: source PDFs can be large. OCS's indexer
   chunks them, but the embedding cost scales with content. If the
   inputs/ folder has >200 KB of PDF content, log an `[INFO]` line
   to `comms-log/observations.md` so the operator can audit.

6. **Wait for indexing:**
   - `ocs_wait_for_collection_indexing({ collection_id, timeout_sec: 300 })`
   - On timeout, escalate to human

7. **Compose the system prompt** from the PDD + opp details + escalation rules. The prompt MUST:
   - **Match the OCS variable rule for the collection list you'll attach in step 8.** OCS rejects pipeline saves that violate this rule (verified 2026-04-28 via live probe): the prompt must contain the literal template variable `{collection_index_summaries}` **iff** you will attach **2 or more** collections. Single or zero collections must NOT include the variable; multiple collections MUST include it. As of 0.6.10 the MCP pre-flights both directions and fails fast with a typed error.
     - **If `$OCS_SHARED_COLLECTION_ID` is set** (you'll attach `[shared, opp]`, length 2): include `{collection_index_summaries}` in a "Knowledge:" or "Reference:" section. The token is interpolated at runtime with one-line summaries of every attached collection.
     - **If `$OCS_SHARED_COLLECTION_ID` is unset** (you'll attach `[opp]` only, length 1): do NOT include the variable. Reference the opp-specific collection content directly in the prompt body.
   - Identify the chatbot as the ACE support bot for this specific opportunity
   - **State whether this bot is the primary or supplementary facilitator surface**, based on the PDD's `archetype:`. For `focus-group`, the bot is the **primary** training + post-session writing surface — there is no Learn app carrying training content (the Learn app is a one-form sentinel readiness gate; see `pdd-to-learn-app/SKILL.md § Archetypes § focus-group`). The prompt should say verbatim: *"You are the **primary** facilitator-training and post-session writing-guidance surface for this opportunity. The CommCare Learn app is a one-form readiness gate, not a training curriculum. Facilitator training content lives here (this chatbot) + the per-opp handbook gdoc."* For `atomic-visit` and `multi-stage`, the bot is supplementary to a real Learn app — say so explicitly so retrieval doesn't over-confidently answer training-content questions.
   - Name the Network Manager / LLO(s) and key dates
   - Summarize the intervention (from PDD)
   - Tell the bot to escalate to the admin group at ace@dimagi-ai.com on specific triggers
   - Reference the relevant knowledge sources (the shared Connect collection and/or the opp-specific collection, matching what you'll attach in step 8)
   - Use [training-gap] and [product-feedback] tags per the golden template conventions

8. **Patch the chatbot in one transactional call:**
   - Build the collection list:
     - `[$OCS_SHARED_COLLECTION_ID, collection_id]` if the env var is set (multi — prompt MUST have the variable per step 7)
     - `[collection_id]` if the env var is unset (single — prompt MUST NOT have the variable per step 7)

   **Shared-collection bleed warning** (per [#106 finding 14](https://github.com/jjackson/ace/issues/106)).
   When `$OCS_SHARED_COLLECTION_ID` is set, the shared collection (e.g.
   the Connect-general "NM Bot" collection 350) competes with the
   opp-specific collection for retrieval slots. On generic prompts
   ("how do I claim this opportunity?"), shared often outweighs
   opp-specific — the bot answers from the shared collection's stale
   exemplar opp ("6 modules") rather than the LEEP-specific Learn app
   ("8 modules"). The prompt SHOULD therefore explicitly steer
   retrieval toward opp-specific content for any
   identifier-bearing question:
   - In step 7's prompt, after the `{collection_index_summaries}`
     section, add: *"When answering questions about THIS specific
     opportunity (visit counts, module structure, payment unit
     details, FLW eligibility), prefer information from the
     opp-specific knowledge collection over the shared
     CommCare-Connect collection. The shared collection is for
     cross-opp Connect-product questions only."*
   - Future fix tracks: dropping the shared collection entirely for
     opp-specific bots is one option (would require recomposing the
     prompt to drop the variable per the cross-field invariant); a
     retrieval-weight knob in OCS is another. Until either ships, the
     prompt-side hint is the only ACE-side lever.

   - `ocs_set_chatbot_pipeline({ experiment_id, prompt, collection_index_ids: <built above>, max_results: 20, generate_citations: true })`
     One transactional save, prompt + collections in one POST. The bundled atom pre-flights the OCS cross-field rule (`{collection_index_summaries}` iff length>=2); a typed `PipelineValidationError` is raised if the merged state would violate it.

9. **Publish a version:**
   - `ocs_publish_chatbot_version({ experiment_id, description: "Initial ACE version for <opp-name>" })`

10. **Retrieve embed credentials:**
    - `ocs_get_chatbot_embed_info({ experiment_id })`
    - Capture `{public_id, embed_key}`

11. **Write state file:** `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup.md`
    - Fields: `experiment_id`, `public_id`, `embed_key`, `collection_id`, `pipeline_id`, `version_number`, `created_at`, optional `last_prompt_patched_at` (set by `--prompt-patch` re-runs)
    - This file is the source of truth for idempotency — Step 0 reads it before any OCS call

11.5. **Hard embed round-trip gate (mandatory — runs before the
    `run_state` writeback, jjackson/ace#585).** The IDs about to be written
    must correspond to a LIVE OCS object, not a value carried through a
    latency window. Re-call `ocs_get_chatbot_embed_info({ experiment_id })`
    fresh and assert the `public_id` + `embed_key` it returns are exactly
    the ones captured in Steps 10–11. If they do not round-trip — or
    `experiment_id` does not resolve to a live chatbot via
    `ocs_get_chatbot({ experiment_id })` — **fail the phase loudly** with a
    typed error naming the mismatch; do NOT write `products.ocs_chatbot`.
    (Optional belt-and-suspenders: also confirm exactly one collection
    named `ACE <opp-name>` exists via `ocs_list_*` to catch the
    duplicate-collection symptom.) This is the structural backstop that
    `classify_phase_writeback` cannot provide — it validates shape, not
    whether the IDs are real. Only on a clean round-trip proceed to Step 12.

12. **Write `products.ocs_chatbot` to `run_state.yaml`** so downstream
    readers (ace-web summary, llo-onboarding, Connect handoff) can read
    the chatbot identity directly from typed state without parsing the
    widget-handoff markdown table.

    ```yaml
    phases:
      ocs-setup:
        products:
          ocs_chatbot:
            experiment_id: <UUID from Step 1>
            public_id: <from Step 10>
            embed_key: <from Step 10>
            team_slug: <OCS team slug — typically "connect-ace">
            admin_url: https://www.openchatstudio.com/a/<team_slug>/chatbots/<experiment_id>/
    ```

    Apply via `mcp__plugin_ace_ace-gdrive__update_yaml_file` with
    `merge: 'deep'` (partial patch of the `ocs-setup` phase child —
    `deep` preserves the phase's `status`/`steps`; `two-level` would
    drop them, #572/#587). Sole writer of `products.ocs_chatbot`. The
    `admin_url` is the OCS
    chatbot home page (auth-gated; useful for ACE operators with OCS
    access). The `/chatbots/embed/<public_id>/` URL once written by
    `ocs-widget-handoff` is a 404 — there's no standalone embed page,
    only the corner widget — so it's not in the typed handoff.

Quality gating (quick + deep qa→eval pairs) and Connect widget handoff
happen in subsequent steps of the `ocs-setup` agent, not in this skill.

## MCP Tools Used

- **OCS MCP (`ace-ocs`):** `ocs_list_chatbots`, `ocs_clone_chatbot`,
  `ocs_create_collection`, `ocs_upload_collection_files`,
  `ocs_wait_for_collection_indexing`, `ocs_set_chatbot_pipeline`,
  `ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`.
- **Google Drive MCP (`ace-gdrive`):** `drive_read_file`,
  `drive_list_folder`, `drive_create_file`.

Authoring atoms route through Playwright (see
`mcp/ocs/capability-map.ts`); a live `/ace:ocs-login` session is
required.

## Mode Behavior

- **Auto:** Execute all steps. Surface errors with specific atom names.
- **Review:** Pause before step 3 (show composed prompt + file list) and before step 9 (show post-patch chatbot state before publishing a version).

## Dry-Run Behavior

When `--dry-run` is active:
- Every MCP atom call is logged to `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-agent-setup_dry-run-log.md` with atom name + args
- No HTTP goes out; atom responses are stubbed
- State tracks as `dry-run-success`

## Failure Modes

- `PipelineShapeError` — golden template invariant violated. Verify with `OCS_GOLDEN_TEMPLATE_ID` points at a template with exactly one `LLMResponseWithPrompt` node.
- `CollectionIndexingTimeoutError` — raise timeout; if persists, check OCS dashboard for the collection's indexing queue.
- `SessionExpiredError` — run `/ace:ocs-login` to re-authenticate.
- `HttpError 4xx` on clone — verify `OCS_GOLDEN_TEMPLATE_ID` and `OCS_TEAM_SLUG` env vars.
- Quality gate failure downstream — if `ocs-chatbot-eval --quick` or
  `--deep` scores below threshold in Phase 5, the usual fix is prompt
  engineering in step 7's composition. Re-run with `--prompt-patch`
  (skips the 5–10 min re-index since the RAG content didn't change),
  then re-run qa + eval. The `ocs-setup` agent's Phase 5 retry loop
  uses this mode automatically.

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time.

### Common load-bearing decisions for Phase 5

| ID | Question | Map to surface |
|---|---|---|
| `system-prompt-baseline` | What baseline system prompt does the per-opp chatbot inherit (golden template default vs. customized for archetype)? | `ocs-chatbot-eval` rubric coverage |
| `rag-collection-scope` | What documents land in the per-opp RAG collection (golden defaults vs. opp-specific additions)? | `ocs-chatbot-eval` retrieval-quality dimension |
| `test-prompt-count` | How many test prompts feed the smoke-eval gate (default 5 quick, 90 deep)? | `pdd-to-test-prompts` output cardinality; deep vs shallow QA split |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 5-ocs` and
`skill: ocs-agent-setup`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-05 | **Two idempotency improvements.** (1) New Step 0 reads the local state file (`runs/<run-id>/5-ocs/ocs-agent-setup.md`) before any OCS call — saves ~1s on a normal re-run and avoids the silent-pipeline-walk on `--prompt-patch` re-runs. (2) New `--prompt-patch` mode reuses the existing chatbot/collection/files, skipping clone + create-collection + upload + 5–10 min indexing wait, and just recomposes the prompt → calls `ocs_set_chatbot_pipeline` → publishes. This is the canonical Phase 5 retry path after `ocs-chatbot-eval --quick` flags a prompt issue (the previous skill prose said the agent should "retry prompt-patch" but no such mode existed — re-runs walked the full pipeline). | ACE team |
| 2026-05-08 | Add `## Decisions Log` section: 3 anchor rows (system-prompt-baseline, rag-collection-scope, test-prompt-count) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 3-10 writes). | ACE team (decisions-log PR #4) |
| 2026-05-15 | Add `2-scenarios/pdd-to-test-prompts.md` to the canonical KB recipe (Step 5); add archetype-aware "primary vs supplementary surface" line to the system-prompt composition checklist (Step 7) — for `focus-group`, the chatbot is the primary facilitator training + post-session writing surface. Make `6-qa-and-training/*` reads tolerant of missing files (Phase 6 may not have run yet in `/ace:run` flow). Prompted by `malaria-itn-fgd/20260514-2352` Phase 5 agent observations. | ACE team |
