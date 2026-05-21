# OCS MCP Atoms: REST vs. Playwright Analysis Report

**Date:** 2026-05-21  
**Scope:** Research for 5 new MCP atoms required for OCS (Open Chat Studio) chatbot authoring in Connect Interviews program  
**Methodology:** Analysis of OCS GitHub codebase (Django views, URL patterns, REST API) + existing Playwright atom patterns in ACE repo

## Executive Summary

All 5 atoms require **Playwright form-POST backends** because OCS does not expose these operations via public REST endpoints. The operations interact with form views (Django views with POST form handling) rather than JSON REST APIs:

1. **ocs_create_chatbot** — No dedicated creation endpoint; cloning is the standard path
2. **ocs_add_pipeline_node** — Must manipulate pipeline JSON graph directly via `/pipelines/data/`
3. **ocs_add_chatbot_event** — Event creation is form-based view, not REST
4. **ocs_add_custom_action** — Custom action CRUD is form-based, not REST
5. **ocs_link_action_to_node** — Node wiring is graph manipulation, not standalone endpoint

The existing **cloneChatbot** atom demonstrates the working pattern: form POST with CSRF token, HTML scraping for result IDs, and 302 redirect following.

---

## Per-Atom Analysis

### 1. ocs_create_chatbot

**Purpose:** Create a new chatbot from scratch (not by cloning)

| Field | Value |
|-------|-------|
| **Endpoint(s)** | `/a/<team>/chatbots/new/` (form view) |
| **Method** | POST form-encoded |
| **Auth** | CSRF token (form POST pattern) |
| **Backend** | Playwright (form view, no JSON endpoint) |
| **Recommendation** | Playwright with form POST |
| **Complexity** | Medium |

**Findings:**

- OCS has no `/api/experiments/` POST endpoint for creation (examined `apps/api/views/experiments.py`)
- Creation is form-driven: `apps/experiments/views/experiment.py` has `CreateChatbot` view that parses `request.POST`
- Form fields: name, description, and related model choices (templates, etc.)
- Response: 302 redirect to `single_chatbot_home` on success; 200 re-render on validation failure
- Extract `experiment_id` from Location header (pattern proven by existing `cloneChatbot` atom, line 564)

**Cost:** 1 form POST + 1 HTML scrape (home page for public_id if needed) = ~2 HTTP calls

---

### 2. ocs_add_pipeline_node

**Purpose:** Add a node (router, LLM, or Python) to an existing pipeline

| Field | Value |
|-------|-------|
| **Endpoint(s)** | `/a/<team>/pipelines/data/<id>/` (JSON GET/POST) |
| **Method** | GET (read pipeline) → POST (write modified graph) |
| **Auth** | CSRF token (via Playwright request.post in form-encoded or JSON mode) |
| **Backend** | Playwright (JSON manipulation, not UI form) |
| **Recommendation** | Playwright with JSON POST (no form encoding) |
| **Complexity** | Medium-High |

**Findings:**

- Pipeline structure is a single JSON blob stored in the database
- The `/pipelines/data/<id>/` endpoint (verified in `pipeline-patch.ts:69`, line 69) handles both GET (read current graph) and POST (save modified graph)
- Existing atoms demonstrate the pattern: `patchLlmNodeParams` (line 64) reads via GET, modifies the graph object, and POSTs back
- Form fields in POST: `{ name: string, data: FlowGraph }`
- Response: 200 with JSON containing validation errors (if any), not a redirect

**Implementation Notes:**
- Flow graph structure has `nodes: FlowNode[]` and `edges: FlowEdge[]`
- Node creation: add entry to graph.nodes with appropriate `data.type` ("DynamicRouterNode", "LLMResponseWithPrompt", "PythonNode")
- Edge creation: add entry to graph.edges linking source → target node ids
- Validation errors returned in POST response, not 302 redirects

**Cost:** 1 GET + 1 POST = 2 HTTP calls (no HTML scraping needed)

---

### 3. ocs_add_chatbot_event

**Purpose:** Attach an event trigger to a chatbot (24-hour inactivity timeout)

| Field | Value |
|-------|-------|
| **Endpoint(s)** | `/a/<team>/chatbots/<id>/events/create/` (form view) |
| **Method** | POST form-encoded |
| **Auth** | CSRF token (form POST pattern) |
| **Backend** | Playwright (form view) |
| **Recommendation** | Playwright with form POST |
| **Complexity** | Medium |

**Findings:**

- OCS has event trigger views in `apps/events/views.py` (examined via GitHub)
- Trigger types: `StaticTrigger` (immediate), `TimeoutTrigger` (after N hours of inactivity)
- Event creation is form-based: `apps/events/forms.py` has `EventForm` parsing `request.POST`
- Form fields: event_type (select), threshold_hours (for TimeoutTrigger), action_id (FK to custom action)
- Response: 302 redirect to chatbot home on success; 200 re-render on validation failure
- No REST `/api/events/` endpoint exists for creation

**Cost:** 1 form POST + optional HTML scrape = 1-2 HTTP calls

---

### 4. ocs_add_custom_action

**Purpose:** Create a custom action that fires on node decision or event trigger

| Field | Value |
|-------|-------|
| **Endpoint(s)** | `/a/<team>/custom-actions/new/` (form view) |
| **Method** | POST form-encoded |
| **Auth** | CSRF token (form POST pattern) |
| **Backend** | Playwright (form view) |
| **Recommendation** | Playwright with form POST |
| **Complexity** | Medium |

**Findings:**

- OCS has custom action CRUD in `apps/custom_actions/views.py`
- No public REST endpoint for creation (no `/api/custom-actions/` POST found)
- Creation is form-driven: `CustomActionForm(request.POST)` in views
- Form fields: name, description, target_url, request_body_template, http_method, headers
- Response: 302 redirect to action detail page on success; 200 re-render on validation failure
- Extract `custom_action_id` from Location header

**Cost:** 1 form POST + optional HTML scrape = 1-2 HTTP calls

---

### 5. ocs_link_action_to_node

**Purpose:** Wire a custom action to a node trigger (fire action when node makes a decision)

| Field | Value |
|-------|-------|
| **Endpoint(s)** | `/a/<team>/pipelines/data/<id>/` (JSON manipulation) |
| **Method** | GET (read pipeline) → POST (write modified graph) |
| **Auth** | CSRF token (via Playwright request.post) |
| **Backend** | Playwright (JSON graph manipulation) |
| **Recommendation** | Playwright with JSON POST (same as ocs_add_pipeline_node) |
| **Complexity** | Medium |

**Findings:**

- No dedicated "attach action" endpoint — action wiring is part of the pipeline graph structure
- Action attachment is stored in the node's configuration: `node.data.config.actions` or similar
- Implementation follows same pattern as node addition: GET `/pipelines/data/<id>/` → modify graph → POST back
- Graph nodes have trigger configurations that reference custom_action_id
- Response: 200 with validation errors in JSON, not redirects

**Cost:** 1 GET + 1 POST = 2 HTTP calls

---

## Summary: REST vs. Playwright Decision Matrix

| Atom | REST Endpoint | Justification | Backend |
|------|---------------|---------------|---------|
| **ocs_create_chatbot** | ❌ No | Form view only; no `/api/experiments/` POST | Playwright |
| **ocs_add_pipeline_node** | ✓ Yes | `/pipelines/data/<id>/` is JSON POST | Playwright\* |
| **ocs_add_chatbot_event** | ❌ No | Form view only; no `/api/events/` POST | Playwright |
| **ocs_add_custom_action** | ❌ No | Form view only; no `/api/custom-actions/` POST | Playwright |
| **ocs_link_action_to_node** | ✓ Yes | `/pipelines/data/<id>/` is JSON POST | Playwright\* |

\* **Note on "REST with Playwright":** The `/pipelines/data/` endpoint accepts JSON and returns JSON, making it "REST-shaped" at the wire level. However, OCS requires CSRF tokens on POST (Django middleware), which means the Playwright `request` object must be used instead of a raw HTTP client. This is the same pattern used by existing atoms like `patchLlmNodeParams`. From an MCP perspective, this is still a Playwright atom because the transport requires session cookies and CSRF tokens sourced from the Playwright session.

---

## Implementation Patterns (Proven by Existing Atoms)

### Pattern 1: Form POST with 302 Redirect (ocs_create_chatbot, ocs_add_chatbot_event, ocs_add_custom_action)

```typescript
// Step 1: POST form data with CSRF token
const res = await this.opts.request(
  'POST',
  '/a/<team>/<resource>/create/',
  {
    field1: value1,
    field2: value2,
    csrfmiddlewaretoken: this.opts.csrfToken,
  },
  { followRedirects: false, formEncoded: true }
);

// Step 2: Check for 302 or validation failure (200)
if (res.status === 200) throw new Error('Validation failed');
if (res.status !== 302 && !res.ok) throw new Error('Create failed');

// Step 3: Extract ID from Location header
const id = extractIdFromLocation(res.headers?.location);
return { id };
```

**Proven by:** `cloneChatbot` (line 548-564), `createCollection` (line 382-390)

---

### Pattern 2: JSON Graph Manipulation (ocs_add_pipeline_node, ocs_link_action_to_node)

```typescript
// Step 1: GET current pipeline
const getRes = await ctx.request('GET', `/a/<team>/pipelines/data/<id>/`);
const payload = await getRes.json();
const graph = payload.pipeline.data;

// Step 2: Modify graph (add node or edge)
graph.nodes.push({ id: 'new-node', data: { type: 'NodeType', params: {} } });
// OR
graph.edges.push({ source: 'node-a', target: 'node-b' });

// Step 3: POST modified graph
const postRes = await ctx.request('POST', `/a/<team>/pipelines/data/<id>/`, {
  name: payload.pipeline.name,
  data: graph,
});

// Step 4: Check for validation errors in response
const errors = extractPipelineErrors(await postRes.json());
if (errors.length > 0) throw new Error(errors);
```

**Proven by:** `patchLlmNodeParams` (line 64-91), `validatePipeline` (line 128-149)

---

## Cost Analysis

| Atom | HTTP Calls | Type | Total Cost |
|------|-----------|------|------------|
| ocs_create_chatbot | 2 | Form POST + HTML scrape | ~60KB |
| ocs_add_pipeline_node | 2 | JSON GET + POST | ~100KB (pipeline blob) |
| ocs_add_chatbot_event | 1-2 | Form POST ± scrape | ~30KB |
| ocs_add_custom_action | 1-2 | Form POST ± scrape | ~30KB |
| ocs_link_action_to_node | 2 | JSON GET + POST | ~100KB (pipeline blob) |

**Total per-operation range:** 1-2 HTTP calls per atom (except pipeline ops which require read-modify-write)

---

## Verification Against Checklist Schema

The checklist (`docs/connect-interviews/checklist-schema.yaml`) lists these atoms with `gap: null` (line 1214-1218), meaning they need to be built. The verification rules specify:

- **ocs-bot-has-router-node:** Verify `pipeline_has_node(type=router)` — requires reading the full pipeline graph (GET `/pipelines/data/`)
- **ocs-bot-has-24hr-timeout-event:** Verify `chatbot_has_event(type=inactivity_timeout)` — requires reading chatbot events
- **ocs-bot-has-completion-action:** Verify `chatbot_has_custom_action(name_contains="Session Completion")` — requires reading chatbot actions

All of these are read operations on the chatbot/pipeline structure, which the existing `ocs_get_chatbot` and graph-read operations already provide.

---

## Recommendations

1. **Start with ocs_add_pipeline_node:** This is the foundation for creating the Dynamic Router, LLM, and Python nodes. Use the proven `patchLlmNodeParams` pattern as a template.

2. **Use Form POST Atoms for CRUD:** All form-based atoms (create_chatbot, add_event, add_custom_action) follow the same pattern as `cloneChatbot`. Build them in parallel once the first one is complete.

3. **Reuse Pipeline Manipulation:** The `ocs_link_action_to_node` atom will use the same `/pipelines/data/` read-modify-write pattern as node addition.

4. **CSRF Token Management:** All atoms require the CSRF token from the Playwright session. Verify the existing `opts.csrfToken` pattern is properly initialized in the session setup.

5. **Test Against Real OCS:** HTML scraping regexes are fragile to template changes. Each atom should include unit tests matching real OCS DOM shapes (as done in `playwright-backend.test.ts`).

---

## Conclusion

All 5 atoms require Playwright backends due to OCS's form-driven (not REST API-driven) architecture for chatbot and event/action management. However, the pipeline manipulation endpoints (`/pipelines/data/`) are JSON-based and follow a clean read-modify-write pattern. Existing code patterns are sufficient to implement all 5 atoms without discovering new endpoints or authentication mechanisms.

**Estimated implementation time:** 2-3 days for an experienced developer familiar with Playwright + OCS form patterns, assuming tests are comprehensive.
