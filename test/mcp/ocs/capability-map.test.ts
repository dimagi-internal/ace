import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP, type Capability } from '../../../mcp/ocs/capability-map.js';

describe('capability map', () => {
  it('has exactly 23 entries', () => {
    expect(Object.keys(CAPABILITY_MAP).length).toBe(23);
  });

  it('every entry has a backend and a restTarget', () => {
    for (const [name, route] of Object.entries(CAPABILITY_MAP)) {
      expect(route.backend, name).toMatch(/^(REST|PLAYWRIGHT|HYBRID)$/);
      expect(route.restTarget, name).toMatch(/^[A-Z]+ \//);
    }
  });

  it('routes observation atoms through REST', () => {
    const observation: Capability[] = [
      'list_chatbots', 'get_chatbot', 'list_sessions', 'get_session',
      'end_session', 'add_session_tags', 'remove_session_tags',
      'update_session_state', 'send_test_message', 'trigger_bot_message',
      'update_participant_data', 'download_file',
    ];
    for (const cap of observation) {
      expect(CAPABILITY_MAP[cap].backend, cap).toBe('REST');
    }
  });

  it('routes authoring atoms through PLAYWRIGHT (except embed info which is HYBRID)', () => {
    const authoring: Capability[] = [
      'clone_chatbot', 'set_chatbot_system_prompt', 'set_chatbot_pipeline',
      'create_collection', 'upload_collection_files',
      'wait_for_collection_indexing', 'attach_knowledge', 'set_chatbot_tools',
      'set_source_material', 'publish_chatbot_version',
    ];
    for (const cap of authoring) {
      expect(CAPABILITY_MAP[cap].backend, cap).toBe('PLAYWRIGHT');
    }
    expect(CAPABILITY_MAP.get_chatbot_embed_info.backend).toBe('HYBRID');
  });
});
