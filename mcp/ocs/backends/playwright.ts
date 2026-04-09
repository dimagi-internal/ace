import type { RequestFn } from './pipeline-patch.js';
import { patchLlmNodeParams, type PipelinePatchContext } from './pipeline-patch.js';
import type { LlmNodeParams } from '../types.js';

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

    const res = await this.opts.request('GET', `/api/experiments/${experimentId}/`);
    if (!res.ok) throw new Error(`experiment retrieve failed for ${experimentId}`);
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
    const res = await this.opts.request(
      'POST',
      `/a/${this.opts.teamSlug}/documents/collection/new/`,
      {
        name: args.name,
        summary: args.summary,
        is_index: args.is_index,
        is_remote_index: args.is_remote_index,
        llm_provider: args.llm_provider,
        embedding_provider_model: args.embedding_model,
        csrfmiddlewaretoken: this.opts.csrfToken,
      },
    );
    if (!res.ok) throw new Error('createCollection failed');
    const body = (await res.json()) as { collection_id: number };
    return { collection_id: body.collection_id };
  }

  async uploadCollectionFiles(args: {
    collection_id: number;
    files: Array<{ name: string; content: Buffer | string; mime_type: string }>;
  }) {
    const res = await this.opts.request(
      'POST',
      `/a/${this.opts.teamSlug}/documents/collections/${args.collection_id}/add_files`,
      {
        files: args.files,
        csrfmiddlewaretoken: this.opts.csrfToken,
      },
    );
    if (!res.ok) throw new Error('uploadCollectionFiles failed');
    const body = (await res.json()) as { file_ids: number[] };
    return { file_ids: body.file_ids };
  }

  // Internal test seam: _fileIds + _pollIntervalMs. Real callers supply _fileIds from
  // the return value of uploadCollectionFiles and tracked in skill state.
  async waitForCollectionIndexing(args: {
    collection_id: number;
    timeout_sec?: number;
    _fileIds?: number[];
    _pollIntervalMs?: number;
  }) {
    const fileIds = args._fileIds ?? [];
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

    throw new Error(`Collection ${args.collection_id} indexing timed out after ${timeoutSec}s`);
  }

  async cloneChatbot(args: { template_id: number; new_name: string }) {
    const copyUrl = `/a/${this.opts.teamSlug}/chatbots/${args.template_id}/copy/`;
    const copyRes = await this.opts.request('POST', copyUrl, {
      new_name: args.new_name,
      csrfmiddlewaretoken: this.opts.csrfToken,
    });
    if (!copyRes.ok) throw new Error(`clone failed for template ${args.template_id}`);
    const copyBody = (await copyRes.json()) as { experiment_id: number };

    const expUrl = `/api/experiments/${copyBody.experiment_id}/`;
    const expRes = await this.opts.request('GET', expUrl);
    if (!expRes.ok) throw new Error(`experiment fetch failed for ${copyBody.experiment_id}`);
    const exp = (await expRes.json()) as { id: number; public_id: string; pipeline_id: number };

    // Cache the mapping so downstream pipeline-patch atoms don't re-fetch
    this.pipelineCache.set(exp.id, exp.pipeline_id);

    return {
      experiment_id: exp.id,
      public_id: exp.public_id,
      pipeline_id: exp.pipeline_id,
    };
  }
}
