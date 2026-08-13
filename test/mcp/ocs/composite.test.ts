import { describe, it, expect, vi } from 'vitest';
import { CompositeBackend } from '../../../mcp/ocs/backends/composite.js';
import { VersionBadgeUnreadableError } from '../../../mcp/ocs/errors.js';

describe('CompositeBackend routing', () => {
  it('routes REST atoms to the REST backend', async () => {
    const rest = { listChatbots: vi.fn().mockResolvedValue({ chatbots: [], next_cursor: undefined }) };
    const pw = {};
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.listChatbots({});
    expect(rest.listChatbots).toHaveBeenCalled();
  });

  it('routes PLAYWRIGHT atoms to the Playwright backend', async () => {
    const rest = {};
    const pw = { cloneChatbot: vi.fn().mockResolvedValue({ experiment_id: 1, public_id: 'u', pipeline_id: 2 }) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.cloneChatbot({ template_id: 1, new_name: 'x' });
    expect(pw.cloneChatbot).toHaveBeenCalled();
  });

  it('routes HYBRID atoms to the Playwright backend by default', async () => {
    const rest = {};
    const pw = { getChatbotEmbedInfo: vi.fn().mockResolvedValue({ public_id: 'u', embed_key: 'e' }) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    await c.getChatbotEmbedInfo({ experiment_id: 1 });
    expect(pw.getChatbotEmbedInfo).toHaveBeenCalled();
  });

  it('getChatbotPipelineId calls playwright.pipelineIdFor and wraps the result', async () => {
    const rest = {};
    const pw = { pipelineIdFor: vi.fn().mockResolvedValue(5942) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });
    const out = await c.getChatbotPipelineId({ experiment_id: 12167 });
    expect(pw.pipelineIdFor).toHaveBeenCalledWith(12167);
    expect(out).toEqual({ pipeline_id: 5942 });
  });
});

// ---------------------------------------------------------------------------
// dimagi-internal/ace#891 — publish read-back fallback
// ---------------------------------------------------------------------------

describe('CompositeBackend.publishChatbotVersion — badge-unreadable fallback (#891)', () => {
  const badgeFailure = () =>
    new VersionBadgeUnreadableError(99, 'pub-uuid', 'published, badge unreadable');

  // The live payload shape from the issue's repros: the top-level counter is
  // AHEAD of the published default. This is the whole trap.
  const chatbotPayload = {
    id: 'pub-uuid',
    name: 'ACE bot',
    version_number: 3, // working/next counter — must NOT be returned
    versions: [
      { version_number: 1, is_default_version: false },
      { version_number: 2, is_default_version: true, version_description: 'Initial ACE version' },
    ],
  };

  it('returns the PUBLISHED version, not the working counter', async () => {
    const rest = { getChatbot: vi.fn().mockResolvedValue(chatbotPayload) };
    const pw = { publishChatbotVersion: vi.fn().mockRejectedValue(badgeFailure()) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 99, description: 'x' });

    // 2, not 3. Returning 3 writes an off-by-one into run_state.yaml and later
    // breaks llo-launch's freshness equality check.
    expect(out).toEqual({ version_number: 2, task_id: 'none' });
    expect(rest.getChatbot).toHaveBeenCalledWith({ public_id: 'pub-uuid' });
  });

  it('does not call the API when the badge scrape succeeded', async () => {
    const rest = { getChatbot: vi.fn() };
    const pw = {
      publishChatbotVersion: vi.fn().mockResolvedValue({ version_number: 7, task_id: 'none' }),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 99, description: 'x' });

    expect(out).toEqual({ version_number: 7, task_id: 'none' });
    expect(rest.getChatbot).not.toHaveBeenCalled();
  });

  it('still fails loud when the API cannot answer either (#823 invariant)', async () => {
    // The point of the fallback is a better ANSWER, never a guess. An empty
    // versions[] must rethrow rather than invent a number.
    const rest = { getChatbot: vi.fn().mockResolvedValue({ id: 'pub-uuid', name: 'b', versions: [] }) };
    const pw = { publishChatbotVersion: vi.fn().mockRejectedValue(badgeFailure()) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    await expect(
      c.publishChatbotVersion({ experiment_id: 99, description: 'x' }),
    ).rejects.toThrow(VersionBadgeUnreadableError);
  });

  it('fails loud when no version is flagged as default', async () => {
    const rest = {
      getChatbot: vi.fn().mockResolvedValue({
        id: 'pub-uuid',
        name: 'b',
        version_number: 3,
        versions: [{ version_number: 1, is_default_version: false }],
      }),
    };
    const pw = { publishChatbotVersion: vi.fn().mockRejectedValue(badgeFailure()) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    await expect(
      c.publishChatbotVersion({ experiment_id: 99, description: 'x' }),
    ).rejects.toThrow(VersionBadgeUnreadableError);
  });

  it('recovers the public_id from the chatbot list when the error carries none', async () => {
    const rest = {
      listChatbots: vi.fn().mockResolvedValue({
        chatbots: [{ id: 'found-uuid', name: 'ACE bot', experiment_id: 99 }],
      }),
      getChatbot: vi.fn().mockResolvedValue({ ...chatbotPayload, id: 'found-uuid' }),
    };
    const pw = {
      publishChatbotVersion: vi
        .fn()
        .mockRejectedValue(new VersionBadgeUnreadableError(99, undefined, 'no public id')),
    };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    const out = await c.publishChatbotVersion({ experiment_id: 99, description: 'x' });

    expect(out.version_number).toBe(2);
    expect(rest.getChatbot).toHaveBeenCalledWith({ public_id: 'found-uuid' });
  });

  it('rethrows any error that is not the badge failure', async () => {
    const rest = { getChatbot: vi.fn() };
    const pw = { publishChatbotVersion: vi.fn().mockRejectedValue(new Error('publish rejected')) };
    const c = new CompositeBackend({ rest: rest as never, playwright: pw as never });

    await expect(
      c.publishChatbotVersion({ experiment_id: 99, description: 'x' }),
    ).rejects.toThrow(/publish rejected/);
    expect(rest.getChatbot).not.toHaveBeenCalled();
  });
});
