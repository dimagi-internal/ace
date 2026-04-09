import type { RequestFn, RequestResult } from './pipeline-patch.js';
import { patchLlmNodeParams, type PipelinePatchContext } from './pipeline-patch.js';
import type { LlmNodeParams } from '../types.js';
import { CollectionIndexingTimeoutError, HttpError } from '../errors.js';

export function extractWidgetToken(html: string): string | undefined {
  const match = html.match(/data-widget-token="([^"]+)"/);
  return match?.[1];
}

/**
 * Construct an HttpError from a non-ok RequestResult. Tolerates older test
 * fakes that don't populate `status` or `text()`.
 */
async function httpErrorFor(res: RequestResult, path: string): Promise<HttpError> {
  const status = res.status ?? 0;
  let body = '';
  if (res.text) {
    try { body = await res.text(); } catch { /* swallow */ }
  }
  return new HttpError(status, path, body);
}

export interface PlaywrightBackendOptions {
  teamSlug: string;
  baseUrl: string;
  csrfToken: string;
  request: RequestFn;
  /**
   * Optional seed for the experiment_id → pipeline_id cache. Used by unit tests
   * to avoid needing to mock /api/experiments/<id>/ on every pipeline-patch test.
   * In production, the cache is populated lazily by `cloneChatbot` and `pipelineIdFor`.
   */
  pipelineCacheSeed?: Map<number, number>;
}

export class PlaywrightBackend {
  private pipelineCache: Map<number, number>;

  constructor(private opts: PlaywrightBackendOptions) {
    this.pipelineCache = new Map(opts.pipelineCacheSeed ?? []);
  }

  private patchContext(): PipelinePatchContext {
    return { request: this.opts.request, teamSlug: this.opts.teamSlug };
  }

  /**
   * Resolve an experiment_id to the pipeline_id of its working version.
   * Checks cache, then falls back to GET /api/experiments/<id>/.
   * Throws if the experiment retrieve doesn't include a pipeline reference.
   */
  async pipelineIdFor(experimentId: number): Promise<number> {
    const cached = this.pipelineCache.get(experimentId);
    if (cached !== undefined) return cached;

    const path = `/api/experiments/${experimentId}/`;
    const res = await this.opts.request('GET', path);
    if (!res.ok) throw await httpErrorFor(res, path);
    const body = (await res.json()) as { pipeline_id?: number; pipeline?: { id?: number } };
    const pipelineId = body.pipeline_id ?? body.pipeline?.id;
    if (!pipelineId) {
      throw new Error(
        `Experiment ${experimentId} has no pipeline reference in /api/experiments/ response. ` +
          'Spec open verification item #11: confirm pipeline_id is surfaced in the experiment retrieve body.'
      );
    }
    this.pipelineCache.set(experimentId, pipelineId);
    return pipelineId;
  }

  async setChatbotSystemPrompt(args: { experiment_id: number; prompt: string }) {
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, { prompt: args.prompt });
  }

  async attachKnowledge(args: {
    experiment_id: number;
    collection_index_ids: number[];
    max_results?: number;
    generate_citations?: boolean;
  }) {
    const patch: Partial<LlmNodeParams> = { collection_index_ids: args.collection_index_ids };
    if (args.max_results !== undefined) patch.max_results = args.max_results;
    if (args.generate_citations !== undefined) patch.generate_citations = args.generate_citations;
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, patch);
  }

  async setChatbotTools(args: {
    experiment_id: number;
    tools?: string[];
    custom_actions?: string[];
    built_in_tools?: string[];
    mcp_tools?: string[];
  }) {
    const patch: Partial<LlmNodeParams> = {};
    if (args.tools !== undefined) patch.tools = args.tools;
    if (args.custom_actions !== undefined) patch.custom_actions = args.custom_actions;
    if (args.built_in_tools !== undefined) patch.built_in_tools = args.built_in_tools;
    if (args.mcp_tools !== undefined) patch.mcp_tools = args.mcp_tools;
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, patch);
  }

  async setSourceMaterial(args: { experiment_id: number; source_material_id: number | null }) {
    const pipelineId = await this.pipelineIdFor(args.experiment_id);
    await patchLlmNodeParams(this.patchContext(), pipelineId, {
      source_material_id: args.source_material_id,
    });
  }

  async createCollection(args: {
    name: string;
    summary: string;
    is_index: boolean;
    is_remote_index: boolean;
    llm_provider?: number;
    embedding_model?: number;
  }) {
    const path = `/a/${this.opts.teamSlug}/documents/collection/new/`;
    const res = await this.opts.request('POST', path, {
      name: args.name,
      summary: args.summary,
      is_index: args.is_index,
      is_remote_index: args.is_remote_index,
      llm_provider: args.llm_provider,
      embedding_provider_model: args.embedding_model,
      csrfmiddlewaretoken: this.opts.csrfToken,
    });
    if (!res.ok) throw await httpErrorFor(res, path);
    const body = (await res.json()) as { collection_id: number };
    return { collection_id: body.collection_id };
  }

  async uploadCollectionFiles(args: {
    collection_id: number;
    files: Array<{ name: string; content: Buffer | string; mime_type: string }>;
  }) {
    // TODO (spec verification item #13): Django's `add_collection_files` view
    // (apps/documents/views.py:352) parses `request.FILES` which expects real
    // multipart/form-data. The JSON body below will likely fail on first real
    // contact with OCS — needs to be rewired through a multipart-aware path
    // (Playwright's `multipart:` option) once we can verify against OCS dev.
    // The unit test is intentionally loose and does not guard this.
    const path = `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/add_files`;
    const res = await this.opts.request('POST', path, {
      files: args.files,
      csrfmiddlewaretoken: this.opts.csrfToken,
    });
    if (!res.ok) throw await httpErrorFor(res, path);
    const body = (await res.json()) as { file_ids: number[] };
    return { file_ids: body.file_ids };
  }

  // file_ids is now a required caller-supplied list (from uploadCollectionFiles).
  // _pollIntervalMs is retained as an underscore-prefixed test seam only.
  async waitForCollectionIndexing(args: {
    collection_id: number;
    file_ids: number[];
    timeout_sec?: number;
    _pollIntervalMs?: number;
  }) {
    const fileIds = args.file_ids;
    if (!fileIds || fileIds.length === 0) {
      throw new Error(
        `waitForCollectionIndexing called with empty file_ids for collection ${args.collection_id}. ` +
          'Pass the file_ids returned by uploadCollectionFiles.'
      );
    }
    const timeoutSec = args.timeout_sec ?? 300;
    const pollInterval = args._pollIntervalMs ?? 2000;
    const deadline = Date.now() + timeoutSec * 1000;

    while (Date.now() < deadline) {
      let indexed = 0;
      for (const fid of fileIds) {
        const url = `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/files/${fid}/status`;
        const res = await this.opts.request('GET', url);
        if (!res.ok) continue;
        const body = (await res.json()) as { chunk_count?: number };
        if ((body.chunk_count ?? 0) > 0) indexed++;
      }
      if (indexed === fileIds.length) {
        return { ready: true, files_indexed: indexed, pending: 0 };
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new CollectionIndexingTimeoutError(args.collection_id, timeoutSec);
  }

  async cloneChatbot(args: { template_id: number; new_name: string }) {
    const copyUrl = `/a/${this.opts.teamSlug}/chatbots/${args.template_id}/copy/`;
    const copyRes = await this.opts.request('POST', copyUrl, {
      new_name: args.new_name,
      csrfmiddlewaretoken: this.opts.csrfToken,
    });
    if (!copyRes.ok) throw await httpErrorFor(copyRes, copyUrl);
    const copyBody = (await copyRes.json()) as { experiment_id: number };

    const expUrl = `/api/experiments/${copyBody.experiment_id}/`;
    const expRes = await this.opts.request('GET', expUrl);
    if (!expRes.ok) throw await httpErrorFor(expRes, expUrl);
    const exp = (await expRes.json()) as { id: number; public_id: string; pipeline_id: number };

    // Cache the mapping so downstream pipeline-patch atoms don't re-fetch
    this.pipelineCache.set(exp.id, exp.pipeline_id);

    return {
      experiment_id: exp.id,
      public_id: exp.public_id,
      pipeline_id: exp.pipeline_id,
    };
  }

  async publishChatbotVersion(args: { experiment_id: number; description: string }) {
    const path = `/a/${this.opts.teamSlug}/chatbots/${args.experiment_id}/versions/create`;
    const res = await this.opts.request('POST', path, {
      version_description: args.description,
      make_default: true,
      csrfmiddlewaretoken: this.opts.csrfToken,
    });
    if (!res.ok) throw await httpErrorFor(res, path);
    return (await res.json()) as { version_number: number; task_id: string };
  }

  async getChatbotEmbedInfo(args: { experiment_id: number }) {
    // REST half: public_id from /api/experiments/{id}/
    const expPath = `/api/experiments/${args.experiment_id}/`;
    const expRes = await this.opts.request('GET', expPath);
    if (!expRes.ok) throw await httpErrorFor(expRes, expPath);
    const exp = (await expRes.json()) as { public_id: string };

    // Playwright half: scrape widget_token from the channels page HTML
    const chanUrl = `/a/${this.opts.teamSlug}/chatbots/${args.experiment_id}/channels/`;
    const chanRes = await this.opts.request('GET', chanUrl);
    if (!chanRes.ok) throw await httpErrorFor(chanRes, chanUrl);
    const chanBody = (await chanRes.json()) as { html: string };
    const embedKey = extractWidgetToken(chanBody.html);
    if (!embedKey) {
      throw new Error(
        `No EMBEDDED_WIDGET channel found for experiment ${args.experiment_id}. ` +
          'Verify clone channel copy behavior — see spec open verification item #1.'
      );
    }

    return { public_id: exp.public_id, embed_key: embedKey };
  }
}
