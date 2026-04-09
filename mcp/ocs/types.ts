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

// Pipeline graph shape (React-Flow). Simplified to what ACE needs.
export interface FlowNode {
  id: string;
  type?: string;
  data: {
    type: string; // LLMResponseWithPrompt, StartNode, EndNode, etc.
    label?: string;
    params: Record<string, unknown>;
  };
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
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
