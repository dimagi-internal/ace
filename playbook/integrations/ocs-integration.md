# OCS Integration

> **Upstream repo: [`dimagi/open-chat-studio`](https://github.com/dimagi/open-chat-studio).** OCS ships continuously,
> so an ACE call path that has not changed in months can break because *they* shipped.
> When something that used to work starts failing — especially with an opaque error —
> run `skills/upstream-regression-triage` before concluding it needs a live probe.

## Overview

The ACE↔OCS integration layer is a composite MCP backend (`ace-ocs`) exposing 39
atomic OCS capabilities. Exact signatures: [`docs/atom-schemas.md` § ace-ocs](../../docs/atom-schemas.md)
(generated, authoritative). See the design spec at
`docs/superpowers/specs/2026-04-08-ace-ocs-chatbot-buildout-design.md` for
architecture and rationale.

This doc is the operational reference: which atoms exist, which skills use them
today, how to change a live bot, and how to run the MCP server. None of the atoms is
build-only — each acts on whatever `experiment_id` / `collection_id` it is given.

## Running the MCP server

```bash
npm run mcp:ocs
```

Required environment: the `OCS_*` values stored in ACE's Canopy vault on canopy-web (Settings → Credentials), written into `.env` by `/ace:setup` (`canopy agent env --plugin ace`).

## Capability map

Backend per atom: `mcp/ocs/capability-map.ts`. "Typical callers" names skills using the
atom today, not the only place it may be used.

### Chatbots

| Atom | Typical callers |
|---|---|
| `ocs_clone_chatbot` / `ocs_create_chatbot` | `ocs-agent-setup`, `ocs-coach-setup`, `interview-domain-bootstrap` |
| `ocs_list_chatbots` / `ocs_get_chatbot` / `ocs_inspect_chatbot` | `ocs-agent-setup`, `ocs-chatbot-qa`, `interview-opp-verify`, `sweep-ocs` |
| `ocs_set_chatbot_system_prompt` / `ocs_set_chatbot_description` / `ocs_set_chatbot_tools` | `ocs-agent-setup` |
| `ocs_set_source_material` | (no current caller) |
| `ocs_publish_chatbot_version` | `ocs-agent-setup`, `ocs-knowledge-refresh`, `ocs-coach-setup` |
| `ocs_ensure_public_link` / `ocs_get_chatbot_embed_info` | `ocs-agent-setup`, `ocs-widget-handoff-eval`, `ocs-chatbot-qa` |
| `ocs_delete_chatbot` | `sweep-ocs` |

### Pipelines, actions and events

| Atom | Typical callers |
|---|---|
| `ocs_get_chatbot_pipeline_id` / `ocs_set_chatbot_pipeline` / `ocs_add_pipeline_node` / `ocs_delete_pipeline` | `ocs-agent-setup`, `interview-cohort-create`, `sweep-ocs` |
| `ocs_add_custom_action` / `ocs_link_action_to_node` / `ocs_add_chatbot_event` | (no current caller) |

### Knowledge (collections)

| Atom | Typical callers |
|---|---|
| `ocs_create_collection` / `ocs_attach_knowledge` | `ocs-agent-setup` |
| `ocs_upload_collection_files` / `ocs_wait_for_collection_indexing` | `ocs-agent-setup`, `ocs-knowledge-refresh` |
| `ocs_list_collection_files` / `ocs_remove_collection_file` | `ocs-knowledge-refresh`, `ocs-chatbot-qa`, `ocs-chatbot-eval` |
| `ocs_delete_collection` | `sweep-ocs`, `ocs-knowledge-refresh` |

### Sessions and participants

| Atom | Typical callers |
|---|---|
| `ocs_send_test_message` | `ocs-agent-setup`, `ocs-chatbot-qa` |
| `ocs_list_sessions` / `ocs_get_session` / `ocs_add_session_tags` | `timeline-monitor`, `flw-data-review` |
| `ocs_trigger_bot_message` | `timeline-monitor` (nudges) |
| `ocs_end_session` | `sweep-ocs` |
| `ocs_remove_session_tags` / `ocs_update_session_state` / `ocs_update_participant_data` / `ocs_download_file` | (no current caller) |

### Team

| Atom | Typical callers |
|---|---|
| `ocs_get_me` | `interview-opp-verify` |
| `ocs_add_team_member` | `share-run-access` |

## Changing a live bot

A bot readers already use is changed in place; what they see is always the **published**
version.

| Change | How | Limits |
|---|---|---|
| Add / replace knowledge | `ocs_upload_collection_files` → `ocs_wait_for_collection_indexing` → `ocs_publish_chatbot_version` (procedure: `skills/ocs-knowledge-refresh`) | Readers see nothing until the publish |
| Remove a knowledge file | `ocs_remove_collection_file` → publish | — |
| Prompt, description, tools | `ocs_set_chatbot_system_prompt` / `_description` / `_tools` → publish | Re-run a quick `ocs-chatbot-qa` after; a prompt edit can regress answers the eval passed |
| Share the bot | `ocs_ensure_public_link` (idempotent — returns the existing link) | **Never "Regenerate link" in the OCS UI** — it revokes the old URL instantly |
| Put the bot inside a Connect opportunity | **Not possible** — Connect has no per-opportunity widget field (CCC-301, [`connect-api.md`](connect-api.md#there-is-no-per-opportunity-ocs-widget-field-ccc-301)); share the public link | — |
| Move the bot to another OCS team | **No atom.** An `ace-ocs` session's team is fixed at server start (`OCS_TEAM_SLUG`) | Clone into the other team instead |

**The public link and the widget serve the PUBLISHED version only.** An edit without
`ocs_publish_chatbot_version` changes nothing a reader sees — and an unpublished bot
shows a "not published yet" banner.

## Troubleshooting

- **`SessionExpiredError`** — run `/ace:ocs-login` to refresh the Playwright session state
- **`PipelineShapeError`** — the golden template has more than one `LLMResponseWithPrompt` node, or none. Verify `OCS_GOLDEN_TEMPLATE_ID`.
- **`HttpError 401/403` on REST atoms** — `OCS_API_TOKEN` is invalid or lacks the required scopes. Regenerate via OCS user settings.
- **`CollectionIndexingTimeoutError`** — the embedding queue is backed up; increase `timeout_sec` or check OCS dashboard.
- **Bot replies "Sorry something went wrong… intermittent error related to load" on EVERY `ocs_send_test_message` (incl. the pristine golden template), deterministically in ~2.4s** — this is NOT an LLM outage. It's the OCS chat **session-token** requirement (OCS #3552, deployed 2026-06-09): `POST /api/chat/start/` now issues a signed `session_token` that `/message/` + `/poll/` enforce as the `X-Session-Token` header. A direct consumer that doesn't thread it gets `403 session_token_required`, which the widget surfaces as that generic fallback — a deterministic, days-long "outage" that reads like LLM load but is API-contract drift. ACE threads the token as of the `sendTestMessage` fix (`mcp/ocs/backends/rest.ts`; passes `use_session_token: true`, reads `session_token`, sends `X-Session-Token`). Diagnostic tell vs. a real LLM outage: a genuine outage is **intermittent and clears in hours**; a deterministic 2.4s failure across every bot + the golden template that persists for days is a contract/credential change. If it persists AFTER the token is threaded, suspect the team's LLM **provider config** (key/quota) in OCS settings, not ACE. The legacy embed endpoints are sunset 2026-08-03 (OCS #3541) — the `/api/chat/*` widget flow is the supported path. (jjackson/ace#742)

- **Generic fallback persisting AFTER the session token is threaded → it's the team's LLM provider key, and the trace proves it** (the predicted follow-on to the bullet above, hit live 2026-06-09, jjackson/ace#743). The connect-ace Anthropic provider key (1P: `ACE - Anthropic API Key (OCS connect-ace)`) was revoked at Anthropic's end (confirmed cause: a teammate deactivated it in the Anthropic console, unaware of its consumer — console key names don't show usage; re-enabled + restored 2026-06-12); every generation on every bot — including the pristine golden template — failed `401 {'type':'authentication_error','message':'invalid x-api-key'}` in ~2.4s, which OCS masks behind the same "intermittent error related to load" fallback (`apps/experiments/task_utils.py`, shown whenever the celery task fails and `debug_mode_enabled` is off). **Triage path (now automated in `sendTestMessage`):** widget session → `GET /api/sessions/<id>/` → `messages[].metadata.trace_info[].trace_url` → open `/a/<team>/traces/<id>/` with team cookies → real provider error in the trace. The atom appends this pointer to every `OCS generation error` throw (`describeSessionTrace`). **Repair:** verify the candidate key against `api.anthropic.com/v1/messages` directly first, then POST the provider edit form `/a/<team>/service_providers/llm/<pk>/` (multipart: `csrfmiddlewaretoken`, `name`, `anthropic_api_key`, `anthropic_api_base`; pk discoverable via `…/service_providers/llm/table/` — note `OCS_LLM_PROVIDER_ID` in `.env` is the **embeddings/collection** provider, not necessarily the chat one). Key lesson: "golden template fails identically" only proves the failure is upstream of per-opp config — it cannot distinguish platform outage from team-scoped credential death, because both sit behind the same provider record.

- **Widget chat API status codes: `/start/` = 201, `/message/` = 202, `/poll/` = 200 — assert a 2xx RANGE, never `== 200`.** The send is asynchronous: `POST /api/chat/{session_id}/message/` returns **202 Accepted** with `{"task_id": …, "status": "processing"}`, and the answer only arrives on the poll. A hand-rolled harness that asserts `HTTP == 200` on the send discards accepted messages and reports a `0/3` structural pass in ~2.6s — indistinguishable from a miswired bot, and on `--quick` that escalates as a Phase 5 gate failure. Same suite with `200 <= status < 300` passed 3/3 in 58.2s. A wrong `X-Embed-Key` returns **401 `{"detail":"Invalid widget embed key"}`** — **assert a 4xx RANGE there too, never `== 403`**, for exactly the same reason: a harness pinned to `403` reads a healthy 401 rejection as "the negative control did not fire", i.e. as *the embed key is not being checked*, which is the false alarm this bullet exists to prevent. And the control is narrower than it sounds: an **entirely ABSENT `X-Embed-Key` header is not rejected at all** (`/start/` returns **201** and issues a session), so it demonstrates key *validation*, not key *requirement* — consistent with `start_session_public` being a genuine anonymous surface (it resolves published-or-working and gates only on the team's WEB channel being enabled, OCS #4230; the allowlist gate this bullet used to cite was deleted upstream in #4275 / ADR-0057, ace#1812). `mcp/ocs/backends/rest.ts` is already correct (it branches on `!sendRes.ok`); the trap is only for code written from prose. Observed live on `spark-facilitator/20260813-2126` (dimagi-internal/ace#1298); status codes on the negative control re-measured on `spark-facilitator/20260820-0817` (dimagi-internal/ace#1679).

- **The anonymous chat link is the chatbot's PUBLIC LINK channel, `https://www.openchatstudio.com/c/<token>/` — not `/a/<team>/chatbots/<public_id>/start/`.** OCS is removing that legacy page (dimagi/open-chat-studio#4209) and said so when ACE reported its blank greeting (dimagi/open-chat-studio#4792, from ace#2992), which it closed 2026-10-16 with NO code change — on `main` `_chatbot_chat_ui` still passes `chatbot_name` while `chat_ui.html` renders `{{ experiment_name }}`, so the legacy page's greeting stays blank and the public link below is the fix, not a workaround awaiting one. Create the link with `ocs_ensure_public_link` after publishing (it serves the PUBLISHED version only; unpublished → "not published yet" banner) and record the URL it returns as `public_url` — OCS mints the token, so it cannot be built. Two traps: (1) a public-link button renders BEFORE the widget button on the chatbot home page, which made the old lazy channel-id regex return the wrong channel (`extractChannelButtons` now reads each button's own slice); (2) **Regenerate link** in the OCS UI revokes the old URL instantly — never regenerate one that has been sent. Contract verified live 2026-10-16 on connect-ace bot 14296 (`test/mcp/ocs/fixtures/chatbot-home-public-link.html`).
- **Citations leak file ids and never build references on an Anthropic bot — two upstream defects, not ours to patch (ace#2018).** Off-spec `<CIT …>` spellings match none of `OCS_CITATION_PATTERN`'s three consumers, so they reach the reader verbatim (dimagi/open-chat-studio#4820). On an Anthropic-backed pipeline `parse_output_for_anthropic` never fills `cited_files`, so every `<CIT n />`, even a canonical one, is deleted as a hallucination (dimagi/open-chat-studio#4821). Do not add a prompt-side format rule, and do not set `generate_citations: false`: both remove the inline evidence `ocs-chatbot-eval` reads. `lib/widget-body-evidence.ts`'s `[LEAKED-CITATION-MARKUP]` stays report-only until those close.

## Verification items

See spec section "Open verification items" for the 12 items that need
resolution during implementation. Update this section as each is resolved.

## Related learnings

- `docs/learnings/2026-06-09-ocs-provider-key-revocation-misread-as-outage.md` — the generic "intermittent error" fallback that was a revoked provider key
- `docs/learnings/2026-05-19-ocs-upload-b64-context-wedge.md` — never pass file bytes inline through a tool argument

## Change log

| Date | Change |
|------|--------|
| 2026-10-18 | Capability map regrouped by resource (39 atoms, was a stale 22); added § Changing a live bot |
| 2026-08-29 | Corrected the explanation under the widget chat API status-code bullet: the absent-`X-Embed-Key` 201 is explained by `start_session_public` resolving published-or-working and gating on the team WEB channel (OCS #4230), not by the `participant_allowlist` gate OCS deleted in #4275 / ADR-0057. Measured status codes unchanged. ace#1812 |
| 2026-04-03 | Initial "open questions" doc |
| 2026-04-08 | Rewritten as operational reference after composite backend ships |
