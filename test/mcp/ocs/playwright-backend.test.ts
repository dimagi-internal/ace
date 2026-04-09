import { describe, it, expect } from 'vitest';
import { PlaywrightBackend } from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';

function makeBackend(request: RequestFn) {
  return new PlaywrightBackend({
    teamSlug: 'dimagi',
    baseUrl: 'https://chatbots.dimagi.com',
    csrfToken: 'csrf-xyz',
    request,
  });
}

describe('PlaywrightBackend.cloneChatbot', () => {
  it('POSTs copy form and returns the new experiment info', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const request: RequestFn = async (method, url, body) => {
      calls.push({ method, url, body });
      if (url === '/a/dimagi/chatbots/5/copy/') {
        return {
          ok: true,
          json: async () => ({ experiment_id: 99 }),
        };
      }
      if (url === '/api/experiments/99/') {
        return {
          ok: true,
          json: async () => ({ id: 99, public_id: 'uuid-99', pipeline_id: 77 }),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' });

    expect(out).toEqual({ experiment_id: 99, public_id: 'uuid-99', pipeline_id: 77 });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/a/dimagi/chatbots/5/copy/');
    expect(calls[0].body).toMatchObject({
      new_name: 'ACE - Malaria Pilot',
      csrfmiddlewaretoken: 'csrf-xyz',
    });
  });
});
