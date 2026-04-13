export type Backend = 'REST' | 'PLAYWRIGHT' | 'HYBRID';

export interface CapabilityRoute {
  backend: Backend;
  restTarget: string; // eventual REST endpoint, documentation only
}

export type Capability =
  // Authoring (10)
  | 'clone_chatbot'
  | 'set_chatbot_system_prompt'
  | 'create_collection'
  | 'upload_collection_files'
  | 'wait_for_collection_indexing'
  | 'attach_knowledge'
  | 'set_chatbot_tools'
  | 'set_source_material'
  | 'publish_chatbot_version'
  | 'get_chatbot_embed_info'
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
  set_chatbot_system_prompt:    { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/prompt/' },
  create_collection:            { backend: 'PLAYWRIGHT', restTarget: 'POST /api/collections/' },
  upload_collection_files:      { backend: 'PLAYWRIGHT', restTarget: 'POST /api/collections/{id}/files/' },
  wait_for_collection_indexing: { backend: 'PLAYWRIGHT', restTarget: 'GET /api/collections/{id}/files/{fid}/status/' },
  attach_knowledge:             { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/knowledge/' },
  set_chatbot_tools:            { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/tools/' },
  set_source_material:          { backend: 'PLAYWRIGHT', restTarget: 'PATCH /api/experiments/{id}/' },
  publish_chatbot_version:      { backend: 'PLAYWRIGHT', restTarget: 'POST /api/experiments/{id}/versions/' },
  get_chatbot_embed_info:       { backend: 'HYBRID',     restTarget: 'GET /api/experiments/{id}/embed/' },

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
