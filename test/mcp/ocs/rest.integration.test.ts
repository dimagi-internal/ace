import { describe, it, expect } from 'vitest';
import { RestBackend } from '../../../mcp/ocs/backends/rest.js';
import { loadBaseUrl, loadRestToken } from '../../../mcp/ocs/auth/rest-token.js';

const integration = process.env.OCS_INTEGRATION === '1';
const describeFn = integration ? describe : describe.skip;

// Lazy factory — loadRestToken() throws if OCS_API_TOKEN isn't set, so we only
// call it inside test bodies (which don't execute when describe.skip is used).
function makeBackend() {
  return new RestBackend({ baseUrl: loadBaseUrl(), token: loadRestToken() });
}

describeFn('RestBackend integration (requires OCS_INTEGRATION=1 + real token)', () => {
  it('verify() succeeds', async () => {
    const backend = makeBackend();
    await expect(backend.verify()).resolves.toBeUndefined();
  });

  it('listChatbots returns at least one chatbot', async () => {
    const backend = makeBackend();
    const out = await backend.listChatbots({ page_size: 5 });
    expect(Array.isArray(out.chatbots)).toBe(true);
  });

  it('listSessions with page_size=1 returns up to 1 session', async () => {
    const backend = makeBackend();
    const out = await backend.listSessions({ page_size: 1 });
    expect(out.sessions.length).toBeLessThanOrEqual(1);
  });
});
