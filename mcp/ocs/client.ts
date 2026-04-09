import type {
  Experiment,
  Session,
  SessionWithMessages,
  ChatCompletionMessage,
} from './types.js';

export interface OcsClient {
  // ── Authoring atoms ──────────────────────────────────────────────

  cloneChatbot(args: {
    template_id: number;
    new_name: string;
  }): Promise<{ experiment_id: number; public_id: string; pipeline_id: number }>;

  setChatbotSystemPrompt(args: {
    experiment_id: number;
    prompt: string;
  }): Promise<void>;

  createCollection(args: {
    name: string;
    summary: string;
    is_index: boolean;
    is_remote_index: boolean;
    llm_provider?: number;
    embedding_model?: number;
  }): Promise<{ collection_id: number }>;

  uploadCollectionFiles(args: {
    collection_id: number;
    files: Array<{ name: string; content: Buffer | string; mime_type: string }>;
  }): Promise<{ file_ids: number[] }>;

  waitForCollectionIndexing(args: {
    collection_id: number;
    timeout_sec?: number;
  }): Promise<{ ready: boolean; files_indexed: number; pending: number }>;

  attachKnowledge(args: {
    experiment_id: number;
    collection_index_ids: number[];
    max_results?: number;
    generate_citations?: boolean;
  }): Promise<void>;

  setChatbotTools(args: {
    experiment_id: number;
    tools?: string[];
    custom_actions?: string[];
    built_in_tools?: string[];
    mcp_tools?: string[];
  }): Promise<void>;

  setSourceMaterial(args: {
    experiment_id: number;
    source_material_id: number | null;
  }): Promise<void>;

  publishChatbotVersion(args: {
    experiment_id: number;
    description: string;
  }): Promise<{ version_number: number; task_id: string }>;

  getChatbotEmbedInfo(args: {
    experiment_id: number;
  }): Promise<{ public_id: string; embed_key: string }>;

  // ── Observation atoms ────────────────────────────────────────────

  listChatbots(args?: {
    cursor?: string;
    page_size?: number;
  }): Promise<{ chatbots: Experiment[]; next_cursor?: string }>;

  getChatbot(args: { experiment_id: number }): Promise<Experiment>;

  listSessions(args: {
    experiment_id?: string;
    since?: string;
    tags?: string;
    versions?: string;
    cursor?: string;
    page_size?: number;
  }): Promise<{ sessions: Session[]; next_cursor?: string }>;

  getSession(args: { session_id: string }): Promise<SessionWithMessages>;

  endSession(args: { session_id: string }): Promise<void>;

  addSessionTags(args: {
    session_id: string;
    tags: string[];
  }): Promise<{ tags: string[] }>;

  removeSessionTags(args: {
    session_id: string;
    tags: string[];
  }): Promise<{ tags: string[] }>;

  updateSessionState(args: {
    session_id: string;
    state: Record<string, unknown>;
  }): Promise<{ state: Record<string, unknown> }>;

  sendTestMessage(args: {
    experiment_id: number;
    messages: ChatCompletionMessage[];
  }): Promise<{ response: ChatCompletionMessage }>;

  triggerBotMessage(args: {
    experiment_id: string;
    identifier: string;
    platform: string;
    prompt_text: string;
    session_data?: Record<string, unknown>;
    participant_data?: Record<string, unknown>;
  }): Promise<void>;

  updateParticipantData(args: {
    identifier: string;
    platform: string;
    data: Array<{
      experiment: string;
      data?: Record<string, unknown>;
      schedules?: Array<{
        id: string;
        name?: string;
        date?: string;
        prompt?: string;
        delete?: boolean;
      }>;
    }>;
  }): Promise<void>;

  downloadFile(args: {
    file_id: number;
  }): Promise<{ content: Buffer; filename: string; mime_type: string }>;
}
