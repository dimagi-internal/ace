// Domain types for the OCS integration layer.
// Naming: snake_case for fields that cross the HTTP boundary (matches OCS API + eventual REST),
// camelCase only for internal helpers. Interface method names are camelCase (TS convention).

/**
 * An Experiment (chatbot) as returned by the OCS REST API.
 *
 * IMPORTANT: the REST API's `id` field is the UUID `public_id` (DRF
 * `lookup_field = "public_id"` in apps/api/views/experiments.py), NOT the
 * integer database id. Web routes use the integer id via scrapes/URLs, which
 * we track separately when we have both (see ClonedChatbot).
 */
export interface Experiment {
  id: string;
  name: string;
  url?: string;
  version_number?: number;
}

/**
 * The result of cloneChatbot, which carries BOTH identifiers because the
 * operation bridges web routes (integer id) and REST (UUID public_id), plus
 * the pipeline_id scraped from the edit page.
 */
export interface ClonedChatbot {
  experiment_id: number;
  public_id: string;
  pipeline_id: number;
}

export interface Collection {
  id: number;
  name: string;
  summary: string;
  is_index: boolean;
  is_remote_index: boolean;
  llm_provider?: number;
  embedding_provider_model?: number;
}

export interface CollectionFile {
  id: number;
  name: string;
  collection_id: number;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  chunk_count?: number;
}

export interface Session {
  id: string;
  experiment_id?: string;
  created_at: string;
  updated_at?: string;
  tags: string[];
  state?: Record<string, unknown>;
}

export interface Message {
  id: string;
  created_at: string;
  message_type: 'human' | 'ai' | 'system';
  content: string;
}

export interface SessionWithMessages extends Session {
  messages: Message[];
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Pipeline graph shape (React-Flow + OCS). Each node carries TWO type fields:
//   top-level `type` — React-Flow internal ("startNode" | "endNode" | "pipelineNode")
//   `data.type`      — OCS-internal class name ("LLMResponseWithPrompt" | etc.)
// Both are required for the pipeline-save endpoint to accept the graph;
// verified by direct probe against live OCS 2026-05-21.
export interface FlowNode {
  id: string;
  type?: string;
  data: {
    /** Mirrors top-level `id`; OCS pipeline-save requires this. */
    id?: string;
    type: string; // LLMResponseWithPrompt, StartNode, EndNode, StaticRouterNode, etc.
    label?: string;
    params: Record<string, unknown>;
  };
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** React-Flow handle id on the source node. Conventionally "output" (or "output_0", "output_1", … for multi-output nodes). */
  sourceHandle?: string;
  /** React-Flow handle id on the target node. Conventionally "input". */
  targetHandle?: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export interface PipelineDataResponse {
  pipeline: {
    id: number;
    name: string;
    data: FlowGraph;
    errors: string[];
  };
}

export interface PipelineDataSaveResponse {
  data: FlowGraph;
  errors: string[];
}

// ── v2 inspect API (OCS PR #3536) ───────────────────────────────────────
//
// Shape mirrors `ChatbotInspect` in the OCS OpenAPI schema served at
// /api/schema/ (live schema is the source of truth). The verifier reads:
//   - pipeline.nodes[].type === "StaticRouterNode" + params.keywords
//   - events.timeout_triggers[].delay_seconds === 86400  (24h inactivity)
//   - pipeline.nodes[].custom_actions[].name === "Session Completion"
//   - pipeline.nodes[].indexed_collections[]  (attached RAG)
//
// Types stay loose (Record<string, unknown> for params) so a server-side
// schema add doesn't break us. Grep the live /api/schema/ before paraphrasing.

export interface InspectCustomAction {
  id: number;
  name: string;
  description?: string;
  server_url?: string;
  allowed_operations?: string[];
}

export interface InspectIndexedCollection {
  id: number;
  name: string;
  is_index?: boolean;
}

export interface InspectNode {
  node_id: string;
  type: string; // e.g. "StaticRouterNode", "LLMResponseWithPrompt"
  label: string;
  params: Record<string, unknown>;
  llm?: Record<string, unknown> | null;
  voice?: Record<string, unknown> | null;
  assistant?: Record<string, unknown> | null;
  source_material?: Record<string, unknown> | null;
  custom_actions?: InspectCustomAction[];
  indexed_collections?: InspectIndexedCollection[];
  media_collection?: Record<string, unknown> | null;
}

export interface InspectPipeline {
  id: number;
  name: string;
  version_number?: number;
  graph: {
    nodes: Array<{ id: string; type?: string; label?: string }>;
    edges: Array<{ id: string; source: string; target: string }>;
  };
  nodes: InspectNode[];
}

export interface InspectTriggerAction {
  type: 'log' | 'end_conversation' | 'send_message_to_bot' | 'schedule_trigger' | 'pipeline_start' | string;
  params: Record<string, unknown>;
  pipeline?: InspectPipeline; // only on pipeline_start
}

export interface InspectStaticTrigger {
  id: number;
  type: string; // conversation_start, conversation_end, ...
  is_active: boolean;
  action: InspectTriggerAction;
}

export interface InspectTimeoutTrigger {
  id: number;
  delay_seconds: number;
  total_num_triggers: number;
  trigger_from_first_message: boolean;
  is_active: boolean;
  action: InspectTriggerAction;
}

export interface InspectEvents {
  static_triggers: InspectStaticTrigger[];
  timeout_triggers: InspectTimeoutTrigger[];
}

export interface ChatbotInspect {
  id: string;
  name: string;
  description?: string | null;
  version_number?: number;
  is_unreleased: boolean;
  is_published_version: boolean;
  version_description: string;
  team_slug: string;
  settings: Record<string, unknown>;
  consent_form?: Record<string, unknown> | null;
  voice?: Record<string, unknown> | null;
  trace_provider?: Record<string, unknown> | null;
  channels: Array<Record<string, unknown>>;
  pipeline: InspectPipeline | null;
  events: InspectEvents;
}

// ── v2 /api/v2/me/ ───────────────────────────────────────────────────────
// Useful as a cheap "is my API key valid + which team is it scoped to" probe.
export interface Me {
  id?: number;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
  email_verified?: boolean;
  team?: { name: string; slug: string };
}

// The subset of LLMResponseWithPrompt params the integration layer patches.
export interface LlmNodeParams {
  prompt?: string;
  source_material_id?: number | null;
  collection_id?: number | null;
  collection_index_ids?: number[];
  max_results?: number;
  generate_citations?: boolean;
  tools?: string[];
  custom_actions?: string[];
  built_in_tools?: string[];
  mcp_tools?: string[];
}
