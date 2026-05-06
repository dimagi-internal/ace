import { describe, it, expect } from 'vitest';
import { extractCsrfToken, type Cookie } from '../../../../mcp/connect/auth/playwright-session.js';

/**
 * Regression tests for the 0.13.19 fix.
 *
 * Pre-0.13.19 `extractCsrfToken(cookies, 'connect.dimagi.com')` would
 * silently fall back to the first csrftoken in the jar when no
 * connect.dimagi.com csrftoken existed. That fallback returned the
 * www.commcarehq.org token (left over from the OAuth-via-CCHQ flow),
 * defeated the throw guard in `getContext()`, and produced 403 CSRF
 * Failed on every Connect REST POST.
 *
 * leep-paint-collection-20260505-1505 Phase 3 Step 2 was the live
 * surface.
 */
describe('extractCsrfToken — domain filter contract', () => {
  const hqOnlyJar: Cookie[] = [
    { name: 'sessionid', value: 'sess-hq', domain: 'www.commcarehq.org' },
    { name: 'csrftoken', value: 'TOKEN-HQ', domain: 'www.commcarehq.org' },
    { name: 'sessionid', value: 'sess-connect', domain: 'connect.dimagi.com' },
    // Note: NO csrftoken on connect.dimagi.com — exact leep-1505 jar shape
  ];

  it('returns undefined (NOT the wrong-domain token) when no domain match exists', () => {
    // The bug: pre-0.13.19 this returned 'TOKEN-HQ' silently.
    expect(extractCsrfToken(hqOnlyJar, 'connect.dimagi.com')).toBeUndefined();
  });

  it('returns the matching csrftoken when one exists for the requested domain', () => {
    const fullJar: Cookie[] = [
      ...hqOnlyJar,
      { name: 'csrftoken', value: 'TOKEN-CONNECT', domain: 'connect.dimagi.com' },
    ];
    expect(extractCsrfToken(fullJar, 'connect.dimagi.com')).toBe('TOKEN-CONNECT');
    expect(extractCsrfToken(fullJar, 'commcarehq')).toBe('TOKEN-HQ');
  });

  it('returns the first csrftoken regardless of domain when no filter is provided (back-compat)', () => {
    expect(extractCsrfToken(hqOnlyJar)).toBe('TOKEN-HQ');
  });

  it('handles a jar with no csrftoken at all', () => {
    const jar: Cookie[] = [{ name: 'sessionid', value: 'x', domain: 'connect.dimagi.com' }];
    expect(extractCsrfToken(jar, 'connect.dimagi.com')).toBeUndefined();
    expect(extractCsrfToken(jar)).toBeUndefined();
  });
});
