// Domain types for the OCS integration layer.
// Naming: snake_case for fields that cross the HTTP boundary (matches OCS API + eventual REST),
// camelCase only for internal helpers. Interface method names are camelCase (TS convention).

export interface Experiment {
  id: number;
  name: string;
  public_id: string;
  version_number?: number;
  pipeline_id?: number;
  team_slug?: string;
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
