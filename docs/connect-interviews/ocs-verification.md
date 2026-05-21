# OCS Verification Notes (post-source-review)

The initial `ocs-probe-report.md` was generated via `gh search` + `gh api` calls without local source access. Several claims turned out to be wrong or incomplete. This doc captures findings from reading the actual OCS source (cloned to `/tmp/ace-refs/ocs/`, commit on `main` as of 2026-05-21).

Where this doc and `ocs-probe-report.md` disagree, **this doc wins**.

## Status of the 5 OCS authoring atoms

| Atom | Status | URL / Mechanism (verified) | Notes |
|---|---|---|---|
| `ocs_create_chatbot` | **shipped + verified** | POST `/a/<team>/chatbots/new/`, fields `name` + `description`. Success → 302 to `/a/<team>/chatbots/<id>/edit/`. | Works first try. |
| `ocs_add_pipeline_node` | **shipped + verified** | GET/POST `/a/<team>/pipelines/data/<id>/`. | Required FlowNode + FlowEdge shape per `apps/pipelines/flow.py`. |
| `ocs_add_chatbot_event` | **design verified, not yet built** | POST `/a/<team>/chatbots/<experiment_id>/events/timeout/new/` (or `/static/new/` for static). | Multi-form combined POST; see below. |
| `ocs_add_custom_action` | **design verified, not yet built** | POST `/a/<team>/actions/new/` ← *not* `/custom-actions/` as probe report said. | OpenAPI-schema-driven, not simple webhook config. |
| `ocs_link_action_to_node` | **design verified, not yet built** | Same `/pipelines/data/<id>/` GET/POST. Modify `data.params.custom_actions` on the target node. | Strings are `<action_id>:<operation_id>` composites. |

## FlowNode / FlowEdge schema (load-bearing)

Source: `apps/pipelines/flow.py:11-30`

```python
class FlowNodeData(pydantic.BaseModel):
    id: str
    type: str
    label: str = ""
    params: dict = {}

class FlowNode(pydantic.BaseModel):
    id: str
    type: Literal["pipelineNode", "startNode", "endNode"] = "pipelineNode"
    position: dict = {}
    data: FlowNodeData

class FlowEdge(pydantic.BaseModel):
    id: str
    source: str
    target: str
    sourceHandle: str | None = STANDARD_OUTPUT_NAME  # "output"
    targetHandle: str | None = STANDARD_INPUT_NAME   # "input"
```

**Implications confirmed:**

- Each node carries **both** a top-level `type` (`"startNode"` | `"endNode"` | `"pipelineNode"`) AND `data.type` (the OCS class name).
- `data.id` is **required** and must match the top-level `id`.
- Edges' `sourceHandle` / `targetHandle` default to `"output"` / `"input"` — explicit values needed only for multi-output nodes (router branches use `"output_0"`, `"output_1"`, …).
- If shape is invalid, OCS server-side **500s with HTML error page** instead of returning a clean JSON validation error. The pipeline-save view's pydantic ValidationError is not caught — that's an upstream UX bug worth filing.

## OCS pipeline-save validates AFTER commit

When the shape is valid but a node's params fail validation (e.g. StaticRouterNode without `route_key`), OCS returns `200 OK` **and persists the broken state**. Errors surface only in the response body under `errors.node.<node-id>.<field>`.

This is permanent behavior we have to work around. The `addPipelineNode` helper raises `PipelineValidationError` from those response errors, but the broken state is already persisted. **Callers must clean up partial state on retry** — the `probe-ocs-reset-pipeline.ts` shape (strip non-canonical nodes + rewrite edges) is the reference recovery.

## Routing node — correct class name

`DynamicRouterNode` **does not exist** in OCS. The "Dynamic Router Bot" in the Connect Interviews tech doc maps to OCS's `StaticRouterNode` (routes by participant_data field values via a `keywords[]` array, not by LLM judgment).

Source: `apps/pipelines/nodes/nodes.py` defines `RouterNode` (LLM-driven) and `StaticRouterNode` (rule-based). Schema fixtures in `apps/pipelines/tests/node_schemas/`.

**StaticRouterNode params** (required: `name`, `route_key`):

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | — | required |
| `route_key` | string | — | required; the key within `data_source` to read |
| `data_source` | string | `participant_data` | also accepts `temp_state` |
| `keywords` | string[] | — | list of values to route on |
| `default_keyword_index` | integer | 0 | which output handle takes unmatched routes |
| `tag_output_message` | boolean | false | |

For Connect Interviews: `route_key: "interview_id"`, `keywords: [<schedule's interview_ids>]`.

## Event creation — multi-form combined POST

Source: `apps/events/views.py:_create_event_view` (lines 35-74).

**One POST combines THREE forms:**

1. **Trigger form** — `TimeoutTriggerForm` or `StaticTriggerForm`. Fields per `apps/events/forms.py`:
   - TimeoutTrigger: `delay` (TimePeriod choice), `total_num_triggers`, `trigger_from_first_message`
   - StaticTrigger: `type` (event-type choice)
2. **EventActionForm** — single field `action_type` (choice). Allowed values from `ACTION_PARAMS_FORMS`:
   - `log` → no params
   - `send_message_to_bot` → `message_to_bot` text
   - `end_conversation` → no params
   - `schedule_trigger` → many params (`name`, `prompt_text`, `frequency`, `time_period`, `repetitions`, `experiment_id`)
   - `pipeline_start` → `pipeline_id`, `input_type`
3. **Action-params form** — chosen by `action_type` via `build_action_params_form()`. Fields per the action.

**There is NO `"custom_action"` value in `ACTION_PARAMS_FORMS`.** This contradicts the Connect Interviews tech doc's claim that "after 24-hour timeout, a custom action fires from OCS back to HQ." See the architectural-mismatch section below.

**Success:** 302 to `_get_events_url(team, experiment_id)` = `/a/<team>/chatbots/<id>/#events`. **No trigger_id is returned** in the Location header — the create view discards the saved trigger ID. To find the new trigger after create, the caller has to list events.

**Failure:** 200 re-render of the manage_event.html template. Errors aren't in a clean JSON shape — would have to parse the template (or, better, accept the lack of error introspection and tell callers to re-list events to confirm creation).

## Custom Action create — OpenAPI-schema-driven, not webhook config

The probe report claimed fields were `name, description, target_url, request_body_template, http_method, headers`. **This is wrong.**

Source: `apps/custom_actions/forms.py:CustomActionForm` + `apps/custom_actions/views.py:CreateCustomAction`.

**Actual URL:** POST `/a/<team>/actions/new/` (NOT `/custom-actions/new/`).

**Actual fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | |
| `description` | textarea | no | max 1000 chars |
| `prompt` | textarea | no | "Additional Prompt" — instructions to the LLM about how to use this action |
| `server_url` | URL | **yes** | Base URL of the API server (e.g. `https://www.commcarehq.org`) |
| `api_schema` | JSON or YAML | **yes** | **An OpenAPI 3.x schema describing the endpoints.** This is the load-bearing field. |
| `auth_provider` | FK | no | Reference to a configured AuthProvider in the team |
| `healthcheck_path` | string | no | Optional health endpoint; auto-detected from schema if omitted |

After save, OCS auto-populates `allowed_operations` from the schema's `operationId`s and fires a health check (async Celery task — non-blocking).

**Success:** 302 to `single_team:manage_team` (i.e. `/a/<team>/team/`) — **no action ID in Location**. Caller has to list actions afterward to find the new ID.

**Reference OpenAPI schema for Connect Interviews session-completion** (rough sketch):

```yaml
openapi: 3.0.0
info: { title: HQ Session Completion API, version: 1.0.0 }
servers: [{ url: https://www.commcarehq.org }]
paths:
  /a/<domain>/api/inbound_api/<api_id>/:
    post:
      operationId: postSessionCompletion
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                session_completion: { type: string }
                last_bot_interaction_date: { type: string }
                interaction_validation: { type: string }
      responses:
        '200': { description: ok }
```

Real schemas need the actual HQ inbound_api URL once the inbound APIs are configured per-domain (currently a Playwright gap on the HQ side — `commcare_create_inbound_api`).

## Linking custom action to a pipeline node

Source: `apps/custom_actions/form_utils.py:make_model_id` + `apps/pipelines/nodes/nodes.py:309`.

**Storage:** the LLMResponseWithPrompt node's `params.custom_actions` is `list[str]`. Each string is a composite of `<custom_action_id>:<operation_id>` (e.g. `"42:postSessionCompletion"`).

**Mechanism:** GET pipeline → modify the target node's `params.custom_actions` array → POST pipeline.

The `ocs_link_action_to_node` atom should:
1. Take `pipeline_id`, target `node_id`, `custom_action_id`, `operation_id`.
2. Compose `model_id = f"{custom_action_id}:{operation_id}"`.
3. Read pipeline, find target node, append `model_id` to `data.params.custom_actions`.
4. Save pipeline.

## Architectural mismatch surfacing during verification

The Connect Interviews tech doc says:

> "After 24 hours of inactivity, the event is triggered. When this event occurs, a separate Event Pipeline is executed. The pipeline calls a custom action configured for inactivity handling."

OCS events **cannot directly fire custom actions** — `ACTION_PARAMS_FORMS` lists only `log`, `send_message_to_bot`, `end_conversation`, `schedule_trigger`, `pipeline_start`.

**The actual architecture is two pipelines per bot:**
- **Primary pipeline** — Start → StaticRouter → LLM-with-custom-action (session_completion API) → End. Custom action fires when the LLM decides the interview is complete.
- **Secondary "expiry" pipeline** — Start → LLM-with-custom-action (24hr_expiry API) → End. Triggered by the timeout event's `action_type=pipeline_start` pointing here.

For V1 stub bot: I'll build only the primary pipeline (skip the secondary) and document the gap. The verifier rules can grade "has timeout event" + "has custom action" structurally without requiring the secondary pipeline. Real production bots can layer the secondary pipeline on later.

## What's still unverified

These are claims in the rest of `ocs-verification.md` that came from quick reads, not deep verification — flag them if anything bites later:

- **Pipeline graph save endpoint's exact failure shape** when shape is valid but params are wrong. I've seen `{"errors": {"node": {"<id>": {"<field>": "<msg>"}}}}` and assume that's stable; OCS source isn't read.
- **Health check timing on custom action create** — `check_single_custom_action_health` is `@shared_task`. In some deployments tasks run synchronously (eager mode) which would block the create response. Assumed async based on the production OCS deployment config; not verified.
- **Multi-output edge handles on StaticRouterNode** — when wiring router → multiple downstream nodes, the routing happens on `sourceHandle = "output_<index>"`. I haven't verified the exact handle naming; will discover when wiring the cohort's per-interview LLM nodes downstream.
- **PythonNode params shape** — for the session-state-capture node in the tech doc. Not verified; not in V1 stub atom scope.

## Local mirror

OCS source is at `/tmp/ace-refs/ocs/` (shallow clone). To refresh: `cd /tmp/ace-refs/ocs && git pull`. Removable any time; not load-bearing.
