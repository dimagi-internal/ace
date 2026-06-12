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

Required environment: see `.env.tpl` (1Password-injectable; the canonical template for every ACE env var).

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

- **`SessionExpiredError`** — run `/ace:ocs-login` to refresh the Playwright session state
- **`PipelineShapeError`** — the golden template has more than one `LLMResponseWithPrompt` node, or none. Verify `OCS_GOLDEN_TEMPLATE_ID`.
- **`HttpError 401/403` on REST atoms** — `OCS_API_TOKEN` is invalid or lacks the required scopes. Regenerate via OCS user settings.
- **`CollectionIndexingTimeoutError`** — the embedding queue is backed up; increase `timeout_sec` or check OCS dashboard.
- **Bot replies "Sorry something went wrong… intermittent error related to load" on EVERY `ocs_send_test_message` (incl. the pristine golden template), deterministically in ~2.4s** — this is NOT an LLM outage. It's the OCS chat **session-token** requirement (OCS #3552, deployed 2026-06-09): `POST /api/chat/start/` now issues a signed `session_token` that `/message/` + `/poll/` enforce as the `X-Session-Token` header. A direct consumer that doesn't thread it gets `403 session_token_required`, which the widget surfaces as that generic fallback — a deterministic, days-long "outage" that reads like LLM load but is API-contract drift. ACE threads the token as of the `sendTestMessage` fix (`mcp/ocs/backends/rest.ts`; passes `use_session_token: true`, reads `session_token`, sends `X-Session-Token`). Diagnostic tell vs. a real LLM outage: a genuine outage is **intermittent and clears in hours**; a deterministic 2.4s failure across every bot + the golden template that persists for days is a contract/credential change. If it persists AFTER the token is threaded, suspect the team's LLM **provider config** (key/quota) in OCS settings, not ACE. The legacy embed endpoints are sunset 2026-08-03 (OCS #3541) — the `/api/chat/*` widget flow is the supported path. (jjackson/ace#742)

- **Generic fallback persisting AFTER the session token is threaded → it's the team's LLM provider key, and the trace proves it** (the predicted follow-on to the bullet above, hit live 2026-06-09, jjackson/ace#743). The connect-ace Anthropic provider key (1P: `ACE - Anthropic API Key (OCS connect-ace)`) was revoked at Anthropic's end (confirmed cause: a teammate deactivated it in the Anthropic console, unaware of its consumer — console key names don't show usage; re-enabled + restored 2026-06-12); every generation on every bot — including the pristine golden template — failed `401 {'type':'authentication_error','message':'invalid x-api-key'}` in ~2.4s, which OCS masks behind the same "intermittent error related to load" fallback (`apps/experiments/task_utils.py`, shown whenever the celery task fails and `debug_mode_enabled` is off). **Triage path (now automated in `sendTestMessage`):** widget session → `GET /api/sessions/<id>/` → `messages[].metadata.trace_info[].trace_url` → open `/a/<team>/traces/<id>/` with team cookies → real provider error in the trace. The atom appends this pointer to every `OCS generation error` throw (`describeSessionTrace`). **Repair:** verify the candidate key against `api.anthropic.com/v1/messages` directly first, then POST the provider edit form `/a/<team>/service_providers/llm/<pk>/` (multipart: `csrfmiddlewaretoken`, `name`, `anthropic_api_key`, `anthropic_api_base`; pk discoverable via `…/service_providers/llm/table/` — note `OCS_LLM_PROVIDER_ID` in `.env` is the **embeddings/collection** provider, not necessarily the chat one). Key lesson: "golden template fails identically" only proves the failure is upstream of per-opp config — it cannot distinguish platform outage from team-scoped credential death, because both sit behind the same provider record.

## Verification items

See spec section "Open verification items" for the 12 items that need
resolution during implementation. Update this section as each is resolved.

## Change log

| Date | Change |
|------|--------|
| 2026-04-03 | Initial "open questions" doc |
| 2026-04-08 | Rewritten as operational reference after composite backend ships |
