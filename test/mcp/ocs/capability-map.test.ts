import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP, type Capability } from '../../../mcp/ocs/capability-map.js';
import { CompositeBackend } from '../../../mcp/ocs/backends/composite.js';

/** snake_case capability name → camelCase composite method name */
function toMethodName(cap: Capability): string {
  return cap.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

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

  it('every capability has a corresponding CompositeBackend method', () => {
    // Mock backends — we only need property-access for this check, never call.
    const composite = new CompositeBackend({ rest: {} as any, playwright: {} as any });
    const missing: string[] = [];
    for (const cap of Object.keys(CAPABILITY_MAP) as Capability[]) {
      const method = toMethodName(cap);
      if (typeof (composite as any)[method] !== 'function') {
        missing.push(`${cap} → ${method}`);
      }
    }
    expect(missing, 'capabilities without CompositeBackend implementations').toEqual([]);
  });

  it('snake_case ↔ camelCase round-trips for every capability', () => {
    // Catches accidental drift if a capability is renamed but not updated everywhere.
    for (const cap of Object.keys(CAPABILITY_MAP)) {
      const camel = cap.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      const back = camel.replace(/([A-Z])/g, '_$1').toLowerCase();
      expect(back, cap).toBe(cap);
    }
  });
});
