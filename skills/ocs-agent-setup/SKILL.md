---
name: ocs-agent-setup
description: >
  Create and configure an OCS chatbot for this opportunity. Clones the ACE
  golden template, uploads PDD + training + app summaries as a RAG Collection,
  patches the system prompt with opp-specific framing, publishes a version,
  and returns the embed credentials for Connect to store on the Opportunity.
---

# OCS Agent Setup

Run end-to-end against the OCS MCP server (`mcp/ocs-server.ts`). Uses these
atoms: `ocs_list_chatbots`, `ocs_clone_chatbot`, `ocs_create_collection`,
`ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`,
`ocs_set_chatbot_system_prompt`, `ocs_attach_knowledge`, `ocs_set_chatbot_tools`,
`ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`.

Runs in Phase 4 as Step 1 under the `ocs-setup` agent. The agent handles
quality gating via the `ocs-chatbot-qa` → `ocs-chatbot-eval` pair (quick
+ deep) in subsequent steps, so this skill is now purely configuration —
no inline self-eval.

## Process

1. **Read opportunity context from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md`
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`
   - App summaries: `ACE/<opp-name>/app-summaries/`

2. **Check for existing chatbot** (idempotency):
   - Call `ocs_list_chatbots` and filter by `name == "ACE - <opp-name>"`
   - If found, **read the integer `experiment_id` from the matched entry** (returned alongside the UUID `id` as of 0.5.19) and skip to step 11. Do NOT clone — re-cloning leaves the prior bot orphaned in OCS, which has no MCP-side cleanup atom. The previous (pre-0.5.19) skill version had to clone a `-resume` variant because the integer id wasn't reachable from list results; that footgun is closed.
   - Otherwise continue to step 3

3. **Clone the golden template:**
   - `ocs_clone_chatbot({ template_id: $OCS_GOLDEN_TEMPLATE_ID, new_name: "ACE - <opp-name>" })`
   - Capture `{experiment_id, public_id, pipeline_id}`

4. **Create a per-opp Collection:**
   - `ocs_create_collection({ name: "ACE <opp-name>", summary: "Knowledge base for <opp-name> — PDD, training, app summaries", is_index: true, is_remote_index: false })`
   - `llm_provider` and `embedding_model` default from `OCS_LLM_PROVIDER_ID` and `OCS_EMBEDDING_MODEL_ID` env vars (required for indexed collections)
   - Use `is_remote_index: false` (local index) — remote indexes crash with 500 on the connect-ace team
   - Capture `collection_id`

5. **Upload RAG files:**
   - For each file in the opportunity's context (PDD, training PDFs, app summary markdown), base64-encode the content
   - `ocs_upload_collection_files({ collection_id, files: [...] })`
   - Capture `file_ids`

6. **Wait for indexing:**
   - `ocs_wait_for_collection_indexing({ collection_id, timeout_sec: 300 })`
   - On timeout, escalate to human

7. **Compose the system prompt** from the PDD + opp details + escalation rules. The prompt MUST:
   - **Match the OCS variable rule for the collection list you'll attach in step 8.** OCS rejects pipeline saves that violate this rule (verified 2026-04-28 via live probe): the prompt must contain the literal template variable `{collection_index_summaries}` **iff** you will attach **2 or more** collections. Single or zero collections must NOT include the variable; multiple collections MUST include it. As of 0.6.10 the MCP pre-flights both directions and fails fast with a typed error.
     - **If `$OCS_SHARED_COLLECTION_ID` is set** (you'll attach `[shared, opp]`, length 2): include `{collection_index_summaries}` in a "Knowledge:" or "Reference:" section. The token is interpolated at runtime with one-line summaries of every attached collection.
     - **If `$OCS_SHARED_COLLECTION_ID` is unset** (you'll attach `[opp]` only, length 1): do NOT include the variable. Reference the opp-specific collection content directly in the prompt body.
   - Identify the chatbot as the ACE support bot for this specific opportunity
   - Name the Network Manager / LLO(s) and key dates
   - Summarize the intervention (from PDD)
   - Tell the bot to escalate to the admin group at ace@dimagi-ai.com on specific triggers
   - Reference the relevant knowledge sources (the shared Connect collection and/or the opp-specific collection, matching what you'll attach in step 8)
   - Use [training-gap] and [product-feedback] tags per the golden template conventions

8. **Patch the chatbot in one transactional call:**
   - Build the collection list:
     - `[$OCS_SHARED_COLLECTION_ID, collection_id]` if the env var is set (multi — prompt MUST have the variable per step 7)
     - `[collection_id]` if the env var is unset (single — prompt MUST NOT have the variable per step 7)
   - `ocs_set_chatbot_pipeline({ experiment_id, prompt, collection_index_ids: <built above>, max_results: 20, generate_citations: true })`
     One transactional save, prompt + collections in one POST. The bundled atom pre-flights the OCS cross-field rule (`{collection_index_summaries}` iff length>=2); a typed `PipelineValidationError` is raised if the merged state would violate it.

9. **Publish a version:**
   - `ocs_publish_chatbot_version({ experiment_id, description: "Initial ACE version for <opp-name>" })`

10. **Retrieve embed credentials:**
    - `ocs_get_chatbot_embed_info({ experiment_id })`
    - Capture `{public_id, embed_key}`

11. **Write state file:** `ACE/<opp-name>/ocs-agent-config.md`
    - Fields: `experiment_id`, `public_id`, `embed_key`, `collection_id`, `pipeline_id`, `version_number`, `created_at`
    - On re-run, this file is the source of truth; skip to step 10 if present

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
- Every MCP atom call is logged to `ACE/<opp-name>/comms-log/dry-run-ocs-agent-setup.md` with atom name + args
- No HTTP goes out; atom responses are stubbed
- State tracks as `dry-run-success`

## Failure Modes

- `PipelineShapeError` — golden template invariant violated. Verify with `OCS_GOLDEN_TEMPLATE_ID` points at a template with exactly one `LLMResponseWithPrompt` node.
- `CollectionIndexingTimeoutError` — raise timeout; if persists, check OCS dashboard for the collection's indexing queue.
- `SessionExpiredError` — run `/ace:ocs-login` to re-authenticate.
- `HttpError 4xx` on clone — verify `OCS_GOLDEN_TEMPLATE_ID` and `OCS_TEAM_SLUG` env vars.
- Quality gate failure downstream — if `ocs-chatbot-eval --quick` or
  `--deep` scores below threshold in Phase 4, the usual fix is prompt
  engineering in step 7's composition. Re-run this skill with the revised
  prompt, then re-run qa + eval.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version (manual workaround) | ACE team |
| 2026-04-08 | Full rewrite against OCS MCP composite backend | ACE team |
| 2026-04-14 | Removed inline LLM-as-Judge self-eval and connect-setup handoff; quality gating + Connect widget handoff now live in the `ocs-setup` Phase 4 agent | ACE team |
| 2026-04-27 | Step 2 idempotency uses the integer `experiment_id` returned by `ocs_list_chatbots` (0.5.19 — no more orphan re-clones). Step 7 explicitly requires `{collection_index_summaries}` in the system prompt; MCP `ocs_attach_knowledge` pre-flights this and fails with a typed error otherwise. | ACE team |
| 2026-04-28 | Step 8 collapsed into a single `ocs_set_chatbot_pipeline` call (0.6.4 — transactional save). Closes the chicken-and-egg surfaced in the 2026-04-27 dogfood where `set_chatbot_system_prompt` followed by `attach_knowledge` (or vice versa) hit OCS cross-field validation on the intermediate save. | ACE team |
| 2026-04-28 | Step 7 prompt rule corrected (0.6.10): `{collection_index_summaries}` is required iff `collection_index_ids.length >= 2` (verified via live OCS probe — see `scripts/probe-n1-cross-test.ts`). Single-collection clones must NOT include the variable; multi-collection clones MUST. The 0.6.4 framing (variable iff non-empty) was wrong. | ACE team |
