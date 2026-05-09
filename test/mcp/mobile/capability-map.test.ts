import { describe, it, expect } from 'vitest';
import { CAPABILITY_MAP } from '../../../mcp/mobile/capability-map.js';

describe('mobile capability-map', () => {
  it('routes register_test_user through COMPOSITE', () => {
    expect(CAPABILITY_MAP.register_test_user.backend).toBe('COMPOSITE');
  });
});
