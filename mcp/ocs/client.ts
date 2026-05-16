import type {
  Experiment,
  ClonedChatbot,
  Session,
  SessionWithMessages,
} from './types.js';

export interface OcsClient {
  // ── Authoring atoms ──────────────────────────────────────────────

  cloneChatbot(args: {
    template_id: number;
    new_name: string;
  }): Promise<ClonedChatbot>;

  setChatbotSystemPrompt(args: {
    experiment_id: number;
    prompt: string;
  }): Promise<void>;

  /**
   * Transactional update of the LLM-response node's params: prompt +
   * collection bindings + tools + source material in a single
   * GET-mutate-POST cycle. Use this when changing prompt and collections
   * together — the OCS pipeline-save validates cross-field constraints
   * (e.g. `{collection_index_summaries}` in the prompt requires a
   * non-empty `collection_index_ids`), and stepping the changes through
   * separate atoms can leave the pipeline in a state OCS rejects on the
   * intermediate save (the chicken-and-egg surfaced in 0.6.3 dogfood).
   *
   * Any field left unset is preserved from the existing pipeline state.
   * Pre-flight: if the final prompt contains `{collection_index_summaries}`,
   * the final `collection_index_ids` must be non-empty — fails fast with a
   * typed PipelineValidationError otherwise.
   */
  setChatbotPipeline(args: {
    experiment_id: number;
    prompt?: string;
    collection_index_ids?: number[];
    max_results?: number;
    generate_citations?: boolean;
    source_material_id?: number | null;
    tools?: string[];
    custom_actions?: string[];
    built_in_tools?: string[];
    mcp_tools?: string[];
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
    /** Chunk size in tokens. Default 800. */
    chunk_size?: number;
    /** Chunk overlap in tokens. Must be < chunk_size. Default 400. */
    chunk_overlap?: number;
  }): Promise<{ file_ids: number[] }>;

  waitForCollectionIndexing(args: {
    collection_id: number;
    file_ids: number[];
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

  /**
   * Delete an experiment (chatbot) by integer id. Sets `is_archived=True` on
   * the Experiment row server-side (the user-visible effect is deletion —
   * the chatbot disappears from listings and the team's catalog). Each clone
   * has its own Experiment, so deleting one opp's clone doesn't affect the
   * golden template or other opps' clones.
   *
   * IMPORTANT — callers MUST exclude the `OCS_GOLDEN_TEMPLATE_ID` from the
   * sweep set before calling this atom. The atom itself has no idea what
   * the template id is; the safety boundary lives in the caller (the
   * `sweep-ocs` skill reads the env var and excludes it from candidates).
   *
   * Routes through Playwright to the `/a/<team>/chatbots/<pk>/delete/` HTML
   * view (POST, returns 302 HTMX `HX-Redirect`). No REST equivalent.
   */
  deleteChatbot(args: { experiment_id: number }): Promise<{ deleted: number }>;

  /**
   * Delete a pipeline by integer id. Sets `is_archived=True` on the Pipeline
   * row server-side. Each clone gets its own Pipeline (verified 2026-05-15:
   * `Pipeline.create_new_version(is_copy=True)` deep-clones nodes), so
   * deleting an orphan opp's pipeline is safe and never affects the golden
   * template or other clones.
   *
   * Routes through Playwright to the `/a/<team>/pipelines/<pk>/delete/` HTML
   * view (HTTP DELETE method on Django View.delete(); returns 200 empty body).
   */
  deletePipeline(args: { pipeline_id: number }): Promise<{ deleted: number }>;

  /**
   * Delete a collection by integer id. Calls `Collection.archive()` server-side
   * which sets `is_archived=True` AND triggers `delete_document_source_task`
   * to async-purge the underlying File rows + object-storage blobs +
   * FileChunkEmbedding vectors. The user-visible effect is a full delete:
   * files are gone, vector storage is reclaimed.
   *
   * IMPORTANT — callers MUST exclude `OCS_GOLDEN_TEMPLATE_COLLECTION_ID`
   * from the sweep set before calling this atom. That collection (e.g. id
   * 350 today) is referenced by every clone's pipeline (the
   * `if not is_copy` branch in `Node.create_new_version` skips versioning
   * of `collection_id` on clone, so all clones inherit it). Deleting it
   * would break every clone's RAG retrieval.
   *
   * Per-opp collections (created fresh by Phase 5 via `ocs_create_collection`
   * and attached via `attach_knowledge`) are NOT shared — they belong to
   * the clone and are safe to delete when the clone is deleted.
   *
   * Routes through Playwright to the `/a/<team>/documents/collection/<pk>/delete/`
   * HTML view (HTTP DELETE method on Django View.delete(); returns 200 empty
   * body; async cleanup task fires after).
   */
  deleteCollection(args: { collection_id: number }): Promise<{ deleted: number }>;

  // ── Observation atoms ────────────────────────────────────────────

  listChatbots(args?: {
    cursor?: string;
    page_size?: number;
  }): Promise<{ chatbots: Experiment[]; next_cursor?: string }>;

  getChatbot(args: { public_id: string }): Promise<Experiment>;

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
    public_id: string;
    embed_key: string;
    message: string;
  }): Promise<{ response: string }>;

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
