import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightBackend } from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeBackend(request: RequestFn, pipelineCacheSeed?: Map<number, number>) {
  return new PlaywrightBackend({
    teamSlug: 'dimagi',
    baseUrl: 'https://chatbots.dimagi.com',
    csrfToken: 'csrf-xyz',
    request,
    pipelineCacheSeed,
  });
}

function loadPipelineFixture() {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-pipeline.json'), 'utf-8')
  );
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

describe('PlaywrightBackend pipeline-patch atoms', () => {
  // Seed: experiment 99 maps to pipeline 77 (matches the fixture's pipeline id)
  const seed = new Map<number, number>([[99, 77]]);

  function makePipelineRequest(onSave: (body: unknown) => void): RequestFn {
    const fixture = loadPipelineFixture();
    return async (method, url, body) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        onSave(body);
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
  }

  it('setChatbotSystemPrompt patches prompt field', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: { prompt?: string } } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setChatbotSystemPrompt({ experiment_id: 99, prompt: 'new system prompt' });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('new system prompt');
  });

  it('attachKnowledge patches collection_index_ids', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.attachKnowledge({
      experiment_id: 99,
      collection_index_ids: [42],
      max_results: 15,
      generate_citations: true,
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.collection_index_ids).toEqual([42]);
    expect(llm.data.params.max_results).toBe(15);
  });

  it('setChatbotTools patches tool arrays', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setChatbotTools({
      experiment_id: 99,
      tools: ['search'],
      mcp_tools: ['ace_get_opp'],
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.tools).toEqual(['search']);
    expect(llm.data.params.mcp_tools).toEqual(['ace_get_opp']);
  });

  it('setSourceMaterial patches source_material_id', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setSourceMaterial({ experiment_id: 99, source_material_id: 321 });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.source_material_id).toBe(321);
  });

  it('falls back to /api/experiments/<id>/ lookup when cache misses', async () => {
    const fixture = loadPipelineFixture();
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/api/experiments/99/') {
        return { ok: true, json: async () => ({ id: 99, pipeline_id: 77 }) };
      }
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    // No seed — backend must resolve experiment→pipeline via REST lookup
    const backend = makeBackend(request);
    await expect(
      backend.setChatbotSystemPrompt({ experiment_id: 99, prompt: 'x' })
    ).resolves.toBeUndefined();
  });
});

describe('PlaywrightBackend collection atoms', () => {
  it('createCollection POSTs form and returns collection_id', async () => {
    const request: RequestFn = async (method, url, body) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collection/new/') {
        expect(body).toMatchObject({
          name: 'ACE Malaria',
          summary: 'knowledge base',
          is_index: true,
          is_remote_index: true,
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return { ok: true, json: async () => ({ collection_id: 501 }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.createCollection({
      name: 'ACE Malaria',
      summary: 'knowledge base',
      is_index: true,
      is_remote_index: true,
    });
    expect(out.collection_id).toBe(501);
  });

  it('uploadCollectionFiles POSTs multipart and returns file_ids', async () => {
    const request: RequestFn = async (method, url, body) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collections/501/add_files') {
        // Body shape is deliberately loose to match what a real multipart helper emits
        expect((body as { files: unknown[] }).files).toHaveLength(1);
        return { ok: true, json: async () => ({ file_ids: [9001] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.uploadCollectionFiles({
      collection_id: 501,
      files: [{ name: 'idd.pdf', content: Buffer.from('PDF'), mime_type: 'application/pdf' }],
    });
    expect(out.file_ids).toEqual([9001]);
  });

  it('waitForCollectionIndexing polls until all files have chunk_count > 0', async () => {
    let call = 0;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/501/files/')) {
        call++;
        const chunkCount = call >= 2 ? 5 : 0;
        return { ok: true, json: async () => ({ chunk_count: chunkCount, status: chunkCount > 0 ? 'COMPLETED' : 'PROCESSING' }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.waitForCollectionIndexing({
      collection_id: 501,
      timeout_sec: 10,
      _fileIds: [9001], // test-only override; production callers track file ids via state
      _pollIntervalMs: 10,
    });
    expect(out.ready).toBe(true);
    expect(out.files_indexed).toBe(1);
  });
});

describe('PlaywrightBackend publish + embed info', () => {
  it('publishChatbotVersion POSTs versions/create form', async () => {
    const request: RequestFn = async (method, url, body) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        expect(body).toMatchObject({
          version_description: 'initial',
          make_default: true,
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return { ok: true, json: async () => ({ version_number: 1, task_id: 'celery-123' }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.publishChatbotVersion({ experiment_id: 99, description: 'initial' });
    expect(out.version_number).toBe(1);
    expect(out.task_id).toBe('celery-123');
  });

  it('getChatbotEmbedInfo scrapes widget_token from the channels page', async () => {
    const scrapedHtml = `
      <html><body>
        <div class="channel-row" data-platform="EMBEDDED_WIDGET">
          <code data-widget-token="tok-abc123"></code>
        </div>
      </body></html>
    `;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/api/experiments/99/') {
        return { ok: true, json: async () => ({ id: 99, public_id: 'uuid-99' }) };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/channels/') {
        return { ok: true, json: async () => ({ html: scrapedHtml }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.getChatbotEmbedInfo({ experiment_id: 99 });
    expect(out.public_id).toBe('uuid-99');
    expect(out.embed_key).toBe('tok-abc123');
  });
});
