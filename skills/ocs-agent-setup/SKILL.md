---
name: ocs-agent-setup
description: >
  Create and configure an OCS chatbot for this opportunity. Clones the ACE
  golden template, uploads IDD + training + app summaries as a RAG Collection,
  patches the system prompt with opp-specific framing, publishes a version,
  and returns the embed credentials for Connect to store on the Opportunity.
---

# OCS Agent Setup

Run end-to-end against the OCS MCP server (`mcp/ocs-server.ts`). Uses these
atoms: `ocs_list_chatbots`, `ocs_clone_chatbot`, `ocs_create_collection`,
`ocs_upload_collection_files`, `ocs_wait_for_collection_indexing`,
`ocs_set_chatbot_system_prompt`, `ocs_attach_knowledge`, `ocs_set_chatbot_tools`,
`ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`,
`ocs_send_test_message`.

## Process

1. **Read opportunity context from GDrive:**
   - IDD: `ACE/<opp-name>/idd.md`
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`
   - App summaries: `ACE/<opp-name>/app-summaries/`

2. **Check for existing chatbot** (idempotency):
   - Call `ocs_list_chatbots` and filter by `name == "ACE - <opp-name>"`
   - If found, skip to step 11 with the existing `experiment_id`
   - Otherwise continue to step 3

3. **Clone the golden template:**
   - `ocs_clone_chatbot({ template_id: $OCS_GOLDEN_TEMPLATE_ID, new_name: "ACE - <opp-name>" })`
   - Capture `{experiment_id, public_id, pipeline_id}`

4. **Create a per-opp Collection:**
   - `ocs_create_collection({ name: "ACE <opp-name>", summary: "Knowledge base for <opp-name> — IDD, training, app summaries", is_index: true, is_remote_index: true })`
   - Capture `collection_id`

5. **Upload RAG files:**
   - For each file in the opportunity's context (IDD, training PDFs, app summary markdown), base64-encode the content
   - `ocs_upload_collection_files({ collection_id, files: [...] })`
   - Capture `file_ids`

6. **Wait for indexing:**
   - `ocs_wait_for_collection_indexing({ collection_id, timeout_sec: 300 })`
   - On timeout, escalate to human

7. **Compose the system prompt** from the IDD + opp details + escalation rules. The prompt should:
   - Identify the chatbot as the ACE support bot for this specific opportunity
   - Name the Network Manager / LLO(s) and key dates
   - Summarize the intervention (from IDD)
   - Tell the bot to escalate to the admin group at Ace-AI@Dimagi.com on specific triggers
   - Reference BOTH knowledge sources: the shared Connect collection and the opp-specific collection
   - Use [training-gap] and [product-feedback] tags per the golden template conventions

8. **Patch the chatbot:**
   - `ocs_set_chatbot_system_prompt({ experiment_id, prompt })`
   - Build the combined collection list: `[$OCS_SHARED_COLLECTION_ID, collection_id]`
     where `$OCS_SHARED_COLLECTION_ID` is the Connect knowledge collection from the env
     (shared across all opps — Confluence-sourced, auto-syncing) and `collection_id` is
     the per-opp collection created in step 4. The golden template already has the shared
     collection attached; this step REPLACES the list with both IDs so the per-opp
     collection is added alongside it.
   - `ocs_attach_knowledge({ experiment_id, collection_index_ids: [$OCS_SHARED_COLLECTION_ID, collection_id], max_results: 20, generate_citations: true })`

9. **Publish a version:**
   - `ocs_publish_chatbot_version({ experiment_id, description: "Initial ACE version for <opp-name>" })`

10. **Self-evaluate (LLM-as-Judge):**
    - Send 3-5 canned questions via `ocs_send_test_message`
    - Judge responses for correctness + tone against expected answers from the IDD
    - On failure, retry prompt patching once; if still failing, escalate

11. **Retrieve embed credentials:**
    - `ocs_get_chatbot_embed_info({ experiment_id })`
    - Capture `{public_id, embed_key}`

12. **Write state file:** `ACE/<opp-name>/ocs-agent-config.md`
    - Fields: `experiment_id`, `public_id`, `embed_key`, `collection_id`, `pipeline_id`, `version_number`, `created_at`
    - On re-run, this file is the source of truth; skip to step 11 if present

13. **Hand off to connect-setup:**
    - Pass `{public_id, embed_key}` to the `connect-setup` skill for writing to the Opportunity record
    - See the Connect interface contract in `docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md`

## Mode Behavior

- **Auto:** Execute all steps. Surface errors with specific atom names.
- **Review:** Pause before step 3 (show composed prompt + file list) and before step 9 (show post-patch chatbot state).

## Dry-Run Behavior

When `--dry-run` is active:
- Every MCP atom call is logged to `ACE/<opp-name>/comms-log/dry-run-ocs-agent-setup.md` with atom name + args
- No HTTP goes out; atom responses are stubbed
- State tracks as `dry-run-success`

## Failure Modes

- `PipelineShapeError` — golden template invariant violated. Verify with `OCS_GOLDEN_TEMPLATE_ID` points at a template with exactly one `LLMResponseWithPrompt` node.
- `CollectionIndexingTimeoutError` — raise timeout; if persists, check OCS dashboard for the collection's indexing queue.
- `SessionExpiredError` — run `/ocs:login` to re-authenticate.
- `HttpError 4xx` on clone — verify `OCS_GOLDEN_TEMPLATE_ID` and `OCS_TEAM_SLUG` env vars.
- LLM-as-Judge failure — prompt engineering issue; revise step 7's prompt composition.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-03 | Initial version (manual workaround) | ACE team |
| 2026-04-08 | Full rewrite against OCS MCP composite backend | ACE team |
