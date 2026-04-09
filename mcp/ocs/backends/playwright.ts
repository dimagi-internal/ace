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
