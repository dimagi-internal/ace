import { describe, it, expect, vi } from 'vitest';
import { CompositeBackend } from '../../../mcp/ocs/backends/composite.js';

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
