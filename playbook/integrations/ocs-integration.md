# OCS Integration

## Overview

The ACE↔OCS integration layer is a composite MCP backend that exposes 22
atomic OCS capabilities. See the design spec at
`docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md` for
architecture and rationale.

This doc is the operational reference: which atoms exist, which skill uses
each, and how to run the MCP server.

## Running the MCP server

```bash
npm run mcp:ocs
```

Required environment: see `.env.example`.

## Capability map

### Authoring atoms (10) — Playwright backend today, REST targets documented

| Atom | Used by |
|---|---|
| `ocs_clone_chatbot` | `ocs-agent-setup` |
| `ocs_set_chatbot_system_prompt` | `ocs-agent-setup` |
| `ocs_create_collection` | `ocs-agent-setup` |
| `ocs_upload_collection_files` | `ocs-agent-setup` |
| `ocs_wait_for_collection_indexing` | `ocs-agent-setup` |
| `ocs_attach_knowledge` | `ocs-agent-setup` |
| `ocs_set_chatbot_tools` | `ocs-agent-setup` (optional) |
| `ocs_set_source_material` | (v2; no v1 skill uses this) |
| `ocs_publish_chatbot_version` | `ocs-agent-setup` |
| `ocs_get_chatbot_embed_info` | `ocs-agent-setup` (hybrid: REST + Playwright) |

### Observation atoms (12) — REST backend

| Atom | Used by |
|---|---|
| `ocs_list_chatbots` | `ocs-agent-setup` (idempotency check) |
| `ocs_get_chatbot` | `ocs-agent-setup` |
| `ocs_list_sessions` | `timeline-monitor`, `flw-data-review` |
| `ocs_get_session` | `timeline-monitor`, `flw-data-review` |
| `ocs_end_session` | (v2) |
| `ocs_add_session_tags` | `timeline-monitor`, `flw-data-review` |
| `ocs_remove_session_tags` | (v2) |
| `ocs_update_session_state` | (v2) |
| `ocs_send_test_message` | `ocs-agent-setup` (self-eval) |
| `ocs_trigger_bot_message` | `timeline-monitor` (nudges) |
| `ocs_update_participant_data` | (v2) |
| `ocs_download_file` | (v2) |

## Troubleshooting

- **`SessionExpiredError`** — run `/ocs:login` to refresh the Playwright session state
- **`PipelineShapeError`** — the golden template has more than one `LLMResponseWithPrompt` node, or none. Verify `OCS_GOLDEN_TEMPLATE_ID`.
- **`HttpError 401/403` on REST atoms** — `OCS_API_TOKEN` is invalid or lacks the required scopes. Regenerate via OCS user settings.
- **`CollectionIndexingTimeoutError`** — the embedding queue is backed up; increase `timeout_sec` or check OCS dashboard.

## Verification items

See spec section "Open verification items" for the 12 items that need
resolution during implementation. Update this section as each is resolved.

## Change log

| Date | Change |
|------|--------|
| 2026-04-03 | Initial "open questions" doc |
| 2026-04-08 | Rewritten as operational reference after composite backend ships |
