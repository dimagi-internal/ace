import { describe, it, expect, afterAll } from 'vitest';
import { PlaywrightSession } from '../../../mcp/ocs/auth/playwright-session.js';
import { PlaywrightBackend } from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';

const integration = process.env.OCS_INTEGRATION === '1';
const describeFn = integration ? describe : describe.skip;

describeFn('PlaywrightBackend integration (requires OCS_INTEGRATION=1 + live session)', () => {
  const baseUrl = process.env.OCS_BASE_URL ?? 'https://www.openchatstudio.com';
  const teamSlug = process.env.OCS_TEAM_SLUG ?? 'dimagi';
  const templateId = Number(process.env.OCS_GOLDEN_TEMPLATE_ID ?? 0);

  const session = new PlaywrightSession({
    baseUrl,
    teamSlug,
    username: process.env.OCS_USERNAME,
    password: process.env.OCS_PASSWORD,
  });

  afterAll(async () => { await session.close(); });

  it('session authenticates and extracts CSRF token', async () => {
    await session.getContext();
    expect(session.getCsrfToken()).toBeTruthy();
  });

  it('clones the golden template then archives the clone', async () => {
    if (!templateId) {
      console.warn('OCS_GOLDEN_TEMPLATE_ID not set — skipping clone test');
      return;
    }
    const ctx = await session.getContext();
    const csrfToken = session.getCsrfToken();
    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET') {
        const res = await ctx.request.get(url);
        return { ok: res.ok(), json: async () => await res.json() };
      }
      const res = await ctx.request.post(url, {
        headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
        data: body,
      });
      return { ok: res.ok(), json: async () => await res.json() };
    };
    const backend = new PlaywrightBackend({ teamSlug, baseUrl, csrfToken, request });

    const name = `ACE - integration-test-${Date.now()}`;
    const cloned = await backend.cloneChatbot({ template_id: templateId, new_name: name });
    expect(cloned.experiment_id).toBeGreaterThan(0);
    expect(cloned.public_id).toMatch(/[0-9a-f-]{36}/);

    // Clean up: archive the cloned chatbot
    await ctx.request.post(`/a/${teamSlug}/chatbots/${cloned.experiment_id}/delete/`, {
      headers: { 'X-CSRFToken': csrfToken, Referer: baseUrl },
    });
  });
});
