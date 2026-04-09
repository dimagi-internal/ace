import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { RestBackend } from '../../../mcp/ocs/backends/rest.js';
import { HttpError } from '../../../mcp/ocs/errors.js';

const BASE = 'https://chatbots.dimagi.com';

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
});

describe('RestBackend.verify', () => {
  it('calls GET /api/experiments/?page_size=1 with Bearer token', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?page_size=1', method: 'GET' })
      .reply(200, { results: [], next: null });

    const backend = new RestBackend({ baseUrl: BASE, token: 'tok_xyz' });
    await expect(backend.verify()).resolves.toBeUndefined();
  });

  it('throws HttpError on 401', async () => {
    mockAgent.get(BASE)
      .intercept({ path: '/api/experiments/?page_size=1', method: 'GET' })
      .reply(401, 'Unauthorized');

    const backend = new RestBackend({ baseUrl: BASE, token: 'bad' });
    await expect(backend.verify()).rejects.toBeInstanceOf(HttpError);
  });
});
