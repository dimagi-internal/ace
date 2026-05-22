export type Backend = 'REST' | 'PLAYWRIGHT' | 'HYBRID';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string; // eventual REST endpoint, documentation only
}

export type Capability =
  // Authoring (20)
  | 'clone_chatbot'
  | 'create_chatbot'
  | 'set_chatbot_system_prompt'
  | 'set_chatbot_pipeline'
  | 'add_pipeline_node'
  | 'add_custom_action'
  | 'link_action_to_node'
  | 'add_chatbot_event'
  | 'create_collection'
  | 'upload_collection_files'
  | 'wait_for_collection_indexing'
  | 'attach_knowledge'
  | 'set_chatbot_tools'
  | 'set_source_material'
  | 'publish_chatbot_version'
  | 'get_chatbot_embed_info'
  | 'delete_chatbot'
  | 'get_chatbot_pipeline_id'
  | 'delete_pipeline'
  | 'delete_collection'
  // Observation (12)
  | 'list_chatbots'
  | 'get_chatbot'
  | 'list_sessions'
  | 'get_session'
  | 'end_session'
  | 'add_session_tags'
  | 'remove_session_tags'
  | 'update_session_state'
  | 'send_test_message'
  | 'trigger_bot_message'
  | 'update_participant_data'
  | 'download_file';

export const CAPABILITY_MAP: Record<Capability, CapabilityRoute> = {
  // Authoring
  clone_chatbot:                { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/' },
  create_chatbot:               { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/ (not yet shipped — CSRF-protected ChatbotForm only)' },
  set_chatbot_system_prompt:    { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/prompt/' },
  set_chatbot_pipeline:         { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/pipeline/' },
  add_pipeline_node:            { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/pipelines/{id}/nodes/ (not yet shipped — GET/POST pipeline JSON at /pipelines/data/{id}/)' },
  add_custom_action:            { backend: 'PLAYWRIGHT', restTarget: 'POST /api/custom_actions/ (not yet shipped — CSRF-protected CustomActionForm only)' },
  link_action_to_node:          { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/pipelines/{id}/nodes/{node_id}/ (not yet shipped — appends to data.params.custom_actions)' },
  add_chatbot_event:            { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/{id}/events/ (not yet shipped — CSRF-protected combined-form view)' },
  create_collection:            { backend: 'PLAYWRIGHT', restTarget: 'POST /api/collections/' },
  upload_collection_files:      { backend: 'PLAYWRIGHT', restTarget: 'POST /api/collections/{id}/files/' },
  wait_for_collection_indexing: { backend: 'PLAYWRIGHT', restTarget: 'GET /api/collections/{id}/files/{fid}/status/' },
  attach_knowledge:             { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/knowledge/' },
  set_chatbot_tools:            { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/tools/' },
  set_source_material:          { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/' },
  publish_chatbot_version:      { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/{id}/versions/' },
  get_chatbot_embed_info:       { backend: 'HYBRID',     restTarget: 'GET /api/experiments/{id}/embed/' },
  delete_chatbot:               { backend: 'PLAYWRIGHT', restTarget: 'DELETE /api/experiments/{id}/ (not yet shipped)' },
  get_chatbot_pipeline_id:      { backend: 'PLAYWRIGHT', restTarget: 'GET /api/experiments/{id}/ (pipeline_id field not yet exposed in REST schema)' },
  delete_pipeline:              { backend: 'PLAYWRIGHT', restTarget: 'DELETE /api/pipelines/{id}/ (not yet shipped)' },
  delete_collection:            { backend: 'PLAYWRIGHT', restTarget: 'DELETE /api/collections/{id}/ (not yet shipped)' },

  // Observation
  list_chatbots:            { backend: 'REST', restTarget: 'GET /api/experiments/' },
  get_chatbot:              { backend: 'REST', restTarget: 'GET /api/experiments/{id}/' },
  list_sessions:            { backend: 'REST', restTarget: 'GET /api/sessions/' },
  get_session:              { backend: 'REST', restTarget: 'GET /api/sessions/{id}/' },
  end_session:              { backend: 'REST', restTarget: 'POST /api/sessions/{id}/end_experiment_session/' },
  add_session_tags:         { backend: 'REST', restTarget: 'POST /api/sessions/{id}/tags/' },
  remove_session_tags:      { backend: 'REST', restTarget: 'DELETE /api/sessions/{id}/tags/' },
  update_session_state:     { backend: 'REST', restTarget: 'PATCH /api/sessions/{id}/update_state/' },
  send_test_message:        { backend: 'REST', restTarget: 'POST /api/chat/start/ → /message/ → /poll/' },
  trigger_bot_message:      { backend: 'REST', restTarget: 'POST /api/trigger_bot' },
  update_participant_data:  { backend: 'REST', restTarget: 'POST /api/participants' },
  download_file:            { backend: 'REST', restTarget: 'GET /api/files/{id}/content' },
};
