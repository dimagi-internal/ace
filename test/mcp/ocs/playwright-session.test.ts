import { describe, it, expect } from 'vitest';
import { extractCsrfToken } from '../../../mcp/ocs/auth/playwright-session.js';

describe('extractCsrfToken', () => {
  it('returns token from Set-Cookie-style cookies array', () => {
    const cookies = [
      { name: 'sessionid', value: 'abc' },
      { name: 'csrftoken', value: 'xyz123' },
    ];
    expect(extractCsrfToken(cookies)).toBe('xyz123');
  });

  it('returns undefined if csrftoken is absent', () => {
    const cookies = [{ name: 'sessionid', value: 'abc' }];
    expect(extractCsrfToken(cookies)).toBeUndefined();
  });
});
