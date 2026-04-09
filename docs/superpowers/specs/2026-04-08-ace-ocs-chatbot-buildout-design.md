# ACE ↔ OCS Integration Layer — Design

**Date:** 2026-04-08
**Status:** Draft for review
**Owner:** Jon

## Context

ACE needs to create, configure, monitor, and learn from OCS (Open Chat Studio) chatbots on a per-opportunity basis. This spec designs the full ACE↔OCS integration layer that delivers that capability.

The existing ACE repo has scaffolding in place — `skills/ocs-agent-setup`, `mcp/ocs-server.ts`, and `playbook/integrations/ocs-integration.md` — but every MCP tool currently returns `not_implemented`, and the integration doc is a list of open questions rather than a design. This spec fills both gaps.

### The core problem: OCS's public API covers observation, not authoring

A deep dive into `dimagi/open-chat-studio/api-schema.yml` and the backend code found a clean asymmetry:

- **Observation is covered.** Listing chatbots, listing sessions, retrieving transcripts, tagging sessions, sending test messages (OpenAI-compatible), triggering bot messages, and updating participant data all have stable REST endpoints.
- **Authoring is not.** Creating a chatbot, editing its system prompt, uploading source material, attaching a knowledge collection, configuring tools, and publishing a version are all web-UI-only.

OCS will grow authoring APIs over time. Until then, ACE needs a bridge that fills the gap without locking skills code into the bridge's mechanics.

### What Jon asked for

Two structural constraints locked in at the start of the brainstorming session:

1. **Full OCS integration layer** — not just `ocs-agent-setup`. The bridge should serve all skills that touch OCS: `ocs-agent-setup` (authoring), `timeline-monitor` (session polling + nudges), and `flw-data-review` (transcript analysis).
2. **Atomic capability interface, swappable backends.** The MCP should expose actions atomically — `ocs_set_system_prompt`, `ocs_attach_knowledge`, etc. — so that when OCS ships real APIs, the backend can be swapped per-atom without touching skill code. No Playwright leakage into the contract.

## Goals

1. Ship an MCP server that exposes ~22 atomic OCS capabilities as tools, backed by a composite backend that routes each capability to REST or Playwright based on what OCS supports today.
2. Enable `ocs-agent-setup` to run end-to-end against OCS without manual intervention — clone the golden template, configure it, publish a version, and return the embed credentials.
3. Enable `timeline-monitor` and `flw-data-review` to read OCS sessions and transcripts directly, with tagging support for review state.
4. Keep the Playwright backend's surface area minimal: no click-driving, no selectors, no UI automation beyond what's required for Django session + CSRF handling.
5. Document the Connect-side changes needed to route LLOs to per-opportunity bots as a clean interface contract, without building the Connect work in this spec.
6. Design every MCP atom so its REST-backed replacement is a one-line routing change.

## Non-goals

- Building anything on the Connect side. This spec stops at the ACE↔OCS boundary, documenting the Connect-side contract but not implementing it.
- Per-page routing inside Connect/connect-labs (e.g., `/opps/<slug>/chat`). That's a future module.
- Creating new OCS entities that aren't needed for ACE's workflow: teams, users, API keys, LLM providers, custom actions, assistants (deprecated per Jon), non-embed channels.
- Supporting multi-LLM-node pipeline templates in v1. The golden template invariant is "exactly one `LLMResponseWithPrompt` node".
- Replacing the OCS web UI for human users. ACE's Playwright backend authenticates and makes HTTP calls — it does not drive forms or clicks through a browser viewport.
- Building a staging OCS instance. Integration tests use whatever OCS dev/staging already exists; if none exists, integration tests run gated against production-with-cleanup.
- OpenAI Assistants support. Jon noted Assistants is likely deprecated; atoms related to assistants are not included in v1 and flagged for reconsideration only if Dimagi re-commits to the feature.

---

## Key findings from the OCS codebase

The design below depends on several non-obvious facts about OCS internals. Each is captured here with a code reference so implementers can verify.

### Clone is a native OCS operation

**`apps/chatbots/views.py:772` — `copy_chatbot`** accepts a POST with `new_name` and calls `experiment.create_new_version(is_copy=True, name=new_name)`. It then async-queues a default version for the copy. The route is `POST /a/<team_slug>/chatbots/<pk>/copy/`. Web-only today; no REST equivalent.

The underlying `create_new_version(is_copy=True)` in `apps/experiments/models.py:900` deep-copies: the experiment row itself, pipelines, static triggers, timeout triggers. It does **not** deep-copy: source_material, consent_form, pre_survey, post_survey (those remain shared references). The copy gets a fresh `public_id` UUID.

**VERIFY during implementation:** whether `ExperimentChannel` rows are deep-copied. Not mentioned in `_copy_pipeline_to_new_version`. If not, `clone_chatbot` needs a post-clone step to create an `EMBEDDED_WIDGET` channel and capture its `widget_token`.

### Pipeline JSON is editable through one clean endpoint

**`apps/pipelines/views.py:319` — `pipeline_data`** is a `GET|POST` endpoint that returns and accepts the full React-Flow graph as JSON:

```
GET  /a/<team_slug>/pipelines/data/<pk>/    → {pipeline: {id, name, data, errors}}
POST /a/<team_slug>/pipelines/data/<pk>/    body: FlowPipelineData JSON
                                              → {data, errors}
```

The POST handler validates the body via `FlowPipelineData.model_validate_json`, sets `pipeline.name` + `pipeline.data`, calls `update_nodes_from_data()`, and returns the refreshed graph plus any validation errors.

**This is the single most load-bearing fact in the design.** It means "edit the chatbot's system prompt" = fetch JSON, mutate one node's `params.prompt`, POST JSON back. No UI automation, no selectors, no node-graph editor driving. Playwright's only job is to hold the authenticated session cookie + CSRF token.

### All per-opportunity edits land on one pipeline node

**`apps/pipelines/nodes/nodes.py:252` — `LLMResponseWithPrompt`** is the pipeline node type that carries the system prompt, RAG attachment, tool wiring, and legacy source material reference. Its params:

- `prompt` — the "system prompt" for the chatbot (at the node level; there is no experiment-level system prompt)
- `source_material_id` — legacy single-blob SourceMaterial FK
- `collection_id` — single "media" collection (file attachment, not RAG)
- `collection_index_ids: list[int]` — the RAG collections searched by the retriever
- `max_results`, `generate_citations` — RAG retrieval params
- `tools`, `custom_actions`, `built_in_tools`, `mcp_tools` — tool wiring
- `history_type`, `synthetic_voice_id` — misc

Because every per-opportunity edit ACE needs is a field on this one node, the Playwright backend's authoring work collapses into two primitives: "clone a chatbot" and "patch LLM node params". Atoms like `ocs_set_system_prompt`, `ocs_attach_knowledge`, and `ocs_set_chatbot_tools` are all variants of the second primitive with different patches.

### OCS has two parallel knowledge mechanisms

| | `SourceMaterial` (legacy) | `Collection` (RAG, modern) |
|---|---|---|
| Storage | Single `TextField` blob | M2M of uploaded `File` objects |
| Retrieval | Prepended to every LLM call | Queried on-demand via pipeline retriever node |
| Attached to experiment via | Direct `experiment.source_material` FK | Pipeline node `params.collection_id` / `collection_index_ids` |
| Chunking/embeddings | None | Yes — `FileChunkEmbedding` per file, or OpenAI vector store |
| Clone behavior | Shared by reference | Shared by reference (via copied pipeline node params) |
| Public API support | Read only (inside experiment retrieve) | None |

ACE uses the Collection path for v1 per Jon's decision. The SourceMaterial atoms (`ocs_set_source_material`) exist in the interface for completeness and future skill use, but no v1 skill wires them.

### Collection mechanics

**`apps/documents/models.py:88` — `Collection`** has:

- `name`, `summary` (the summary helps the LLM decide when to query the collection)
- `files` M2M through `CollectionFile`
- `llm_provider`, `embedding_provider_model`
- `is_index` (whether the collection is searchable) + `is_remote_index` + `openai_vector_store_id`
- Versioning — creating a new Collection version spins up a new vector store and re-uploads files

**`apps/documents/urls.py`** exposes these routes used by the Playwright backend:

- `POST /a/<team>/documents/collection/new/` — create (Django form: CollectionForm)
- `POST /a/<team>/documents/collection/<pk>/` — update
- `POST /a/<team>/documents/collections/<pk>/add_files` — multipart file upload
- `GET /a/<team>/documents/collections/<cid>/files/<fid>/status` — HTMX fragment with `chunk_count`; used for polling indexing completion
- `POST /a/<team>/documents/collections/<pk>/query` — test query (not used by ACE; useful for debugging)

### Connect's embedded widget is a single global chatbot today

**`commcare_connect/templates/base.html:69-79`** renders `<open-chat-studio-widget>` site-wide on every authenticated page. The `chatbot_id` and `chatbot_embed_key` come from Django settings populated by env vars `CHATBOT_ID` and `CHATBOT_EMBED_KEY` (`config/settings/base.py:416-417`). Feature-gated by the `OPEN_CHAT_STUDIO_WIDGET` flag via `chat_widget_context` in `commcare_connect/web/context_processors.py`.

This means Connect has no existing per-opportunity chatbot routing. The Connect-side changes in this spec (Section: Connect Interface Contract) are net-new work, not a refactor.

### Widget auth is anonymous

**`apps/api/authentication.py` — `EmbeddedWidgetAuthentication`** treats the LLO as `AnonymousUser`; the only credential is the embed key. That means OCS cannot correlate sessions back to specific LLOs from the widget alone. See the "Session-to-LLO correlation" note in the Connect contract section.

---

## Architecture

### Composite backend pattern

The MCP server exposes ~22 atoms as tools. Behind the tool registrations is a three-class composite:

```
                              ┌─────────────────────────────────────────┐
                              │           MCP Server (stdio)            │
                              │     Tool registrations: ~22 atoms       │
                              └──────────────────┬──────────────────────┘
                                                 │
                                                 ▼
                              ┌─────────────────────────────────────────┐
                              │           OcsClient (interface)         │
                              │      Capability methods — stable        │
                              └──────────────────┬──────────────────────┘
                                                 │
                                    ┌────────────┴────────────┐
                                    ▼                         ▼
                      ┌─────────────────────┐   ┌──────────────────────────┐
                      │  CompositeBackend   │◄──┤    capability-map.ts     │
                      │  routes by capability│   │   {clone: PLAYWRIGHT,    │
                      └──────┬──────────────┘   │    list_sessions: REST,  │
                             │                  │    ...}                  │
                  ┌──────────┼──────────┐       └──────────────────────────┘
                  ▼                     ▼
      ┌──────────────────┐   ┌────────────────────┐
      │   RestBackend    │   │ PlaywrightBackend  │
      │   API key auth   │   │ Session cookie     │
      │   node-fetch     │   │ + CSRF token       │
      │                  │   │ + page.request     │
      └─────────┬────────┘   └──────────┬─────────┘
                │                       │
                ▼                       ▼
       chatbots.dimagi.com      chatbots.dimagi.com
       /api/...                 /a/<team>/...
```

**Three classes:**

1. **`RestBackend`** handles every atom the public OpenAPI schema supports today. Bearer token auth, stateless HTTP, fast, boring.
2. **`PlaywrightBackend`** handles authoring atoms that require Django session + CSRF. Maintains a lazily-launched headless Chromium context per team as a cookie jar; all HTTP goes through `page.request`. No clicks, no selectors.
3. **`CompositeBackend`** implements `OcsClient`, reads `capability-map.ts` on every call, dispatches to the correct backend. Single source of truth for routing.

**Stability property:** skills consume `OcsClient` methods via MCP tools. They do not know or care whether a call went over REST or Playwright. When OCS ships `POST /api/experiments/`, the composite backend's capability map changes `clone_chatbot: PLAYWRIGHT` to `clone_chatbot: REST`, the `RestBackend.cloneChatbot` method is implemented, and zero skill code changes.

### Directory layout

```
mcp/
  ocs-server.ts                    # MCP entry — tool registrations (existing file, rewritten)
  ocs/
    client.ts                      # OcsClient interface + result/error types
    capability-map.ts              # REST vs PLAYWRIGHT routing + target REST endpoints
    backends/
      rest.ts                      # RestBackend
      playwright.ts                # PlaywrightBackend
      composite.ts                 # CompositeBackend
      pipeline-patch.ts            # Helper: GET → mutate → POST pipeline JSON
    auth/
      playwright-session.ts        # Session cookie + CSRF token lifecycle
      rest-token.ts                # API token loader (env var)
    types.ts                       # Experiment, Collection, Session, PipelineNode DTOs
test/
  mcp/
    ocs/
      composite.test.ts            # Routing + error propagation (mocked backends)
      pipeline-patch.test.ts       # Fixture-based graph mutations (unit)
      rest.test.ts                 # Integration — gated on OCS_INTEGRATION=1
      playwright.test.ts           # Integration — gated on OCS_INTEGRATION=1
```

### Run-time host

The MCP server runs inside the ACE Claude Code plugin process tree. The Playwright context is a singleton inside the server; no separate worker. Playwright adds a Node dependency to `package.json` but no new service or infrastructure.

---

## Capability interface (the atoms)

This is the complete `OcsClient` contract. Every method is also an MCP tool.

### Authoring atoms (10)

| # | Atom | Input | Output | v1 Backend | Target REST |
|---|---|---|---|---|---|
| 1 | `ocs_clone_chatbot` | `{template_id, new_name}` | `{experiment_id, public_id, pipeline_id}` | Playwright | `POST /api/experiments/` (NYI) |
| 2 | `ocs_set_chatbot_system_prompt` | `{experiment_id, prompt}` | `{ok}` | Playwright (pipeline patch) | `PATCH /api/experiments/{id}/prompt/` (NYI) |
| 3 | `ocs_create_collection` | `{name, summary, is_index, is_remote_index, llm_provider?, embedding_model?}` | `{collection_id}` | Playwright | `POST /api/collections/` (NYI) |
| 4 | `ocs_upload_collection_files` | `{collection_id, files: [{name, content, mime_type}]}` | `{file_ids[]}` | Playwright (multipart) | `POST /api/collections/{id}/files/` (NYI) |
| 5 | `ocs_wait_for_collection_indexing` | `{collection_id, timeout_sec?}` | `{ready, files_indexed, pending}` | Playwright (HTMX poll) | `GET /api/collections/{id}/files/{fid}/status/` (NYI) |
| 6 | `ocs_attach_knowledge` | `{experiment_id, collection_index_ids[], max_results?, generate_citations?}` | `{ok}` | Playwright (pipeline patch) | `PATCH /api/experiments/{id}/knowledge/` (NYI) |
| 7 | `ocs_set_chatbot_tools` | `{experiment_id, tools[], custom_actions[], built_in_tools[], mcp_tools[]}` | `{ok}` | Playwright (pipeline patch) | `PATCH /api/experiments/{id}/tools/` (NYI) |
| 8 | `ocs_set_source_material` | `{experiment_id, source_material_id}` | `{ok}` | Playwright (pipeline patch) | `PATCH /api/experiments/{id}/` (NYI) |
| 9 | `ocs_publish_chatbot_version` | `{experiment_id, description}` | `{version_number, task_id}` | Playwright | `POST /api/experiments/{id}/versions/` (NYI) |
| 10 | `ocs_get_chatbot_embed_info` | `{experiment_id}` | `{public_id, embed_key}` | Hybrid — REST for `public_id`, Playwright scrape for `embed_key` | `GET /api/experiments/{id}/embed/` (NYI) |

### Observation atoms (12)

| # | Atom | Input | Output | v1 Backend | REST Endpoint |
|---|---|---|---|---|---|
| 11 | `ocs_list_chatbots` | `{cursor?, page_size?}` | `{chatbots[], next_cursor}` | REST | `GET /api/experiments/` ✓ |
| 12 | `ocs_get_chatbot` | `{experiment_id}` | `{chatbot}` | REST | `GET /api/experiments/{id}/` ✓ |
| 13 | `ocs_list_sessions` | `{experiment_id, since?, tags?, versions?, cursor?, page_size?}` | `{sessions[], next_cursor}` | REST | `GET /api/sessions/` ✓ |
| 14 | `ocs_get_session` | `{session_id}` | `{session, messages[]}` | REST | `GET /api/sessions/{id}/` ✓ |
| 15 | `ocs_end_session` | `{session_id}` | `{ok}` | REST | `POST /api/sessions/{id}/end_experiment_session/` ✓ |
| 16 | `ocs_add_session_tags` | `{session_id, tags[]}` | `{tags[]}` | REST | `POST /api/sessions/{id}/tags/` ✓ |
| 17 | `ocs_remove_session_tags` | `{session_id, tags[]}` | `{tags[]}` | REST | `DELETE /api/sessions/{id}/tags/` ✓ |
| 18 | `ocs_update_session_state` | `{session_id, state}` | `{state}` | REST | `PATCH /api/sessions/{id}/update_state/` ✓ |
| 19 | `ocs_send_test_message` | `{experiment_id, messages[]}` | `{response}` | REST | `POST /api/openai/{id}/chat/completions` ✓ |
| 20 | `ocs_trigger_bot_message` | `{experiment_id, identifier, platform, prompt_text, session_data?, participant_data?}` | `{ok}` | REST | `POST /api/trigger_bot` ✓ |
| 21 | `ocs_update_participant_data` | `{identifier, platform, data[]}` | `{ok}` | REST | `POST /api/participants` ✓ |
| 22 | `ocs_download_file` | `{file_id}` | `{content, filename, mime_type}` | REST | `GET /api/files/{id}/content` ✓ |

### Design notes on the atom set

**Pipeline-patch atoms split intentionally.** Atoms 2, 6, 7, 8 all call the same `pipeline-patch.ts` helper internally. They stay as separate MCP tools because:

1. Atomic split matches the eventual REST split; each will become its own PATCH endpoint.
2. Skills compose them naturally without knowing they touch the same underlying graph.
3. Error attribution is clean — if pipeline save fails on the prompt update, the failing MCP atom name tells you which concept blew up.

**Hybrid atom 10.** `get_chatbot_embed_info` pulls `public_id` from REST and `embed_key` from a Playwright page read. This hybrid is labeled `HYBRID` in the capability map and gets a single target REST endpoint when OCS exposes the embed key.

**Deferred to v2:**

- `ocs_set_source_material` — atom exists, no v1 skill uses it. Kept for completeness.
- OpenAI Assistants atoms (`ocs_attach_assistant`, `ocs_sync_assistant_files`) — not included at all in v1. Jon flagged Assistants as likely deprecated.
- Evaluations, analysis, events, scheduled messages, human annotations — out of scope.

**Explicitly not included:**

- Team, user, API key management.
- LLM provider creation (assumes team has providers configured).
- Non-embed channel creation (WhatsApp, Connect Messaging, Slack, email).
- Custom action creation (atom 7 just selects pre-defined actions by name).

### Capability map sketch

`mcp/ocs/capability-map.ts` is the single source of truth for REST↔Playwright routing. Every atom appears exactly once. Migrating to full REST is a one-line change per row.

```ts
// capability-map.ts (sketch)
export type Backend = 'REST' | 'PLAYWRIGHT' | 'HYBRID';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string;    // documentation of the future REST endpoint
}

export const CAPABILITY_MAP: Record<Capability, CapabilityRoute> = {
  // Authoring (Playwright today)
  clone_chatbot:             { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/' },
  set_chatbot_system_prompt: { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/prompt/' },
  create_collection:         { backend: 'PLAYWRIGHT', restTarget: 'POST /api/collections/' },
  upload_collection_files:   { backend: 'PLAYWRIGHT', restTarget: 'POST /api/collections/{id}/files/' },
  wait_for_collection_indexing: { backend: 'PLAYWRIGHT', restTarget: 'GET /api/collections/{id}/files/{fid}/status/' },
  attach_knowledge:          { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/knowledge/' },
  set_chatbot_tools:         { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/tools/' },
  set_source_material:       { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/' },
  publish_chatbot_version:   { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/{id}/versions/' },
  get_chatbot_embed_info:    { backend: 'HYBRID',     restTarget: 'GET /api/experiments/{id}/embed/' },

  // Observation (REST today)
  list_chatbots:             { backend: 'REST', restTarget: 'GET /api/experiments/' },
  get_chatbot:               { backend: 'REST', restTarget: 'GET /api/experiments/{id}/' },
  list_sessions:             { backend: 'REST', restTarget: 'GET /api/sessions/' },
  get_session:               { backend: 'REST', restTarget: 'GET /api/sessions/{id}/' },
  end_session:               { backend: 'REST', restTarget: 'POST /api/sessions/{id}/end_experiment_session/' },
  add_session_tags:          { backend: 'REST', restTarget: 'POST /api/sessions/{id}/tags/' },
  remove_session_tags:       { backend: 'REST', restTarget: 'DELETE /api/sessions/{id}/tags/' },
  update_session_state:      { backend: 'REST', restTarget: 'PATCH /api/sessions/{id}/update_state/' },
  send_test_message:         { backend: 'REST', restTarget: 'POST /api/openai/{id}/chat/completions' },
  trigger_bot_message:       { backend: 'REST', restTarget: 'POST /api/trigger_bot' },
  update_participant_data:   { backend: 'REST', restTarget: 'POST /api/participants' },
  download_file:             { backend: 'REST', restTarget: 'GET /api/files/{id}/content' },
};
```

---

## Playwright backend design

### Session lifecycle

`PlaywrightBackend` launches one headless Chromium context per OCS team on first use and keeps it alive for the life of the MCP server process. Authentication is a one-time cost; every subsequent call reuses the same cookie jar.

**Auth flow** (`mcp/ocs/auth/playwright-session.ts`):

1. On first call, check for cached session state at `~/.ace/ocs-session-<team_slug>.json` (Playwright's `storageState`). If present and not expired, load it and skip to step 4.
2. If not present, read `OCS_USERNAME` + `OCS_PASSWORD` from env. Navigate to `https://chatbots.dimagi.com/accounts/login/`, fill the form, submit.
3. On success, save `storageState` to disk. Cache lifetime: 24 hours, configurable via `OCS_SESSION_TTL_HOURS`.
4. Fetch `/a/<team_slug>/chatbots/` once to mint a CSRF token. Extract `csrftoken` cookie and store it in the backend instance.
5. All subsequent `page.request` calls send `X-CSRFToken: <token>` and `Referer: https://chatbots.dimagi.com/`.

**SSO fallback.** If `chatbots.dimagi.com` sits behind Dimagi SSO, scripting the SSO flow is out of scope. The fallback is a developer-captured `storageState.json` created once via `npx playwright codegen chatbots.dimagi.com`. Documented in the spec as the recommended v1 developer setup path.

**Interactive re-auth command.** An `ace ocs login` command (`commands/ocs-login.md`) spawns a headed Playwright window for the user to log in interactively when cached state expires. The resulting `storageState` is saved to `~/.ace/ocs-session-<team>.json`.

**Concurrency.** The backend serializes HTTP calls through a simple promise queue so CSRF token rotation and cookie mutation don't race. ACE runs opportunities sequentially, not in parallel; the serialization is fine for v1.

### Pipeline patch helper

The single most important piece of code in the backend. Underpins atoms 2, 6, 7, 8:

```ts
// mcp/ocs/backends/pipeline-patch.ts (sketch)
export async function patchLlmNodeParams(
  ctx: SessionContext,
  pipelineId: number,
  patch: Partial<LlmNodeParams>,
  nodeSelector: (node: FlowNode) => boolean = isLlmResponseWithPrompt,
): Promise<void> {
  // 1. Fetch current graph
  const getRes = await ctx.request.get(
    `/a/${ctx.team}/pipelines/data/${pipelineId}/`
  );
  if (!getRes.ok()) throw new HttpError(getRes.status(), 'pipeline GET failed');
  const graph = (await getRes.json()).pipeline;

  // 2. Locate the target node. Default selector: the single LLMResponseWithPrompt node.
  const targetNodes = graph.data.nodes.filter(nodeSelector);
  if (targetNodes.length !== 1) {
    throw new PipelineShapeError(
      `Expected exactly 1 matching node, found ${targetNodes.length}. ` +
      `Golden template invariant violated for pipeline ${pipelineId}.`
    );
  }

  // 3. Apply patch to node.data.params (React-Flow shape)
  Object.assign(targetNodes[0].data.params, patch);

  // 4. Save graph back
  const postRes = await ctx.request.post(
    `/a/${ctx.team}/pipelines/data/${pipelineId}/`,
    { data: { name: graph.name, data: graph.data } }
  );
  const body = await postRes.json();
  if (body.errors && body.errors.length > 0) {
    throw new PipelineValidationError(body.errors);
  }
}

function isLlmResponseWithPrompt(node: FlowNode): boolean {
  return node.data?.type === 'LLMResponseWithPrompt';
}
```

**Golden template invariant:** exactly one `LLMResponseWithPrompt` node in the pipeline. If the template evolves to have multiple LLM nodes, the `nodeSelector` is extended to match by label (e.g., `node.data.label === 'answerer'`), and the patch API gains a `node_label` field.

### Atom-to-HTTP mapping

Authoritative reference for backend implementation:

| Atom | HTTP operation(s) |
|---|---|
| `clone_chatbot` | 1. `POST /a/<team>/chatbots/<template_id>/copy/` with form `{new_name, csrfmiddlewaretoken}`. Parse redirect `Location` for new `experiment_id`. <br> 2. `GET /api/experiments/<new_id>/` (REST) for `public_id` and related IDs including `pipeline_id`. |
| `set_chatbot_system_prompt` | `patchLlmNodeParams(pipeline_id, { prompt })` |
| `attach_knowledge` | `patchLlmNodeParams(pipeline_id, { collection_index_ids, max_results, generate_citations })` |
| `set_chatbot_tools` | `patchLlmNodeParams(pipeline_id, { tools, custom_actions, built_in_tools, mcp_tools })` |
| `set_source_material` | `patchLlmNodeParams(pipeline_id, { source_material_id })` |
| `create_collection` | `POST /a/<team>/documents/collection/new/` with form `{name, summary, is_index, is_remote_index, llm_provider, embedding_provider_model, csrfmiddlewaretoken}`. Parse redirect for new `collection_id`. |
| `upload_collection_files` | `POST /a/<team>/documents/collections/<id>/add_files` with multipart `files[]` + CSRF. Parse response for `file_ids`. |
| `wait_for_collection_indexing` | Loop: `GET /a/<team>/documents/collections/<cid>/files/<fid>/status` for each file. HTMX fragment carries `chunk_count`. Poll every 2s up to timeout (default 300s). |
| `publish_chatbot_version` | `POST /a/<team>/chatbots/<eid>/versions/create` with form `{description, make_default: true, csrfmiddlewaretoken}`. Returns `task_id` for async version creation. Optionally poll `GET /a/<team>/chatbots/<eid>/versions/status` until complete. |
| `get_chatbot_embed_info` | REST: `GET /api/experiments/<eid>/` → `public_id`. Playwright: `GET /a/<team>/chatbots/<eid>/channels/` → scrape `widget_token` from the EMBEDDED_WIDGET channel row. |

### Error classes

All extend `OcsError` with context useful for retry or human follow-up:

- `SessionExpiredError` — re-auth needed; caller instructed to run `ace ocs login`
- `CsrfTokenMissingError` — transient; token refetched and call retried once
- `PipelineShapeError` — golden template invariant violated; fail loudly, not retryable
- `PipelineValidationError` — server rejected the saved graph; includes server-returned errors list
- `CollectionIndexingTimeoutError` — files never finished embedding within timeout
- `HttpError` — unexpected status code; carries status + path + response body

### Playwright-specific risks

1. **CSRF token rotation.** Django rotates the token on certain events. Backend refetches on any `403 CSRF verification failed` and retries the call once before failing.
2. **Clone channel copy (VERIFY).** If `create_new_version(is_copy=True)` doesn't copy `ExperimentChannel` rows, `clone_chatbot` must create an `EMBEDDED_WIDGET` channel on the clone as a hidden internal step. The MCP atom return tuple stays the same.
3. **Pipeline save validation errors.** The endpoint returns `{errors: [...]}` for invalid graphs (e.g., references to non-existent Collections). Errors surface as `PipelineValidationError` with the server list.
4. **Golden template drift.** If the template pipeline is edited to violate the invariant, `patchLlmNodeParams` fails loudly. A monthly CI job fetches the template pipeline and asserts the invariant; failure pages Jon.

---

## REST backend design

Much simpler than the Playwright side. Thin wrapper around `undici` / `node-fetch` with bearer token auth.

```ts
class RestBackend implements ObservationCapabilities {
  private base = process.env.OCS_BASE_URL ?? 'https://chatbots.dimagi.com';
  private token = process.env.OCS_API_TOKEN!;

  private async request(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new OcsHttpError(res.status, path, await res.text());
    return res.json();
  }

  async listChatbots(opts: ListOpts) {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    params.set('page_size', String(opts.page_size ?? 50));
    return this.request('GET', `/api/experiments/?${params}`);
  }

  // ... one method per observation atom
}
```

**Auth.** `OCS_API_TOKEN` from env. The OpenAPI schema exposes `tokenAuth` on observation endpoints; simpler than OAuth2 and sufficient for ACE's needs.

**Retry policy.** Exponential backoff on 5xx and 429, 3 attempts max. GETs always retry; POSTs retry only if the server signals idempotency (OCS does not today, so POSTs are single-shot).

**Rate limiting.** The chat-poll endpoint throttles at 30s per session. `list_sessions` uses the `since` parameter for incremental polling rather than refetching full history.

**Pagination.** List methods return `{items, next_cursor}`. An async iterator helper `iterateAll(listFn, args)` handles cursor-follow for skills that want the full set.

**Startup verification.** `RestBackend.verify()` hits `GET /api/experiments/?page_size=1` once at server boot. Surfaces auth errors (401/403) immediately with a clear message.

---

## Skill surface changes

Three existing ACE skills consume the MCP. Here's what changes in each.

### `skills/ocs-agent-setup` (rewrite — ~70% new)

Today's version has a "manual workaround" path. After this, the skill runs end-to-end against the MCP:

```
 1. Read opp context from GDrive (IDD, training, app summaries, opp details)
 2. Compose system prompt text + list of files to upload
 3. ocs_clone_chatbot({ template_id: OCS_GOLDEN_TEMPLATE_ID, new_name: "ACE - <opp>" })
    → {experiment_id, public_id, pipeline_id}
 4. ocs_create_collection({
      name: "ACE <opp>",
      summary: "Knowledge base for <opp> - IDD, training, app summaries",
      is_index: true,
      is_remote_index: true
    })
    → {collection_id}
 5. ocs_upload_collection_files({
      collection_id,
      files: [<IDD.pdf>, <training.pdf>, <app-summaries.md>, ...]
    })
 6. ocs_wait_for_collection_indexing({ collection_id, timeout_sec: 300 })
 7. ocs_set_chatbot_system_prompt({
      experiment_id,
      prompt: <composed opp-specific framing>
    })
 8. ocs_attach_knowledge({
      experiment_id,
      collection_index_ids: [collection_id],
      max_results: 20,
      generate_citations: true
    })
 9. (Optional) ocs_set_chatbot_tools({ experiment_id, tools, custom_actions, mcp_tools })
10. ocs_publish_chatbot_version({
      experiment_id,
      description: "Initial ACE version for <opp>"
    })
11. ocs_get_chatbot_embed_info({ experiment_id }) → {public_id, embed_key}
12. Self-evaluate via LLM-as-Judge:
     - ocs_send_test_message for 3-5 canned questions
     - Judge rates correctness + tone
     - Failures block handoff
13. Write {experiment_id, public_id, embed_key, collection_id, pipeline_id, version_number}
    to ACE/<opp-name>/ocs-agent-config.md
14. Hand {public_id, embed_key} to the connect-setup skill for writing to the
    Connect opportunity record
```

**Dry-run behavior.** Every MCP atom call is logged to `comms-log/dry-run-ocs-agent-setup.md`; no HTTP goes out; responses are stubbed.

### `skills/timeline-monitor`

Adds OCS usage for detecting LLOs going quiet or stuck:

- `ocs_list_sessions({ experiment_id, since })` — get recent activity
- `ocs_get_session({ session_id })` — read transcripts for conversations flagged as stuck
- `ocs_trigger_bot_message({ experiment_id, identifier, platform, prompt_text })` — push nudges to inactive LLOs
- `ocs_add_session_tags({ session_id, tags: ['ace-reviewed', 'needs-followup'] })` — mark reviewed sessions

### `skills/flw-data-review`

Adds OCS usage for transcript analysis:

- `ocs_list_sessions({ experiment_id })` — pull full history
- `ocs_get_session({ session_id })` — per-conversation analysis
- `ocs_add_session_tags({ session_id, tags: ['escalated', 'training-gap', 'product-feedback'] })` — categorize transcripts for downstream `learnings-summary` and `llo-feedback` skills

### Configuration surface

One new env group, documented in `.env.example`:

```
OCS_BASE_URL=https://chatbots.dimagi.com
OCS_TEAM_SLUG=dimagi            # team that owns ACE chatbots — VERIFY
OCS_API_TOKEN=<token>           # REST backend auth
OCS_GOLDEN_TEMPLATE_ID=<int>    # integer experiment ID of the ACE golden template
OCS_USERNAME=<user>             # Playwright backend auth (if not using storageState)
OCS_PASSWORD=<password>
OCS_SESSION_TTL_HOURS=24
ACE_SESSION_STATE_DIR=~/.ace    # Playwright session state storage
```

`playbook/integrations/ocs-integration.md` gets rewritten from its current "open questions" state to reflect the live capability map and environment documentation.

---

## Connect-side interface contract

Per the user's decision (brainstorm question 4, option C), this spec stops at the ACE↔OCS boundary but documents the Connect changes tightly enough that whoever picks up the Connect work has no ambiguity.

### Two new fields on the Opportunity model

```python
# commcare_connect/opportunity/models.py (diff)
class Opportunity(models.Model):
    ...
    ace_chatbot_public_id = models.UUIDField(null=True, blank=True)
    ace_chatbot_embed_key = models.CharField(max_length=255, blank=True, default="")
```

Both values come from ACE via `ocs_get_chatbot_embed_info` and are written through whatever Connect API the `connect-setup` skill already uses to configure opportunities.

### Context processor change

Current `commcare_connect/web/context_processors.py:chat_widget_context`:

```python
def chat_widget_context(request):
    creds_configured = bool(settings.CHATBOT_ID and settings.CHATBOT_EMBED_KEY)
    return {
        "chat_widget_enabled": creds_configured and Flag.is_flag_active_for_request(request, OPEN_CHAT_STUDIO_WIDGET),
        "chatbot_id": settings.CHATBOT_ID,
        "chatbot_embed_key": settings.CHATBOT_EMBED_KEY,
    }
```

After: look up the current opportunity from `request` (Connect already attaches it — see `session_tracking_context._get_additional_tracking_context` in the same file). If the opportunity has `ace_chatbot_public_id`, return ACE's values; otherwise fall back to the global settings.

```python
def chat_widget_context(request):
    opportunity = getattr(request, "opportunity", None)
    if opportunity and opportunity.ace_chatbot_public_id:
        chatbot_id = str(opportunity.ace_chatbot_public_id)
        embed_key = opportunity.ace_chatbot_embed_key
    else:
        chatbot_id = settings.CHATBOT_ID
        embed_key = settings.CHATBOT_EMBED_KEY

    creds_configured = bool(chatbot_id and embed_key)
    return {
        "chat_widget_enabled": creds_configured and Flag.is_flag_active_for_request(request, OPEN_CHAT_STUDIO_WIDGET),
        "chatbot_id": chatbot_id,
        "chatbot_embed_key": embed_key,
    }
```

This is the entirety of the Connect-side code change: two model fields + one context processor edit + one migration.

### Rollout path

1. **Phase 0 (today).** Connect has one global bot. Widget gated by `OPEN_CHAT_STUDIO_WIDGET` flag for select orgs.
2. **Phase 1 (this spec).** ACE creates per-opp bots and writes `{public_id, embed_key}` to the Opportunity model. Connect's context processor reads them with fallback. Orgs without ACE-managed opps see zero change.
3. **Phase 2 (future).** Deeper per-page routing (e.g., `/opps/<slug>/chat` as a dedicated chat surface) is a connect-labs concern — out of scope.

### Session-to-LLO correlation

Today the widget authenticates anonymously to OCS (`EmbeddedWidgetAuthentication` → `AnonymousUser`). OCS cannot correlate sessions back to specific LLOs from the widget alone.

**Recommended path.** When the widget starts a session via `POST /api/chat/start/`, Connect-side JS inspects `request.user` and passes identifying data as `participant_data`. OCS's start endpoint already supports a `participant` field. ACE's `ocs_get_session` then returns participant data for `flw-data-review` to correlate.

**Fallback.** `ocs_update_participant_data` called server-side from Connect after login, mapping Connect user → OCS participant identifier. Less clean but works.

Either path is **Connect-side work**, not ACE-side. Documented here for interface clarity.

---

## Ops, testing, and observability

### Idempotency and re-run semantics

- `ocs_clone_chatbot` is NOT idempotent. Skills must check before calling — convention: call `ocs_list_chatbots` and filter by `name == "ACE - <opp>"`. If found, return that `experiment_id` instead of cloning.
- `ocs_create_collection` same pattern — check by name first.
- `ocs_upload_collection_files` is safe to re-call; it appends. Re-runs add new file versions; indexing catches up.
- Pipeline patch atoms are naturally idempotent — same input yields same result.
- `ocs_publish_chatbot_version` creates a new version each call. Convention: only publish once per ACE run, near the end of `ocs-agent-setup`.

ACE's state file `ACE/<opp-name>/ocs-agent-config.md` records the IDs after first successful setup. Subsequent runs read it first and skip creation steps if IDs are present, jumping to "patch what's changed" semantics.

### Testing strategy

- **`composite.test.ts`** (unit, mocked backends) — verifies routing table is honored; tests hybrid atom fallback; tests error propagation. Fast; runs on every commit.
- **`pipeline-patch.test.ts`** (unit, fixture-based) — loads a sample pipeline JSON fixture (captured from a real `pipeline_data` GET), runs each patch type, asserts mutation. No network. Catches node-finding and patch-application regressions.
- **`rest.test.ts`** (integration, gated on `OCS_INTEGRATION=1`) — hits a real OCS dev instance with a real token; creates, lists, retrieves, tags, deletes a session. Opt-in for pre-merge and nightly.
- **`playwright.test.ts`** (integration, gated on `OCS_INTEGRATION=1`) — authenticates, clones a test template, creates a throwaway collection, uploads a tiny PDF, patches the pipeline, publishes a version, cleans up. Idempotent.
- **End-to-end.** `skills/ocs-agent-setup` exercises a `--dry-run` in ACE's skill test harness. First real E2E against live OCS is manual until the Playwright integration tests are green.

### Observability

Every MCP atom call emits a structured log line to `~/.ace/logs/ocs-mcp.jsonl`:

```json
{"ts":"2026-04-08T14:23:11Z","atom":"clone_chatbot","backend":"PLAYWRIGHT","duration_ms":1847,"result":"ok","experiment_id":523}
```

Errors include the error class and stack. The `/ace:status` command reads this file to surface recent OCS activity per opportunity.

---

## Open verification items

Must be resolved during implementation. None block the design.
Status annotations were added after the initial implementation pass shipped (2026-04-08) and updated after the post-merge verification pass (2026-04-09) that read the OCS source code directly to resolve several items without needing live access.

1. **[RESOLVED]** **Clone channel copy behavior.** `Experiment.create_new_version(is_copy=True)` in `apps/experiments/models.py:895` deep-copies the Experiment row, pipeline, static_triggers, and timeout_triggers — but **never touches `ExperimentChannel` rows**. `ExperimentChannel.experiment` is a `ForeignKey(CASCADE)`, so the clone starts with zero channels. `EMBEDDED_WIDGET` is also not in `team_global_platforms()` (`apps/channels/models.py:39`), so per-experiment widget channels are allowed. **Fix shipped:** `PlaywrightBackend.cloneChatbot` now POSTs to `/a/<team>/chatbots/<new_id>/channels/create-dialog/embedded_widget/` immediately after the clone to establish the widget channel. The `widget_token` is auto-generated server-side via `secrets.token_urlsafe(24)` in `EmbeddedWidgetChannelForm.clean()`.
2. **[RESOLVED]** **Embed key scrape path.** The `widget_token` is rendered by `templates/channels/widgets/widget_params.html` as `<input type="text" id="widget_token" value="{{ widget.token }}" ...>`. The previous `data-widget-token="..."` regex was wrong. **Fix shipped:** `extractWidgetToken` regex updated to `/id="widget_token"[^>]*value="([^"]+)"/`. The template is embedded in the channel *edit-dialog* view, not the channels list — so `getChatbotEmbedInfo` now does a 3-hop scrape (home page → find channel_id from the channel button's `hx-get` URL → GET edit-dialog → scrape token).
3. **[PENDING]** **LLM provider and embedding model defaults.** The `createCollection` atom accepts `llm_provider` and `embedding_model` as optional numeric IDs but does not discover defaults. When a live OCS team is connected, confirm what defaults to use (likely the team's default provider). May need a `list_llm_providers` atom if defaults can't be hardcoded — not added in v1.
4. **[RESOLVED]** **CSRF extraction method.** `extractCsrfToken` in `mcp/ocs/auth/playwright-session.ts` reads the `csrftoken` cookie and the `PlaywrightBackend` passes it as `X-CSRFToken` — both match Django's defaults. Unit-tested. Plus the production request closure in `ocs-server.ts` refetches on 403 and retries once.
5. **[DEFERRED]** **OpenAI Assistants status.** No v1 atoms touch assistants. Revisit if Dimagi re-commits to the feature.
6. **[PENDING]** **Live Connect OCS bot inspection.** When Jon has access, pull the live pipeline via `GET /a/<team>/pipelines/data/<pipeline_id>/` and document: node topology, system prompt text, tools, Collection attachment, LLM provider + model, embedding model. Validates the golden-template-as-fork-of-Connect-bot approach and may surface a second LLM node that would break the invariant.
7. **[PENDING]** **Team slug.** `OCS_TEAM_SLUG=dimagi` is the default in `.env.example` but not confirmed. Affects every URL constructed by the Playwright backend.
8. **[PARTIALLY RESOLVED]** **Session state storage path.** `~/.ace/ocs-session-<team>.json` is wired into `PlaywrightSession`. Works on a local workstation; sandbox permissions under the Claude Code plugin runtime still need to be verified the first time the MCP server is driven in that environment.
9. **[PENDING]** **Golden template creation as a prerequisite.** Documented as a one-time manual bootstrap in `skills/ocs-agent-setup/SKILL.md` (expects `OCS_GOLDEN_TEMPLATE_ID`) and `.env.example`. The template itself does not exist yet — Jon needs to clone the live Connect bot, add ACE-specific framing (escalation rules, per-opp placeholder prompt), and record the integer experiment ID.
10. **[PENDING]** **SSO flow for `chatbots.dimagi.com`.** The `/ocs:login` command (`commands/ocs-login.md`) uses a headed-browser manual-login flow that handles SSO naturally. Scripted `OCS_USERNAME` + `OCS_PASSWORD` login is present as a fallback but not exercised; prod auth shape TBD on first run.
11. **[RESOLVED]** **`pipeline_id` discovery.** The OCS REST API's `Experiment` schema (`api-schema.yml:1086-1112`) has only 5 fields — `id` (UUID), `name`, `url`, `version_number`, `versions`. **No `pipeline_id`.** Worse, the `id` field is the UUID `public_id` (not the integer DB id), because `apps/api/views/experiments.py:36` sets `lookup_field = "public_id"`. **Fix shipped:** `PlaywrightBackend.pipelineIdFor` now scrapes from `/a/<team>/chatbots/<integer_id>/edit/`, which renders `SiteJS.pipeline.renderPipeline("#pipelineBuilder", "<team>", <pipeline_id>)` inline (`templates/pipelines/pipeline_builder.html`). Regex: `/renderPipeline\("#pipelineBuilder",\s*"[^"]+",\s*(\d+)\)/`. The result is cached per experiment_id and populated eagerly by `cloneChatbot`.
12. **[PENDING]** **Rate limits on the OCS web routes.** The Playwright backend hits Django views that weren't designed for programmatic use. The `RestBackend` implements exponential backoff on 5xx/429 for GETs; the Playwright backend does not retry. Verify on a dev instance before running against production.
13. **[RESOLVED]** **`uploadCollectionFiles` multipart.** Django's `add_collection_files` view parses `request.FILES`, which requires `multipart/form-data`. **Fix shipped:** `RequestFn` gained an optional 4th `options` arg with a `multipart` channel; `PlaywrightBackend.uploadCollectionFiles` routes through it; the production request closure in `ocs-server.ts` builds a real `FormData` with each file under the repeated `files` field name (Django's `request.FILES.getlist("files")` semantics). Unit test asserts the multipart option is used instead of a JSON body.
14. **[RESOLVED, critical post-merge finding]** **REST endpoints use UUID, not integer.** The initial implementation assumed `/api/experiments/<id>/` took the integer DB id. It actually takes the UUID `public_id`. The `Experiment` type's `id` field was typed as `number` when the API returns a string UUID. **Fix shipped:** `Experiment.id: string`, `getChatbot({ public_id })`, and `listChatbots` return UUID ids. Integer ids live on a new `ClonedChatbot` type (returned by `cloneChatbot` and tracked in skill state) and are only used for web-route URLs.
15. **[RESOLVED, critical post-merge finding]** **`cloneChatbot` JSON-parse-of-redirect.** The initial implementation did `await copyRes.json()` to get `{experiment_id}`. `copy_chatbot` in `apps/chatbots/views.py:772` actually returns a 302 redirect to `single_chatbot_home`; there is no JSON body. **Fix shipped:** `RequestFn` options now include `followRedirects: false`; `cloneChatbot` disables redirect-following, reads the `Location` header, and parses the integer id from `/chatbots/(\d+)/`. Then scrapes `public_id` from the chatbot home page and `pipeline_id` from the edit page before creating the widget channel.

### Plan bugs caught and fixed during implementation

Three latent issues in the plan surfaced during the TDD runs and were fixed inline:

- **Missing `tsconfig.json`.** The plan's per-file `npx tsc` checks worked without a project config, but the `client.ts` file's `Buffer` type required `@types/node` resolution. A minimal `tsconfig.json` was added during Task 6 (OcsClient interface) with `types: ["node"]`, pulling forward what Tasks 2/3 had deferred.
- **`res.json()` on empty bodies.** The `RestBackend.request` helper originally called `res.json()` unconditionally, which throws `SyntaxError: Unexpected end of JSON input` on POSTs like `trigger_bot` and `end_session` that return empty 200s. Fixed during Task 8 by awaiting `res.text()` first and returning `undefined` when empty.
- **Local `Cookie` interface conflicted with Playwright's `Cookie` type.** The initial `Cookie` interface in `playwright-session.ts` had an `[key: string]: unknown` index signature, which Playwright's strict `Cookie` type (no index signature) wouldn't unify with. Simplified to `{ name: string; value: string }` during Task 10.

---

## References

### ACE repo (this worktree)

- `skills/ocs-agent-setup/SKILL.md` — current manual workaround skill; to be rewritten
- `mcp/ocs-server.ts` — current scaffold with all tools returning `not_implemented`; to be rewritten
- `playbook/integrations/ocs-integration.md` — current "open questions" doc; to be rewritten from this spec
- `docs/superpowers/specs/2026-04-01-ace-design.md` — overall ACE architecture
- `docs/superpowers/specs/2026-04-07-ace-web-harness-design.md` — the related ace-web design

### dimagi/open-chat-studio

- `api-schema.yml` — authoritative OpenAPI schema (used for atom inventory)
- `apps/chatbots/views.py:772` — `copy_chatbot` (the clone entry point)
- `apps/chatbots/urls.py` — chatbot CRUD routes including `copy`, `versions/create`
- `apps/experiments/models.py:552` — `Experiment` model
- `apps/experiments/models.py:900` — `create_new_version(is_copy=True)` clone logic
- `apps/experiments/versioning.py:299` — `VersionsMixin`
- `apps/pipelines/views.py:319` — `pipeline_data` GET/POST endpoint (the load-bearing fact)
- `apps/pipelines/nodes/nodes.py:252` — `LLMResponseWithPrompt` node type
- `apps/documents/models.py:88` — `Collection` model
- `apps/documents/urls.py` — Collection + DocumentSource + file upload routes
- `apps/documents/views.py:352` — `add_collection_files`
- `apps/api/authentication.py` — `EmbeddedWidgetAuthentication` for widget credentials
- `templates/experiments/share/widget.html` — the widget embed template

### dimagi/commcare-connect

- `commcare_connect/templates/base.html:69-79` — global widget render
- `commcare_connect/web/context_processors.py:chat_widget_context` — the function to extend
- `config/settings/base.py:416-417` — `CHATBOT_ID` + `CHATBOT_EMBED_KEY` env vars
- `commcare_connect/flags/flag_names.py` — `OPEN_CHAT_STUDIO_WIDGET` feature flag
- `deploy/roles/connect/templates/docker.env.j2` — env template (actual values in ansible secrets)

---

## Change log

| Date | Change | Author |
|---|---|---|
| 2026-04-08 | Initial draft from brainstorming session | Jon + Claude |
