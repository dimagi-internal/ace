import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP, type Capability } from '../../../mcp/mobile/capability-map.js';

const EXPECTED_CAPS: Capability[] = [
  'ensure_avd_running',
  'stop_avd',
  'list_avds',
  'install_apk',
  'uninstall_apk',
  'register_test_user',
  'run_recipe',
  'generate_recipes_from_app_summary',
  'capture_ui_dump',
  'save_snapshot',
  'load_snapshot',
];

describe('mobile capability-map', () => {
  it('declares exactly 11 capabilities', () => {
    expect(Object.keys(CAPABILITY_MAP).sort()).toEqual([...EXPECTED_CAPS].sort());
  });

  it('every capability has a backend', () => {
    for (const cap of EXPECTED_CAPS) {
      expect(CAPABILITY_MAP[cap].backend).toMatch(/^(AVD|MAESTRO|COMPOSITE)$/);
    }
  });

  it('routes register_test_user through COMPOSITE', () => {
    expect(CAPABILITY_MAP.register_test_user.backend).toBe('COMPOSITE');
  });
});
