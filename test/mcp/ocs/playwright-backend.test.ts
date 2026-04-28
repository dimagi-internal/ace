import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PlaywrightBackend,
  extractWidgetToken,
  extractPublicId,
  extractPipelineId,
  extractEmbeddedWidgetChannelId,
  extractExperimentIdFromLocation,
} from '../../../mcp/ocs/backends/playwright.js';
import type { RequestFn } from '../../../mcp/ocs/backends/pipeline-patch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeBackend(request: RequestFn, pipelineCacheSeed?: Map<number, number>) {
  return new PlaywrightBackend({
    teamSlug: 'dimagi',
    baseUrl: 'https://www.openchatstudio.com',
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

// Realistic HTML fragments pulled from the actual OCS templates.
// These anchor the scrape regexes to the real DOM shape so a template change
// upstream will surface as a test failure.

// Anchored on the REAL DOM from templates/chatbots/single_chatbot_home.html
// — specifically the hidden api-url-link input which is always rendered
// regardless of the flag_chat_widget feature flag state.
//
// The `<open-chat-studio-widget>` tag below simulates the global OCS support
// widget that renders on every authenticated page. Its chatbot-id is a
// synthetic test UUID — its only job is to ensure extractPublicId does NOT
// match it (which would be a regression, since the support widget isn't the
// current experiment).
const HOME_HTML_WITH_WIDGET = `
<html><body>
  <h1 id="chatbot-name">ACE - Malaria Pilot</h1>
  <!-- Channels section with one embedded_widget channel -->
  <div id="dynamic-channels" class="inline">
    <button class="btn btn-ghost btn-sm normal-case!"
            hx-get="/channels/dimagi/chatbots/99/channels/333/edit-dialog/"
            hx-target="#channel_create_edit_modal_placeholder"
            hx-swap="innerHTML">
      <span class="tooltip" data-tip="embedded_widget"><i
          class="fa-brands fa-embedded_widget"></i> Embedded Widget</span>
    </button>
  </div>
  <!-- api-url-link hidden input renders unconditionally — this is what we scrape -->
  <input id="api-url-link" type="hidden" value="https://www.openchatstudio.com/api/openai/00000000-0000-4000-8000-000000000099/chat/completions" />
  <!-- Decoy support-widget tag — MUST NOT be matched by extractPublicId -->
  <open-chat-studio-widget chatbot-id="decafbad-0000-0000-0000-000000000000" button-text="Ask me!" position="right"></open-chat-studio-widget>
</body></html>
`;

const EDIT_HTML_WITH_PIPELINE_ID = `
<html><body>
  <div class="max-w-7xl mx-auto" id="pipelineBuilder"></div>
  <script type="module">
    window.DOCUMENTATION_BASE_URL = 'https://docs.example.com';
    document.addEventListener('DOMContentLoaded', () => {
      SiteJS.pipeline.renderPipeline("#pipelineBuilder", "dimagi", 77);
    }
    )
  </script>
</body></html>
`;

const EDIT_DIALOG_HTML_WITH_TOKEN = `
<html><body>
  <div class="card bg-base-200">
    <div class="card-body">
      <label class="label">Chatbot ID:</label>
      <div class="join w-full">
        <input type="text" id="widget_chatbot_id" value="00000000-0000-4000-8000-000000000099" class="input" readonly>
      </div>
      <label class="label">Embed Token:</label>
      <div class="join w-full">
        <input type="text" id="widget_token" value="tok-abc123" class="input" readonly>
      </div>
    </div>
  </div>
</body></html>
`;

// ── HTML scrape helpers ────────────────────────────────────────────

describe('HTML scrape helpers', () => {
  it('extractWidgetToken matches the real widget_params.html shape', () => {
    expect(extractWidgetToken(EDIT_DIALOG_HTML_WITH_TOKEN)).toBe('tok-abc123');
  });

  it('extractWidgetToken returns undefined when absent', () => {
    expect(extractWidgetToken('<html></html>')).toBeUndefined();
  });

  it('extractPublicId matches the widget tag on the chatbot home page', () => {
    expect(extractPublicId(HOME_HTML_WITH_WIDGET)).toBe('00000000-0000-4000-8000-000000000099');
  });

  it('extractPublicId returns undefined when the widget tag is absent (flag off)', () => {
    expect(extractPublicId('<html><body><h1>no widget</h1></body></html>')).toBeUndefined();
  });

  it('extractPipelineId matches the SiteJS.pipeline.renderPipeline call', () => {
    expect(extractPipelineId(EDIT_HTML_WITH_PIPELINE_ID)).toBe(77);
  });

  it('extractPipelineId returns undefined when the script block is absent', () => {
    expect(extractPipelineId('<html></html>')).toBeUndefined();
  });

  it('extractEmbeddedWidgetChannelId finds the embedded_widget channel row', () => {
    expect(extractEmbeddedWidgetChannelId(HOME_HTML_WITH_WIDGET, 99)).toBe(333);
  });

  it('extractEmbeddedWidgetChannelId returns undefined when no embedded_widget row exists', () => {
    const htmlWithOtherChannel = `
      <button hx-get="/channels/dimagi/chatbots/99/channels/444/edit-dialog/">
        <i class="fa-brands fa-telegram"></i> Telegram
      </button>
    `;
    expect(extractEmbeddedWidgetChannelId(htmlWithOtherChannel, 99)).toBeUndefined();
  });

  it('extractExperimentIdFromLocation parses the redirect Location header', () => {
    expect(extractExperimentIdFromLocation('/a/dimagi/chatbots/99/')).toBe(99);
    expect(extractExperimentIdFromLocation('/a/dimagi/chatbots/12345/?foo=bar')).toBe(12345);
    expect(extractExperimentIdFromLocation('/some/other/path')).toBeUndefined();
  });
});

// ── cloneChatbot ─────────────────────────────────────────────────────

describe('PlaywrightBackend.cloneChatbot', () => {
  it('handles the 302 redirect, scrapes ids, and creates the widget channel', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const request: RequestFn = async (method, url, body, options) => {
      calls.push({ method, url });

      if (method === 'POST' && url === '/a/dimagi/chatbots/5/copy/') {
        // Simulate Django's redirect response
        expect(options?.followRedirects).toBe(false);
        expect(body).toMatchObject({
          new_name: 'ACE - Malaria Pilot',
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/chatbots/99/' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return {
          ok: true,
          status: 200,
          text: async () => HOME_HTML_WITH_WIDGET,
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/edit/') {
        return {
          ok: true,
          status: 200,
          text: async () => EDIT_HTML_WITH_PIPELINE_ID,
          json: async () => ({}),
        };
      }
      if (
        method === 'POST' &&
        url === '/channels/dimagi/chatbots/99/channels/create-dialog/embedded_widget/'
      ) {
        expect(options?.formEncoded).toBe(true);
        expect(body).toMatchObject({
          name: 'ACE - Malaria Pilot',
          platform: 'embedded_widget',
          allow_all_domains: 'on',
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.cloneChatbot({ template_id: 5, new_name: 'ACE - Malaria Pilot' });

    expect(out).toEqual({
      experiment_id: 99,
      public_id: '00000000-0000-4000-8000-000000000099',
      pipeline_id: 77,
    });
    // Verify the full 4-call sequence
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /a/dimagi/chatbots/5/copy/',
      'GET /a/dimagi/chatbots/99/',
      'GET /a/dimagi/chatbots/99/edit/',
      'POST /channels/dimagi/chatbots/99/channels/create-dialog/embedded_widget/',
    ]);
  });

  it('throws when the copy POST response has no Location header', async () => {
    const request: RequestFn = async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/5/copy/') {
        return { ok: false, status: 302, headers: {}, text: async () => '', json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request);
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'x' })
    ).rejects.toThrow(/did not return a Location header/);
  });

  it('throws when Location does not match the expected pattern', async () => {
    const request: RequestFn = async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/5/copy/') {
        return {
          ok: false,
          status: 302,
          headers: { location: '/some/unexpected/path' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request);
    await expect(
      backend.cloneChatbot({ template_id: 5, new_name: 'x' })
    ).rejects.toThrow(/Could not parse experiment_id/);
  });
});

// ── Pipeline-patch atoms ─────────────────────────────────────────────

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

  it('attachKnowledge rejects when prompt is missing {collection_index_summaries}', async () => {
    // Mirror the production fixture but strip the required template variable
    // from the LLM node's prompt. attach_knowledge should fail-fast with a
    // typed PipelineValidationError BEFORE attempting any POST — that's the
    // class-level preventer for the silent-rejection bug surfaced in the
    // 0.5.19 dogfood (Iter 6 family).
    const fixture = loadPipelineFixture();
    const stripped = JSON.parse(JSON.stringify(fixture));
    const llmNode = stripped.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.prompt = 'You are a helpful assistant.'; // no token
    let postCalled = false;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => stripped };
      }
      if (method === 'POST') {
        postCalled = true;
        return { ok: true, json: async () => ({ data: stripped.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await expect(
      backend.attachKnowledge({ experiment_id: 99, collection_index_ids: [42] })
    ).rejects.toThrow(/collection_index_summaries/);
    expect(postCalled).toBe(false);
  });

  it('setChatbotPipeline patches prompt + collection_index_ids in a single save', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    await backend.setChatbotPipeline({
      experiment_id: 99,
      prompt: 'New prompt with {collection_index_summaries}',
      collection_index_ids: [42, 43],
      max_results: 10,
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('New prompt with {collection_index_summaries}');
    expect(llm.data.params.collection_index_ids).toEqual([42, 43]);
    expect(llm.data.params.max_results).toBe(10);
  });

  it('setChatbotPipeline rejects when final prompt has {collection_index_summaries} but final collections empty', async () => {
    // Operator changes only the prompt to one with the variable, leaves
    // collections unset → final collections come from existing fixture
    // (which we'll mock as empty).
    const fixture = loadPipelineFixture();
    const stripped = JSON.parse(JSON.stringify(fixture));
    const llmNode = stripped.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.prompt = 'You are a helpful assistant.'; // no token
    llmNode.data.params.collection_index_ids = [];
    let postCalled = false;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => stripped };
      }
      if (method === 'POST') {
        postCalled = true;
        return { ok: true, json: async () => ({ data: stripped.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await expect(
      backend.setChatbotPipeline({
        experiment_id: 99,
        prompt: 'Updated prompt with {collection_index_summaries}',
      })
    ).rejects.toThrow(/collection_index_summaries/);
    expect(postCalled).toBe(false);
  });

  it('setChatbotPipeline accepts variable+empty if collections being added in same call', async () => {
    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const backend = makeBackend(makePipelineRequest((b) => { saved = b as typeof saved; }), seed);
    // The cross-field check looks at the *merged* final state. So passing
    // both prompt and a non-empty collections list together is the canonical
    // unblock for the chicken-and-egg the atom was created to solve.
    await backend.setChatbotPipeline({
      experiment_id: 99,
      prompt: 'New prompt with {collection_index_summaries}',
      collection_index_ids: [365],
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('New prompt with {collection_index_summaries}');
    expect(llm.data.params.collection_index_ids).toEqual([365]);
  });

  it('setChatbotPipeline preserves existing collections when only prompt is changed', async () => {
    // Operator changes only the prompt; existing fixture has [42] attached
    // with the variable in the prompt. Final state: prompt updated, collections
    // unchanged. Cross-field check should pass.
    const fixture = loadPipelineFixture();
    const withCollection = JSON.parse(JSON.stringify(fixture));
    const llmNode = withCollection.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.collection_index_ids = [42];

    let saved: { data: { nodes: Array<{ data: { type: string; params: Record<string, unknown> } }> } } | undefined;
    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => withCollection };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        saved = body as typeof saved;
        return { ok: true, json: async () => ({ data: withCollection.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await backend.setChatbotPipeline({
      experiment_id: 99,
      prompt: 'Reworded prompt with {collection_index_summaries}',
    });
    const llm = saved!.data.nodes.find((n) => n.data.type === 'LLMResponseWithPrompt')!;
    expect(llm.data.params.prompt).toBe('Reworded prompt with {collection_index_summaries}');
    // Collections preserved from existing state — operator didn't pass them.
    expect(llm.data.params.collection_index_ids).toEqual([42]);
  });

  it('attachKnowledge skips the pre-flight when collection_index_ids is empty (detach path)', async () => {
    // Detaching all collections is a legitimate operation (e.g. clearing a
    // wrong-domain shared collection). The token check only matters when at
    // least one collection is being attached.
    const fixture = loadPipelineFixture();
    const stripped = JSON.parse(JSON.stringify(fixture));
    const llmNode = stripped.pipeline.data.nodes.find(
      (n: { data: { type: string } }) => n.data.type === 'LLMResponseWithPrompt'
    );
    llmNode.data.params.prompt = 'You are a helpful assistant.'; // no token
    let saved: unknown;
    const request: RequestFn = async (method, url, body) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => stripped };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        saved = body;
        return { ok: true, json: async () => ({ data: stripped.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request, seed);
    await backend.attachKnowledge({ experiment_id: 99, collection_index_ids: [] });
    expect(saved).toBeDefined();
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

  it('falls back to scraping /a/<team>/chatbots/<id>/edit/ when cache misses', async () => {
    const fixture = loadPipelineFixture();
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/edit/') {
        return {
          ok: true,
          status: 200,
          text: async () => EDIT_HTML_WITH_PIPELINE_ID,
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors: [] }) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    // No seed — backend must resolve experiment→pipeline via the edit-page scrape
    const backend = makeBackend(request);
    await expect(
      backend.setChatbotSystemPrompt({ experiment_id: 99, prompt: 'x' })
    ).resolves.toBeUndefined();
  });
});

// ── Collection atoms ─────────────────────────────────────────────────

describe('PlaywrightBackend collection atoms', () => {
  it('createCollection POSTs form-encoded and parses collection_id from redirect', async () => {
    const request: RequestFn = async (method, url, body, options) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collection/new/') {
        expect(options?.formEncoded).toBe(true);
        expect(options?.followRedirects).toBe(false);
        // is_index is the actual Django form field; llm_provider + embedding_provider_model
        // are required for indexed collections (verified 2026-04-10)
        expect(body).toMatchObject({
          name: 'ACE Malaria',
          summary: 'knowledge base',
          is_index: 'True',
          llm_provider: '378',
          embedding_provider_model: '1',
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/documents/collections/501' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.createCollection({
      name: 'ACE Malaria',
      summary: 'knowledge base',
      is_index: true,
      is_remote_index: false,
      llm_provider: 378,
      embedding_model: 1,
    });
    expect(out.collection_id).toBe(501);
  });

  it('uploadCollectionFiles sends multipart with chunk_size + chunk_overlap and scrapes file IDs', async () => {
    const request: RequestFn = async (method, url, body, options) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collections/501/add_files') {
        // The atom must route through the multipart channel, not the JSON body.
        expect(body).toBeUndefined();
        expect(options?.multipart).toBeDefined();
        expect(options?.followRedirects).toBe(false);
        expect(options!.multipart!.csrfmiddlewaretoken).toBe('csrf-xyz');
        // chunk_size and chunk_overlap are required form fields (added 0.4.6);
        // without them the upload "succeeds" but produces 0 chunks and
        // retrieval silently never works.
        expect(options!.multipart!.chunk_size).toBe('800');
        expect(options!.multipart!.chunk_overlap).toBe('400');
        const fileEntry = options!.multipart!.files_0 as {
          name: string;
          mimeType: string;
          buffer: Buffer;
        };
        expect(fileEntry.name).toBe('idd.pdf');
        expect(fileEntry.mimeType).toBe('application/pdf');
        expect(fileEntry.buffer.toString()).toBe('PDF');
        // OCS returns 302 redirect to the collection home page on success.
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/documents/collections/501' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/documents/collections/501/files/') {
        // The files listing renders each upload as a wrapper div with
        // id="collection_file_<pk>" where pk is the CollectionFile PK (what
        // the status-polling endpoint requires). The anchor's File.id is
        // different and should NOT be used for status polling.
        return {
          ok: true,
          text: async () => `
            <div id="collection_file_34023">
              <a href="/a/dimagi/files/file/9001/">idd.pdf</a>
            </div>
          `,
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.uploadCollectionFiles({
      collection_id: 501,
      files: [{ name: 'idd.pdf', content: Buffer.from('PDF'), mime_type: 'application/pdf' }],
    });
    // Returns CollectionFile IDs (34023), NOT File IDs (9001).
    expect(out.file_ids).toEqual([34023]);
  });

  it('uploadCollectionFiles passes custom chunk_size and chunk_overlap through the multipart', async () => {
    const request: RequestFn = async (method, url, body, options) => {
      if (method === 'POST' && url === '/a/dimagi/documents/collections/501/add_files') {
        expect(options!.multipart!.chunk_size).toBe('1200');
        expect(options!.multipart!.chunk_overlap).toBe('200');
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/documents/collections/501' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/documents/collections/501/files/') {
        return {
          ok: true,
          text: async () => '<div id="collection_file_1"></div>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request);
    await backend.uploadCollectionFiles({
      collection_id: 501,
      files: [{ name: 'x.pdf', content: Buffer.from('X'), mime_type: 'application/pdf' }],
      chunk_size: 1200,
      chunk_overlap: 200,
    });
  });

  it('uploadCollectionFiles throws if chunk_overlap >= chunk_size (Django would reject anyway)', async () => {
    const request: RequestFn = async () => {
      throw new Error('should not be called — validation must fire first');
    };
    const backend = makeBackend(request);
    await expect(
      backend.uploadCollectionFiles({
        collection_id: 501,
        files: [{ name: 'x.pdf', content: Buffer.from('X'), mime_type: 'application/pdf' }],
        chunk_size: 500,
        chunk_overlap: 500,
      }),
    ).rejects.toThrow(/chunk_overlap.*must be < chunk_size/);
  });

  it('waitForCollectionIndexing polls HTMX status partial until chunks appear', async () => {
    let call = 0;
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/501/files/')) {
        call++;
        const chunkCount = call >= 2 ? 5 : 0;
        const tip = chunkCount > 0 ? 'Complete' : 'In Progress';
        const html = `<div data-tip="${tip}"></div>` +
          `<div><span>${chunkCount} chunks</span></div>`;
        return { ok: true, text: async () => html, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.waitForCollectionIndexing({
      collection_id: 501,
      file_ids: [9001],
      timeout_sec: 10,
      _pollIntervalMs: 10,
    });
    expect(out.ready).toBe(true);
    expect(out.files_indexed).toBe(1);
  });

  it('waitForCollectionIndexing throws when file status is Failed', async () => {
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url.startsWith('/a/dimagi/documents/collections/501/files/')) {
        const html = `<div data-tip="Failed"></div><div><span>0 chunks</span></div>`;
        return { ok: true, text: async () => html, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    await expect(
      backend.waitForCollectionIndexing({
        collection_id: 501,
        file_ids: [9001],
        timeout_sec: 10,
        _pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/failed to index/);
  });

  it('waitForCollectionIndexing throws when file_ids is empty', async () => {
    const request: RequestFn = async () => {
      throw new Error('should not be called');
    };
    const backend = makeBackend(request);
    await expect(
      backend.waitForCollectionIndexing({ collection_id: 501, file_ids: [] })
    ).rejects.toThrow(/empty file_ids/);
  });
});

// ── Publish + embed info ─────────────────────────────────────────────

describe('PlaywrightBackend publish + embed info', () => {
  // publishChatbotVersion calls a pre-flight validation via /pipelines/data/
  // before POSTing /versions/create (added 0.4.6). Tests seed the experiment
  // → pipeline cache and mock the pipeline-data GET+POST as a no-error
  // round-trip so the pre-flight passes.
  const publishSeed = new Map<number, number>([[99, 77]]);

  function withPreflight(impl: RequestFn, errors: unknown = []): RequestFn {
    const fixture = loadPipelineFixture();
    return async (method, url, body, options) => {
      if (method === 'GET' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => fixture };
      }
      if (method === 'POST' && url === '/a/dimagi/pipelines/data/77/') {
        return { ok: true, json: async () => ({ data: fixture.pipeline.data, errors }) };
      }
      return impl(method, url, body, options);
    };
  }

  it('publishChatbotVersion pre-flights the pipeline, then POSTs versions/create as form-encoded', async () => {
    const request: RequestFn = withPreflight(async (method, url, body, options) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        expect(options?.formEncoded).toBe(true);
        expect(options?.followRedirects).toBe(false);
        expect(body).toMatchObject({
          version_description: 'initial',
          is_default_version: 'on',
          csrfmiddlewaretoken: 'csrf-xyz',
        });
        return {
          ok: false,
          status: 302,
          headers: { location: '/a/dimagi/chatbots/99/#versions' },
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return {
          ok: true,
          text: async () => '<div>Version 1</div><div>Version 2</div>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const backend = makeBackend(request, publishSeed);
    const out = await backend.publishChatbotVersion({ experiment_id: 99, description: 'initial' });
    expect(out.version_number).toBe(2);
  });

  it('publishChatbotVersion throws when Django re-renders the form (HTTP 200 = validation failure)', async () => {
    const request: RequestFn = withPreflight(async (method, url) => {
      if (method === 'POST' && url === '/a/dimagi/chatbots/99/versions/create') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<form><ul class="errorlist"><li>Version description is required.</li></ul></form>',
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const backend = makeBackend(request, publishSeed);
    await expect(
      backend.publishChatbotVersion({ experiment_id: 99, description: '' }),
    ).rejects.toThrow(/Version publish rejected.*Version description is required/);
  });

  it('publishChatbotVersion throws PipelineValidationError when pre-flight finds node-level errors (catches the 2026-04-19 phantom-collection class upstream)', async () => {
    // Simulates the exact shape that hid the 2026-04-19 silent-publish-block:
    // the /pipelines/data/ save endpoint returns nested `errors.node.<id>.<field>`
    // with the real message, while /versions/create re-renders the form with no
    // errorlist. Pre-flight surfaces this before /versions/create is called.
    const request: RequestFn = withPreflight(async (method, url) => {
      // If /versions/create is reached, the test has failed — pre-flight should
      // have thrown first.
      throw new Error(`pre-flight should have blocked; got unexpected ${method} ${url}`);
    }, {
      node: {
        'LLMResponseWithPrompt-abc': {
          collection_index_ids: 'Collection index(s) with ID(s) 718 not found',
        },
      },
    });
    const backend = makeBackend(request, publishSeed);
    await expect(
      backend.publishChatbotVersion({ experiment_id: 99, description: 'whatever' }),
    ).rejects.toThrow(/Pipeline save rejected.*LLMResponseWithPrompt-abc\.collection_index_ids.*718 not found/);
  });

  it('getChatbotEmbedInfo does a 3-hop scrape (home → edit-dialog → token)', async () => {
    const calls: string[] = [];
    const request: RequestFn = async (method, url) => {
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return {
          ok: true,
          status: 200,
          text: async () => HOME_HTML_WITH_WIDGET,
          json: async () => ({}),
        };
      }
      if (method === 'GET' && url === '/channels/dimagi/chatbots/99/channels/333/edit-dialog/') {
        return {
          ok: true,
          status: 200,
          text: async () => EDIT_DIALOG_HTML_WITH_TOKEN,
          json: async () => ({}),
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };

    const backend = makeBackend(request);
    const out = await backend.getChatbotEmbedInfo({ experiment_id: 99 });
    expect(out.public_id).toBe('00000000-0000-4000-8000-000000000099');
    expect(out.embed_key).toBe('tok-abc123');
    expect(calls).toEqual([
      'GET /a/dimagi/chatbots/99/',
      'GET /channels/dimagi/chatbots/99/channels/333/edit-dialog/',
    ]);
  });

  it('getChatbotEmbedInfo throws with a clear message when no embedded_widget channel is present', async () => {
    const htmlNoChannel = HOME_HTML_WITH_WIDGET.replace(/fa-brands fa-embedded_widget/, 'fa-brands fa-telegram');
    const request: RequestFn = async (method, url) => {
      if (method === 'GET' && url === '/a/dimagi/chatbots/99/') {
        return { ok: true, status: 200, text: async () => htmlNoChannel, json: async () => ({}) };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const backend = makeBackend(request);
    await expect(
      backend.getChatbotEmbedInfo({ experiment_id: 99 })
    ).rejects.toThrow(/No EMBEDDED_WIDGET channel/);
  });
});
